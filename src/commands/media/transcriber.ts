/**
 * The local speech-to-text program `tg media transcribe` runs: found on
 * PATH or named in config.json, never bundled or downloaded. Audio goes
 * through ffmpeg to 16 kHz mono WAV first, so every runner reads one format.
 */
import { accessSync, constants, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import type { TranscribeConfigFile } from '../../config'
import { ErrorCodes } from '../../types'
import { MediaError } from './errors'

/** Searched on PATH, in this order, when transcribe.command isn't set */
export const RUNNER_NAMES = [
  'whisper-cli',
  'mlx_whisper',
  'whisper-ctranslate2',
  'whisper',
] as const

/**
 * whisper.cpp writes `<input>.json` with `transcription` segments; the
 * openai-whisper-compatible CLIs write `<stem>.json` with `text`
 */
export type RunnerShape = 'whisper.cpp' | 'openai-whisper'

export interface Runner {
  /** The program's name, without .exe */
  name: string
  path: string
  shape: RunnerShape
  /** What the runner is given: a name, or for whisper.cpp a model file */
  model: string
  /** What is stored and printed: the model file's name for whisper.cpp, not its path */
  modelName: string
}

/** Below this peak the audio is digital silence, which Whisper fills with invented phrases */
export const SILENCE_MAX_VOLUME_DB = -60

const DEFAULT_MODELS: Record<string, string> = {
  mlx_whisper: 'mlx-community/whisper-large-v3-turbo',
}
const DEFAULT_MODEL = 'large-v3-turbo'

function programName(path: string): string {
  return basename(path).replace(/\.exe$/i, '')
}

export type FindResult =
  | { runner: Runner; ffmpeg: string }
  | {
      missing: true
      searched: string[]
      runner: string | null
      ffmpeg: string | null
    }

/** The whisper.cpp model the errors suggest: large-v3-turbo, quantized */
export const WHISPER_CPP_MODEL = {
  file: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  size: '574 MB',
}

/** A path as a shell argument */
function shellArg(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", "'\\''")}'`
}

function downloadCommand(file: string): string {
  return `curl -L --create-dirs -o ${shellArg(file)} ${WHISPER_CPP_MODEL.url}`
}

/** Download the model to `file` and point transcribe.model at it */
function modelCommands(file: string): string {
  return `download the ${WHISPER_CPP_MODEL.size} model and point tg at it: ${downloadCommand(file)} && tg config set transcribe.model ${shellArg(file)}`
}

/** Where the suggested whisper.cpp model goes: <dataDir>/models */
export function defaultModelPath(dataDir: string): string {
  return join(dataDir, 'models', WHISPER_CPP_MODEL.file)
}

function readable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The runner and ffmpeg. INVALID_ARGS (thrown as MediaError) when the
 * runner is whisper.cpp and transcribe.model names no readable model file.
 */
export function findTranscriber(
  config: TranscribeConfigFile,
  dataDir: string,
  which: (name: string) => string | null = (name) => Bun.which(name),
): FindResult {
  const searched = config.command ? [config.command] : [...RUNNER_NAMES]
  let path: string | null = null
  for (const name of searched) {
    path = which(name)
    if (path) break
  }
  const ffmpeg = which('ffmpeg')
  if (!path || !ffmpeg) {
    return { missing: true, searched, runner: path, ffmpeg }
  }

  const name = programName(path)
  const shape: RunnerShape = name.startsWith('whisper-cli')
    ? 'whisper.cpp'
    : 'openai-whisper'
  if (shape === 'whisper.cpp') {
    const model = config.model
    if (!model) {
      throw new MediaError(
        ErrorCodes.INVALID_ARGS,
        'whisper.cpp needs a model file: transcribe.model is not set',
        { runner: path, model: null },
        `Run whisper.cpp with a model: ${modelCommands(defaultModelPath(dataDir))}`,
      )
    }
    if (!readable(model)) {
      throw new MediaError(
        ErrorCodes.INVALID_ARGS,
        `whisper.cpp model file not found or not readable: ${model}`,
        { runner: path, model },
        `Download the ${WHISPER_CPP_MODEL.size} model to that path: ${downloadCommand(model)}`,
      )
    }
    return {
      runner: { name, path, shape, model, modelName: basename(model) },
      ffmpeg,
    }
  }
  const model = config.model ?? DEFAULT_MODELS[name] ?? DEFAULT_MODEL
  return { runner: { name, path, shape, model, modelName: model }, ffmpeg }
}

/** Install commands for this OS, for the error when something is missing */
export function installSuggestion(
  missing: { runner: boolean; ffmpeg: boolean },
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === 'win32') {
    return [
      missing.runner &&
        'Install a runner, which downloads its own model on first use: uv tool install whisper-ctranslate2',
      missing.ffmpeg && 'Install ffmpeg and put it on PATH',
    ]
      .filter(Boolean)
      .join('. ')
  }
  if (!missing.runner) return 'brew install ffmpeg'
  const whisperCpp = `Install whisper.cpp: brew install whisper-cpp ffmpeg, then ${modelCommands(defaultModelPath(dataDir))}`
  if (platform === 'darwin' && arch === 'arm64') {
    return `${whisperCpp}. Or, faster on Apple Silicon and downloading its own model on first use: uv tool install mlx-whisper${missing.ffmpeg ? ' && brew install ffmpeg' : ''}`
  }
  return whisperCpp
}

export interface Converted {
  wav: string
  /** Peak level in dB; -Infinity for all-zero audio */
  maxVolumeDb: number
}

/** The last lines of a program's stderr, for an error's details */
function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n').slice(-2000)
}

/**
 * Convert to 16 kHz mono WAV and read the peak level in the same pass.
 * Telegram's voice notes are OGG/Opus and video notes MP4, which
 * whisper.cpp can't read.
 */
export async function convertToWav(
  ffmpeg: string,
  input: string,
  wav: string,
): Promise<Converted> {
  const proc = Bun.spawn(
    [
      ffmpeg,
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-af',
      'volumedetect',
      wav,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' },
  )
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const peak = stderr.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/)
  if (exitCode !== 0 || !peak) {
    throw new MediaError(
      ErrorCodes.GENERAL_ERROR,
      'ffmpeg could not convert the audio',
      { program: ffmpeg, exitCode, stderr: tail(stderr) },
    )
  }
  return {
    wav,
    maxVolumeDb: peak[1] === '-inf' ? -Infinity : Number(peak[1]),
  }
}

export interface Transcript {
  text: string
  language: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** openai-whisper, mlx_whisper, whisper-ctranslate2: `{ text, segments, language }` */
export function parseOpenAiWhisperJson(json: unknown): Transcript {
  if (!isRecord(json) || typeof json.text !== 'string') {
    throw new Error('expected an object with a text string')
  }
  return {
    text: json.text.trim(),
    language: typeof json.language === 'string' ? json.language : null,
  }
}

/** whisper.cpp (`-oj`): `{ result: { language }, transcription: [{ text }] }` */
export function parseWhisperCppJson(json: unknown): Transcript {
  if (!isRecord(json) || !Array.isArray(json.transcription)) {
    throw new Error('expected an object with a transcription array')
  }
  const text = json.transcription
    .map((segment) =>
      isRecord(segment) && typeof segment.text === 'string' ? segment.text : '',
    )
    .join('')
    .trim()
  const language = isRecord(json.result) ? json.result.language : undefined
  return { text, language: typeof language === 'string' ? language : null }
}

function runnerArgs(
  runner: Runner,
  wavs: string[],
  outDir: string,
  language: string | null,
): string[] {
  if (runner.shape === 'whisper.cpp') {
    // whisper.cpp assumes English unless told to detect
    return [
      runner.path,
      '-m',
      runner.model,
      '-l',
      language ?? 'auto',
      '-oj',
      '-np',
      ...wavs,
    ]
  }
  return [
    runner.path,
    ...wavs,
    '--model',
    runner.model,
    '-o',
    outDir,
    '-f',
    'json',
    '--verbose',
    'False',
    ...(language ? ['--language', language] : []),
  ]
}

function outputPath(runner: Runner, wav: string, outDir: string): string {
  return runner.shape === 'whisper.cpp'
    ? `${wav}.json`
    : join(outDir, `${basename(wav, '.wav')}.json`)
}

/**
 * Run the runner over the WAV files, loading the model once, and read each
 * one's transcript. A file it produced no readable output for is a
 * MediaError in its place; the others still count.
 */
export async function runTranscriber(
  runner: Runner,
  wavs: string[],
  outDir: string,
  language: string | null,
): Promise<Array<Transcript | MediaError>> {
  // mlx_whisper writes every result of one run under the first file's name
  const batches = runner.name === 'mlx_whisper' ? wavs.map((w) => [w]) : [wavs]
  const results: Array<Transcript | MediaError> = []
  for (const batch of batches) {
    const proc = Bun.spawn(runnerArgs(runner, batch, outDir, language), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    for (const wav of batch) {
      const file = Bun.file(outputPath(runner, wav, outDir))
      try {
        const json: unknown = await file.json()
        results.push(
          runner.shape === 'whisper.cpp'
            ? parseWhisperCppJson(json)
            : parseOpenAiWhisperJson(json),
        )
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        results.push(
          new MediaError(
            ErrorCodes.GENERAL_ERROR,
            `${runner.name} produced no transcript: ${reason}`,
            { runner: runner.path, exitCode, stderr: tail(stderr) },
          ),
        )
      }
    }
  }
  return results
}
