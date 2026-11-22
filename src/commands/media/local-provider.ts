import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { TranscribeConfigFile } from "../../config";
import { ErrorCodes } from "../../types";
import { tail } from "./audio";
import { MediaError } from "./errors";
import type {
  ProviderResult,
  ProviderSetup,
  TranscriptionProvider,
} from "./transcription-provider";

const RUNNER_NAMES = ["whisper-cli", "mlx_whisper", "whisper-ctranslate2", "whisper"] as const;

type RunnerShape = "whisper.cpp" | "openai-whisper";

interface Runner {
  name: string;
  path: string;
  shape: RunnerShape;
  model: string;
  modelName: string;
}

const DEFAULT_MODELS: Record<string, string> = {
  mlx_whisper: "mlx-community/whisper-large-v3-turbo",
};
const DEFAULT_MODEL = "large-v3-turbo";

function programName(path: string) {
  return basename(path).replace(/\.exe$/i, "");
}

type FindResult =
  | { runner: Runner; ffmpeg: string }
  | {
      missing: true;
      searched: string[];
      runner: string | null;
      ffmpeg: string | null;
    }
  | { invalid: MediaError };

const WHISPER_CPP_MODEL = {
  file: "ggml-large-v3-turbo-q5_0.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
  size: "574 MB",
};

