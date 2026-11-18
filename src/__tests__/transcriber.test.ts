/**
 * The runner tg media transcribe finds, and the two JSON shapes it reads.
 * The fixtures are real output of each program for made-up clips, with long
 * fields (systeminfo, tokens) shortened.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  findTranscriber,
  installSuggestion,
  parseOpenAiWhisperJson,
  parseWhisperCppJson,
} from '../commands/media/transcriber'

const DATA_DIR = '/data/tg'

/** whisper-cli 1.9.5 -l auto -oj, large-v3-turbo-q5_0 */
const WHISPER_CPP_OUTPUT = {
  systeminfo: 'WHISPER : COREML = 0 | MTL : EMBED_LIBRARY = 1 | ',
  model: { type: 'large', multilingual: true, vocab: 51866, mels: 128 },
  params: {
    model: '/models/ggml-large-v3-turbo-q5_0.bin',
    language: 'auto',
    translate: false,
  },
  result: { language: 'ru' },
  transcription: [
    {
      timestamps: { from: '00:00:00,000', to: '00:00:03,680' },
      offsets: { from: 0, to: 3680 },
      text: ' Я уже вышел из дома, буду у метро минут через десять.',
    },
  ],
}

/** mlx_whisper 0.4.3 -f json, whisper-large-v3-turbo */
const MLX_WHISPER_OUTPUT = {
  text: ' Я уже вышел из дома, буду у метро минут через 10.',
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0.0,
      end: 3.5,
      text: ' Я уже вышел из дома, буду у метро минут через 10.',
      tokens: [50365, 4857, 50540],
      temperature: 0,
      avg_logprob: -0.14581296179029676,
      compression_ratio: 1.0632911392405062,
      no_speech_prob: 5.983544822812936e-12,
    },
  ],
  language: 'ru',
}

/** openai-whisper --output_format json, large-v3-turbo, on 10 s of digital silence */
const OPENAI_WHISPER_SILENCE = {
  text: ' Thank you.',
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0.0,
      end: 29.98,
      text: ' Thank you.',
      tokens: [50365, 1044, 291, 13, 51864],
      temperature: 0.0,
      avg_logprob: -0.24721811215082803,
      compression_ratio: 0.5555555555555556,
      no_speech_prob: 1.1042883274470228e-10,
    },
  ],
  language: 'en',
}

describe('parseWhisperCppJson', () => {
  it('joins the segments and reads the detected language', () => {
    expect(parseWhisperCppJson(WHISPER_CPP_OUTPUT)).toEqual({
      text: 'Я уже вышел из дома, буду у метро минут через десять.',
      language: 'ru',
    })
    expect(
      parseWhisperCppJson({
        transcription: [{ text: ' One.' }, { text: ' Two.' }],
      }),
    ).toEqual({ text: 'One. Two.', language: null })
  })

  it('rejects output without a transcription array', () => {
    expect(() => parseWhisperCppJson(MLX_WHISPER_OUTPUT)).toThrow(
      'transcription array',
    )
  })
})

describe('parseOpenAiWhisperJson', () => {
  it('reads text and language', () => {
    expect(parseOpenAiWhisperJson(MLX_WHISPER_OUTPUT)).toEqual({
      text: 'Я уже вышел из дома, буду у метро минут через 10.',
      language: 'ru',
    })
    // What the silence check exists for: no_speech_prob doesn't flag it
    expect(parseOpenAiWhisperJson(OPENAI_WHISPER_SILENCE).text).toBe(
      'Thank you.',
    )
  })

  it('rejects output without a text string', () => {
    expect(() => parseOpenAiWhisperJson(WHISPER_CPP_OUTPUT)).toThrow(
      'text string',
    )
    expect(() => parseOpenAiWhisperJson(null)).toThrow()
  })
})

describe('findTranscriber', () => {
  const on =
    (...found: string[]) =>
    (name: string) =>
      found.includes(name) ? `/bin/${name}` : null

  it('takes the first runner on PATH, with its default model', () => {
    expect(
      findTranscriber({}, DATA_DIR, on('whisper', 'mlx_whisper', 'ffmpeg')),
    ).toEqual({
      runner: {
        name: 'mlx_whisper',
        path: '/bin/mlx_whisper',
        shape: 'openai-whisper',
        model: 'mlx-community/whisper-large-v3-turbo',
        modelName: 'mlx-community/whisper-large-v3-turbo',
      },
      ffmpeg: '/bin/ffmpeg',
    })
    expect(
      findTranscriber({ model: 'small' }, DATA_DIR, on('whisper', 'ffmpeg')),
    ).toMatchObject({ runner: { name: 'whisper', model: 'small' } })
  })

  it('reports what is missing', () => {
    expect(findTranscriber({}, DATA_DIR, on('whisper'))).toEqual({
      missing: true,
      searched: [
        'whisper-cli',
        'mlx_whisper',
        'whisper-ctranslate2',
        'whisper',
      ],
      runner: '/bin/whisper',
      ffmpeg: null,
    })
    expect(
      findTranscriber(
        { command: 'my-whisper' },
        DATA_DIR,
        on('whisper', 'ffmpeg'),
      ),
    ).toMatchObject({ missing: true, searched: ['my-whisper'], runner: null })
  })

  it('runs whisper.cpp only with a model file that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-transcriber-test-'))
    try {
      const model = join(dir, 'ggml-example.bin')
      const which = on('whisper-cli', 'ffmpeg')
      expect(() => findTranscriber({}, DATA_DIR, which)).toThrow(
        'whisper.cpp needs a model file',
      )
      expect(() => findTranscriber({ model }, DATA_DIR, which)).toThrow(
        'not found or not readable',
      )
      writeFileSync(model, 'x')
      expect(findTranscriber({ model }, DATA_DIR, which)).toMatchObject({
        runner: { shape: 'whisper.cpp', model, modelName: 'ggml-example.bin' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('installSuggestion', () => {
  const both = { runner: true, ffmpeg: true }
  const model = '/data/tg/models/ggml-large-v3-turbo-q5_0.bin'

  it('names whisper.cpp, its model and the config command', () => {
    expect(installSuggestion(both, DATA_DIR, 'linux', 'x64')).toBe(
      `Install whisper.cpp: brew install whisper-cpp ffmpeg, then download the 574 MB model and point tg at it: curl -L --create-dirs -o ${model} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin && tg config set transcribe.model ${model}`,
    )
  })

  it('adds mlx-whisper on Apple Silicon', () => {
    expect(installSuggestion(both, DATA_DIR, 'darwin', 'arm64')).toEndWith(
      '. Or, faster on Apple Silicon and downloading its own model on first use: uv tool install mlx-whisper && brew install ffmpeg',
    )
  })

  it('names whisper-ctranslate2 on Windows, and ffmpeg alone when only it is missing', () => {
    expect(installSuggestion(both, DATA_DIR, 'win32', 'x64')).toBe(
      'Install a runner, which downloads its own model on first use: uv tool install whisper-ctranslate2. Install ffmpeg and put it on PATH',
    )
    expect(
      installSuggestion(
        { runner: false, ffmpeg: true },
        DATA_DIR,
        'linux',
        'x64',
      ),
    ).toBe('brew install ffmpeg')
  })

  it('quotes a data directory with a space', () => {
    expect(installSuggestion(both, '/data/my tg', 'linux', 'x64')).toContain(
      "-o '/data/my tg/models/ggml-large-v3-turbo-q5_0.bin'",
    )
  })
})
