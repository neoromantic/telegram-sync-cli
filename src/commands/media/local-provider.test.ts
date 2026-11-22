import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultModelPath,
  installSuggestion,
  openLocalProvider,
  parseOpenAiWhisperJson,
  parseWhisperCppJson,
} from "./local-provider";

const MODEL = "/cache/whisper-cli/ggml-large-v3-turbo-q5_0.bin";

const WHISPER_CPP_OUTPUT = {
  systeminfo: "WHISPER : COREML = 0 | MTL : EMBED_LIBRARY = 1 | ",
  model: { type: "large", multilingual: true, vocab: 51866, mels: 128 },
  params: {
    model: "/models/ggml-large-v3-turbo-q5_0.bin",
    language: "auto",
    translate: false,
  },
  result: { language: "ru" },
  transcription: [
    {
      timestamps: { from: "00:00:00,000", to: "00:00:03,680" },
      offsets: { from: 0, to: 3680 },
      text: " Я уже вышел из дома, буду у метро минут через десять.",
    },
  ],
};

const MLX_WHISPER_OUTPUT = {
  text: " Я уже вышел из дома, буду у метро минут через 10.",
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0.0,
      end: 3.5,
      text: " Я уже вышел из дома, буду у метро минут через 10.",
      tokens: [50365, 4857, 50540],
      temperature: 0,
      avg_logprob: -0.14581296179029676,
      compression_ratio: 1.0632911392405062,
      no_speech_prob: 5.983544822812936e-12,
    },
  ],
  language: "ru",
};

const OPENAI_WHISPER_SILENCE = {
  text: " Thank you.",
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0.0,
      end: 29.98,
      text: " Thank you.",
      tokens: [50365, 1044, 291, 13, 51864],
      temperature: 0.0,
      avg_logprob: -0.24721811215082803,
      compression_ratio: 0.5555555555555556,
      no_speech_prob: 1.1042883274470228e-10,
    },
  ],
  language: "en",
};

describe("parseWhisperCppJson", () => {
  it("joins the segments and reads the detected language", () => {
    expect(parseWhisperCppJson(WHISPER_CPP_OUTPUT)).toEqual({
      text: "Я уже вышел из дома, буду у метро минут через десять.",
      language: "ru",
    });
    expect(
      parseWhisperCppJson({
        transcription: [{ text: " One." }, { text: " Two." }],
      }),
    ).toEqual({ text: "One. Two.", language: null });
  });

  it("rejects output without a transcription array", () => {
    expect(() => parseWhisperCppJson({ transcription: [{ text: "part" }, {}] })).toThrow(
      "each segment",
    );
    expect(() => parseWhisperCppJson(MLX_WHISPER_OUTPUT)).toThrow("transcription array");
  });
});

describe("parseOpenAiWhisperJson", () => {
  it("reads text and language", () => {
    expect(parseOpenAiWhisperJson(MLX_WHISPER_OUTPUT)).toEqual({
      text: "Я уже вышел из дома, буду у метро минут через 10.",
      language: "ru",
    });
    expect(parseOpenAiWhisperJson(OPENAI_WHISPER_SILENCE).text).toBe("Thank you.");
  });

  it("rejects output without a text string", () => {
    expect(() => parseOpenAiWhisperJson(WHISPER_CPP_OUTPUT)).toThrow("text string");
    expect(() => parseOpenAiWhisperJson(null)).toThrow();
  });
});

describe("openLocalProvider", () => {
  const on =
    (...found: string[]) =>
    (name: string) =>
      found.includes(name) ? `/bin/${name}` : null;

  function open(config: object, which: (name: string) => string | null) {
    const setup = openLocalProvider(config, MODEL, which);
    return setup.ready
      ? { declaration: setup.provider.declaration, ffmpeg: setup.ffmpeg }
      : { problem: setup.problem };
  }

  it("takes the first program on PATH, with its default model, and declares it local and free", () => {
    expect(open({}, on("whisper", "mlx_whisper", "ffmpeg"))).toEqual({
      declaration: {
        id: "local",
        engine: "mlx_whisper",
        model: "mlx-community/whisper-large-v3-turbo",
        sendsTo: null,
        cost: "free",
        input: { kind: "audio", formats: ["wav16k"] },
        batchSize: 1,
        concurrency: 1,
        maxDurationSeconds: null,
      },
      ffmpeg: "/bin/ffmpeg",
    });
    expect(open({ model: "small" }, on("whisper", "ffmpeg"))).toMatchObject({
      declaration: {
        engine: "whisper",
        model: "small",
        batchSize: Number.POSITIVE_INFINITY,
      },
    });
  });

  it("reports what is missing", () => {
    expect(open({}, on("whisper"))).toMatchObject({
      problem: {
        code: "TRANSCRIBER_NOT_FOUND",
        message: "No ffmpeg found on PATH",
        details: {
          searched: ["whisper-cli", "mlx_whisper", "whisper-ctranslate2", "whisper"],
          runnerPath: "/bin/whisper",
          ffmpeg: null,
        },
      },
    });
    expect(open({}, on())).toMatchObject({
      problem: {
        message: "No speech-to-text program and no ffmpeg found on PATH",
      },
    });
    expect(open({ command: "my-whisper" }, on("whisper", "ffmpeg"))).toMatchObject({
      problem: { details: { searched: ["my-whisper"], runnerPath: null } },
    });
  });

  it("runs whisper.cpp only with a model file that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-transcriber-test-"));
    try {
      const model = join(dir, "ggml-example.bin");
      const which = on("whisper-cli", "ffmpeg");
      expect(open({}, which)).toMatchObject({
        problem: {
          code: "TRANSCRIBER_NOT_FOUND",
          message: "whisper.cpp needs a model file: transcribe.local.model is not set",
        },
      });
      expect(open({ model }, which)).toMatchObject({
        problem: {
          message: expect.stringContaining("not found or not readable"),
        },
      });
      writeFileSync(model, "x");
      expect(open({ model }, which)).toMatchObject({
        declaration: { engine: "whisper-cli", model: "ggml-example.bin" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installSuggestion", () => {
  const both = { runner: true, ffmpeg: true };

  it("names whisper.cpp, its model and the config command", () => {
    expect(installSuggestion(both, MODEL, "linux", "x64")).toBe(
      `Install whisper.cpp: brew install whisper-cpp ffmpeg, then download the 574 MB model and point tg at it: curl -L --create-dirs -o ${MODEL} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin && tg config set transcribe.local.model ${MODEL}`,
    );
  });

  it("adds mlx-whisper on Apple Silicon", () => {
    expect(installSuggestion(both, MODEL, "darwin", "arm64")).toEndWith(
      ". Or, faster on Apple Silicon and downloading its own model on first use: uv tool install mlx-whisper && brew install ffmpeg",
    );
  });

  it("names whisper-ctranslate2 on Windows, and ffmpeg alone when only it is missing", () => {
    expect(installSuggestion(both, MODEL, "win32", "x64")).toBe(
      "Install a runner, which downloads its own model on first use: uv tool install whisper-ctranslate2. Install ffmpeg and put it on PATH",
    );
    expect(installSuggestion({ runner: false, ffmpeg: true }, MODEL, "linux", "x64")).toBe(
      "brew install ffmpeg",
    );
  });

  it("quotes a model path with a space", () => {
    expect(installSuggestion(both, defaultModelPath("/my cache"), "linux", "x64")).toContain(
      "-o '/my cache/whisper-cli/ggml-large-v3-turbo-q5_0.bin'",
    );
  });
});