function shellArg(path: string) {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`;
}

function downloadCommand(file: string) {
  return `curl -L --create-dirs -o ${shellArg(file)} ${WHISPER_CPP_MODEL.url}`;
}

function modelCommands(file: string) {
  return `download the ${WHISPER_CPP_MODEL.size} model and point tg at it: ${downloadCommand(file)} && tg config set transcribe.model ${shellArg(file)}`;
}

/**
 * Where the suggested whisper.cpp model goes: the user's cache directory,
 * not tg's data directory, because other programs can use the same file
 */
export function defaultModelPath(
  cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
) {
  return join(cacheHome, "whisper-cli", WHISPER_CPP_MODEL.file);
}

function readable(path: string) {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findTranscriber(
  config: TranscribeConfigFile,
  suggestedModel: string,
  which: (name: string) => string | null = (name) => Bun.which(name),
) {
  const searched = config.command ? [config.command] : [...RUNNER_NAMES];
  let path: string | null = null;
  for (const name of searched) {
    path = which(name);
    if (path) break;
  }
  const ffmpeg = which("ffmpeg");
  if (!path || !ffmpeg) {
    return { missing: true, searched, runner: path, ffmpeg } satisfies FindResult;
  }

  const name = programName(path);
  const shape: RunnerShape = name.startsWith("whisper-cli") ? "whisper.cpp" : "openai-whisper";
  if (shape === "whisper.cpp") {
    const model = config.model;
    if (!model) {
      return {
        invalid: new MediaError(
          ErrorCodes.INVALID_ARGS,
          "whisper.cpp needs a model file: transcribe.model is not set",
          { runner: path, model: null },
          `Run whisper.cpp with a model: ${modelCommands(suggestedModel)}`,
        ),
      } satisfies FindResult;
    }
    if (!readable(model)) {
      return {
        invalid: new MediaError(
          ErrorCodes.INVALID_ARGS,
          `whisper.cpp model file not found or not readable: ${model}`,
          { runner: path, model },
          `Download the ${WHISPER_CPP_MODEL.size} model to that path: ${downloadCommand(model)}`,
        ),
      } satisfies FindResult;
    }
    return {
      runner: { name, path, shape, model, modelName: basename(model) },
      ffmpeg,
    } satisfies FindResult;
  }
  const model = config.model ?? DEFAULT_MODELS[name] ?? DEFAULT_MODEL;
  return { runner: { name, path, shape, model, modelName: model }, ffmpeg } satisfies FindResult;
}

/** Install commands for this OS, for the error when something is missing */
export function installSuggestion(
  missing: { runner: boolean; ffmpeg: boolean },
  suggestedModel: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
) {
  if (platform === "win32") {
    return [
      missing.runner &&
        "Install a runner, which downloads its own model on first use: uv tool install whisper-ctranslate2",
      missing.ffmpeg && "Install ffmpeg and put it on PATH",
    ]
      .filter(Boolean)
      .join(". ");
  }
  if (!missing.runner) return "brew install ffmpeg";
  const whisperCpp = `Install whisper.cpp: brew install whisper-cpp ffmpeg, then ${modelCommands(suggestedModel)}`;
  if (platform === "darwin" && arch === "arm64") {
    return `${whisperCpp}. Or, faster on Apple Silicon and downloading its own model on first use: uv tool install mlx-whisper${missing.ffmpeg ? " && brew install ffmpeg" : ""}`;
  }
  return whisperCpp;
}

interface Transcript {
  text: string;
  language: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** openai-whisper, mlx_whisper, whisper-ctranslate2: `{ text, segments, language }` */
export function parseOpenAiWhisperJson(json: unknown) {
  if (!isRecord(json) || typeof json.text !== "string") {
    throw new Error("expected an object with a text string");
  }
  return {
    text: json.text.trim(),
    language: typeof json.language === "string" ? json.language : null,
  } satisfies Transcript;
}

/** whisper.cpp (`-oj`): `{ result: { language }, transcription: [{ text }] }` */
export function parseWhisperCppJson(json: unknown) {
  if (!isRecord(json) || !Array.isArray(json.transcription)) {
    throw new Error("expected an object with a transcription array");
  }
  const text = json.transcription
    .map((segment) => (isRecord(segment) && typeof segment.text === "string" ? segment.text : ""))
    .join("")
    .trim();
  const language = isRecord(json.result) ? json.result.language : undefined;
  return { text, language: typeof language === "string" ? language : null } satisfies Transcript;
}

function runnerArgs(runner: Runner, wavs: string[], outDir: string, language: string | null) {
  if (runner.shape === "whisper.cpp") {
    return [runner.path, "-m", runner.model, "-l", language ?? "auto", "-oj", "-np", ...wavs];
  }
  return [
    runner.path,
    ...wavs,
    "--model",
    runner.model,
    "-o",
    outDir,
    "-f",
    "json",
    "--verbose",
    "False",
    ...(language ? ["--language", language] : []),
  ];
}

function outputPath(runner: Runner, wav: string, outDir: string) {
  return runner.shape === "whisper.cpp"
    ? `${wav}.json`
    : join(outDir, `${basename(wav, ".wav")}.json`);
}

async function runProgram(
  runner: Runner,
  wavs: string[],
  language: string | null,
  signal: AbortSignal,
) {
  const outDir = dirname(wavs[0]!);
  const proc = Bun.spawn(runnerArgs(runner, wavs, outDir, language), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    signal,
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  signal.throwIfAborted();
  const results: ProviderResult[] = [];
  for (const wav of wavs) {
    const file = Bun.file(outputPath(runner, wav, outDir));
    try {
      if (exitCode !== 0) throw new Error(`exited with code ${exitCode}`);
      const json: unknown = await file.json();
      const transcript =
        runner.shape === "whisper.cpp" ? parseWhisperCppJson(json) : parseOpenAiWhisperJson(json);
      results.push({ status: "done", ...transcript, model: runner.modelName });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({
        status: "failed",
        failure: "rejected",
        error: new MediaError(
          ErrorCodes.GENERAL_ERROR,
          `${runner.name} produced no transcript: ${reason}`,
          { runner: runner.path, exitCode, stderr: tail(stderr) },
        ),
      });
    }
  }
  return results;
}

function localProvider(runner: Runner) {
  return {
    declaration: {
      id: "local",
      engine: runner.name,
      model: runner.modelName,
      sendsTo: null,
      cost: "free",
      input: { kind: "audio", formats: ["wav16k"] },
      batchSize: runner.name === "mlx_whisper" ? 1 : Number.POSITIVE_INFINITY,
      concurrency: 1,
      maxDurationSeconds: null,
    },
    transcribe(requests, { language, signal }) {
      const wavs = requests.map((request) => {
        if (request.audio?.format !== "wav16k") {
          throw new Error("The local provider reads 16 kHz WAV only");
        }
        return request.audio.path;
      });
      return runProgram(runner, wavs, language, signal);
    },
  } satisfies TranscriptionProvider;
}

function notFound(found: Extract<FindResult, { missing: true }>, suggestedModel: string) {
  const what = [
    !found.runner && "No speech-to-text program",
    !found.ffmpeg && (found.runner ? "No ffmpeg" : "no ffmpeg"),
  ]
    .filter(Boolean)
    .join(" and ");
  return new MediaError(
    ErrorCodes.TRANSCRIBER_NOT_FOUND,
    `${what} found on PATH`,
    { searched: found.searched, runner: found.runner, ffmpeg: found.ffmpeg },
    installSuggestion({ runner: !found.runner, ffmpeg: !found.ffmpeg }, suggestedModel),
  );
}

/**
 * The local provider for transcribe.command, or the first program on PATH,
 * with ffmpeg for its WAV input; otherwise the problem and its fix
 */
export function openLocalProvider(
  config: TranscribeConfigFile,
  suggestedModel = defaultModelPath(),
  which: (name: string) => string | null = (name) => Bun.which(name),
) {
  const found: FindResult = findTranscriber(config, suggestedModel, which);
  if ("invalid" in found) return { ready: false, problem: found.invalid } satisfies ProviderSetup;
  if ("missing" in found) {
    return { ready: false, problem: notFound(found, suggestedModel) } satisfies ProviderSetup;
  }
  return {
    ready: true,
    provider: localProvider(found.runner),
    ffmpeg: found.ffmpeg,
  } satisfies ProviderSetup;
}
