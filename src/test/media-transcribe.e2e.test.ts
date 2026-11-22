import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { documentMessage } from "./media-messages.test-utils";
import { photoMessage } from "./photo-message.test-utils";
import { defaultModelPath, installSuggestion } from "../commands/media/local-provider";
import { parseRawMessage } from "../daemon/sync-worker-real-helpers";
import { createChatProtectionStore } from "../db/chat-protection";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import { extractAttachment } from "../utils/attachment";
import { mediaPaths } from "../utils/media-cache";
import { NO_CREDENTIALS, runCli, spawnCli } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const SELF_ID = 5_550_001;
const PEER_ID = 5_550_002;
const MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin";
const self = { _: "peerUser" as const, userId: SELF_ID };

const FAKE_FFMPEG = `#!/bin/sh
echo "ffmpeg $*" >> "$FAKE_LOG"
prev=""
for a in "$@"; do [ "$prev" = "-i" ] && in="$a"; prev="$a"; out="$a"; done
cp "$in" "$out"
if grep -q SILENT "$in"; then peak=-91.0; else peak=-2.3; fi
echo "[Parsed_volumedetect_0 @ 0x0] max_volume: $peak dB" >&2
`;

const FAKE_OPENAI_RUNNER = `#!/bin/sh
echo "$(basename "$0") $*" >> "$FAKE_LOG"
out=.; lang=en; files=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2;;
    --language) lang="$2"; shift 2;;
    --model|-f|--verbose) shift 2;;
    *) files="$files $1"; shift;;
  esac
done
for f in $files; do
  printf '{"text": " %s", "segments": [], "language": "%s"}' "$(cat "$f")" "$lang" > "$out/$(basename "$f" .wav).json"
done
`;

const FAKE_WHISPER_CPP = `#!/bin/sh
echo "whisper-cli $*" >> "$FAKE_LOG"
lang=auto
while [ $# -gt 0 ]; do
  case "$1" in
    -m) shift 2;;
    -l) lang="$2"; shift 2;;
    -oj|-np) shift;;
    *) [ "$lang" = auto ] && found=en || found="$lang"
       printf '{"result": {"language": "%s"}, "transcription": [{"text": " %s"}, {"text": " (fake)"}]}' "$found" "$(cat "$1")" > "$1.json"
       shift;;
  esac
done
`;

interface Result {
  chatId: number;
  messageId: number;
  text: string;
  language: string | null;
  source: string;
  model: string | null;
  cached: boolean;
}

describe("E2E: media transcribe", () => {
  let env: TestEnvironment;
  let binDir: string;
  let toolsDir: string;
  let logPath: string;
  let mediaDir: string;
  let cacheHome: string;

  beforeEach(() => {
    env = createTestEnvironment("media-transcribe");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    env.openCacheDb(1);
    mediaDir = join(env.dataDir, "accounts", "1", "media");
    binDir = join(env.dataDir, "bin");
    mkdirSync(binDir);
    toolsDir = join(env.dataDir, "tools");
    mkdirSync(toolsDir);
    for (const tool of ["basename", "cat", "cp", "grep"]) {
      symlinkSync(Bun.which(tool)!, join(toolsDir, tool));
    }
    logPath = join(env.dataDir, "calls.log");
    writeFileSync(logPath, "");
    cacheHome = join(env.dataDir, "cache");
  });

  afterEach(() => {
    env.cleanup();
  });

  function install(name: string, script: string) {
    const path = join(binDir, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  function killIfRunning(pid: number) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }

  async function processStopped(pid: number) {
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0);
        if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8")))
          return true;
      } catch (err) {
        if (["ESRCH", "ENOENT"].includes((err as NodeJS.ErrnoException).code ?? "")) return true;
        throw err;
      }
      await Bun.sleep(25);
    }
    return false;
  }

  function runnerCalls() {
    return readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("ffmpeg "));
  }

  function note(
    id: number,
    content: string,
    options: {
      round?: boolean;
      peer?: number;
      fileId?: string;
      extra?: object;
      file?: boolean;
    } = {},
  ) {
    const size = Buffer.byteLength(content);
    const chatId = options.peer ?? SELF_ID;
    const raw = documentMessage(
      { _: "peerUser", userId: chatId },
      id,
      {
        id: options.fileId ?? `60000000000000001${String(id).padStart(2, "0")}`,
        mimeType: options.round ? "video/mp4" : "audio/ogg",
        size,
        thumbs: [],
        attributes: [
          options.round
            ? {
                _: "documentAttributeVideo",
                roundMessage: true,
                duration: 5,
                w: 384,
                h: 384,
              }
            : { _: "documentAttributeAudio", voice: true, duration: 5 },
        ],
      },
      options.extra as Record<string, unknown>,
    );
    createMessagesCache(env.openCacheDb(1)).upsert(parseRawMessage(raw, chatId)!);
    if (options.file === false) return;
    const { file } = mediaPaths(mediaDir, extractAttachment(raw)!);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }

  function writeConfig(transcribe: Record<string, string>) {
    writeFileSync(
      join(env.dataDir, "config.json"),
      JSON.stringify({ transcribe: { local: transcribe } }),
    );
  }

  async function tg(args: string[], extraEnv: Record<string, string> = {}) {
    return runCli(args, {
      env: {
        ...env.getCliOptions().env,
        ...NO_CREDENTIALS,
        PATH: `${binDir}:${toolsDir}`,
        XDG_CACHE_HOME: cacheHome,
        FAKE_LOG: logPath,
        ...extraEnv,
      },
    });
  }

  async function transcribe(...args: string[]) {
    return tg(["media", "transcribe", "--chat", "me", ...args]);
  }

  async function readerTranscripts(chat: string, highId: number) {
    const chatId = chat === "me" ? SELF_ID : Number(chat);
    createHistoryRanges(env.openCacheDb(1)).add(chatId, { low: 1, high: highId });
    type Item = { transcript: { text: string } | null };
    const get = await tg(["messages", "get", "--chat", chat, "--id", "1"]);
    const list = await tg(["messages", "list", "--chat", chat]);
    const texts = (items: Item[]) => items.map((item) => item.transcript?.text ?? null);
    return {
      get: texts([(get.json as { data: { message: Item } }).data.message]),
      list: texts((list.json as { data: { items: Item[] } }).data.items),
    };
  }

  function lines(stdout: string) {
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("transcribes a voice note, stores it and shows it in tg messages get", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Meet me at the harbor at eight.");

    const result = await transcribe("--id", "1");

    expect(result.exitCode).toBe(0);
    expect(result.json).toEqual({
      success: true,
      data: {
        chatId: SELF_ID,
        messageId: 1,
        text: "Meet me at the harbor at eight.",
        language: "en",
        source: "local",
        runner: "whisper",
        model: "large-v3-turbo",
        cached: false,
      },
    });
    const [call] = runnerCalls();
    expect(call).toMatch(
      /^whisper \S+\/0\.wav --model large-v3-turbo -o \S+ -f json --verbose False$/,
    );

    createHistoryRanges(env.openCacheDb(1)).add(SELF_ID, { low: 1, high: 1 });
    const get = await tg(["messages", "get", "--chat", "me", "--id", "1"]);
    expect(get.exitCode).toBe(0);
    const { message } = (get.json as { data: { message: object } }).data;
    expect(message).toMatchObject({
      messageId: 1,
      attachment: { kind: "voice" },
      transcript: {
        text: "Meet me at the harbor at eight.",
        language: "en",
        source: "local",
        model: "large-v3-turbo",
      },
    });
  });

  it("searches visible speech once per message, including snippets, counts and pages", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Harbor lantern.");
    note(2, "Harbor bell.", { extra: { message: "Harbor caption." } });
    await transcribe("--id", "1", "--id", "2");
    const search = async (...args: string[]) => {
      const response = await tg([
        "messages",
        "search",
        "--query",
        "harbor",
        "--snippet",
        "--count",
        "--limit",
        "1",
        ...args,
      ]);
      expect(response.exitCode).toBe(0);
      return (
        response.json as {
          data: {
            count: number;
            results: { messageId: number; transcriptMatch?: boolean; snippet: string }[];
          };
        }
      ).data;
    };
    env.seedAccounts([{ phone: "+15550000002", user_id: SELF_ID + 2 }]);
    expect((await search("--account", "2")).count).toBe(0);
    const first = await search();
    const next = await search("--offset", "1");
    expect(first.count).toBe(2);
    expect(new Set([...first.results, ...next.results].map((row) => row.messageId))).toEqual(
      new Set([1, 2]),
    );
    expect(first.results[0]).toMatchObject({
      transcriptMatch: true,
      snippet: expect.stringContaining("**Harbor**"),
    });
    expect((await search("--sort", "relevance", "--type", "voice")).count).toBe(2);
    note(1, "Another sound.");
    await transcribe("--id", "1", "--force");
    expect((await search()).count).toBe(1);
    note(2, "Harbor bell.", { extra: { message: "Harbor caption.", noforwards: true } });
    const caption = await search();
    expect(caption.count).toBe(1);
    expect(caption.results[0]?.transcriptMatch).toBeUndefined();
    note(2, "New file.", { fileId: "6000000000000099999" });
    expect((await search()).count).toBe(0);
  });

  it("answers a second run from the stored transcript, and --force runs again", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Bring the umbrella.");

    await transcribe("--id", "1");
    const again = await transcribe("--id", "1");
    expect((again.json as { data: Result }).data).toMatchObject({
      text: "Bring the umbrella.",
      cached: true,
    });
    expect(runnerCalls()).toHaveLength(1);

    const forced = await transcribe("--id", "1", "--force", "--language", "de");
    expect((forced.json as { data: Result }).data).toMatchObject({
      language: "de",
      cached: false,
    });
    expect(runnerCalls()).toHaveLength(2);
    expect(runnerCalls()[1]).toEndWith("--language de");
  });

  it("reuses the transcript of the same file in another message", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Forward this to the team.", { fileId: "6000000000000000177" });
    note(2, "Forward this to the team.", { fileId: "6000000000000000177" });

    await transcribe("--id", "1");
    const copy = await transcribe("--id", "2");

    expect((copy.json as { data: Result }).data).toMatchObject({
      messageId: 2,
      text: "Forward this to the team.",
      cached: true,
    });
    expect(runnerCalls()).toHaveLength(1);
  });

  it("runs the runner once for several IDs, one line each in --id order", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper-ctranslate2", FAKE_OPENAI_RUNNER);
    note(1, "First note.");
    note(2, "A round video.", { round: true });
    createMessagesCache(env.openCacheDb(1)).upsert(
      parseRawMessage(photoMessage(self, 3), SELF_ID)!,
    );
    note(4, "Last note.");

    const result = await transcribe("--id", "4", "--id", "2", "--id=3", "--id", "1");

    expect(result.exitCode).toBe(1);
    expect(lines(result.stdout)).toEqual([
      {
        success: true,
        data: expect.objectContaining({ messageId: 4, text: "Last note." }),
      },
      {
        success: true,
        data: expect.objectContaining({ messageId: 2, text: "A round video." }),
      },
      {
        success: false,
        error: expect.objectContaining({
          code: "MEDIA_UNSUPPORTED",
          details: {
            chatId: SELF_ID,
            messageId: 3,
            kind: "photo",
            reason: "not_speech",
          },
          retryable: false,
        }),
      },
      {
        success: true,
        data: expect.objectContaining({ messageId: 1, text: "First note." }),
      },
    ]);
    expect(result.stderr).toContain("Transcribed 3 of 4 messages, 1 failed");
    const calls = runnerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^whisper-ctranslate2 \S+\/0\.wav \S+\/1\.wav \S+\/2\.wav /);
  });

  it("runs mlx_whisper once per file, with its MLX model", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("mlx_whisper", FAKE_OPENAI_RUNNER);
    note(1, "One.");
    note(2, "Two.");

    const result = await transcribe("--id", "1", "--id", "2");

    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout).map((line) => line.data.text)).toEqual(["One.", "Two."]);
    expect(lines(result.stdout)[0].data.model).toBe("mlx-community/whisper-large-v3-turbo");
    expect(runnerCalls()).toHaveLength(2);
  });

  it("runs whisper.cpp with the model file and language detection", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper-cli", FAKE_WHISPER_CPP);
    install("whisper", FAKE_OPENAI_RUNNER);
    const model = join(env.dataDir, "ggml-example.bin");
    writeFileSync(model, "not a real model");
    writeConfig({ model });
    note(1, "Privet.");
    note(2, "Hello.");

    const result = await transcribe("--id", "1", "--id", "2");

    expect(lines(result.stdout)).toEqual([
      {
        success: true,
        data: {
          chatId: SELF_ID,
          messageId: 1,
          text: "Privet. (fake)",
          language: "en",
          source: "local",
          runner: "whisper-cli",
          model: "ggml-example.bin",
          cached: false,
        },
      },
      {
        success: true,
        data: expect.objectContaining({ messageId: 2, text: "Hello. (fake)" }),
      },
    ]);
    const calls = runnerCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toStartWith(`whisper-cli -m ${model} -l auto -oj -np `);
  });

  it("refuses whisper.cpp without a model, with the download and config commands", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper-cli", FAKE_WHISPER_CPP);
    note(1, "Hello.");

    const result = await transcribe("--id", "1");

    const model = join(cacheHome, "whisper-cli", "ggml-large-v3-turbo-q5_0.bin");
    expect(result.exitCode).toBe(1);
    expect(result.json).toEqual({
      success: false,
      error: {
        code: "TRANSCRIBER_NOT_FOUND",
        message: "whisper.cpp needs a model file: transcribe.local.model is not set",
        details: {
          chatId: SELF_ID,
          messageId: 1,
          runnerPath: join(binDir, "whisper-cli"),
          model: null,
        },
        suggestion: `Run whisper.cpp with a model: download the 574 MB model and point tg at it: curl -L --create-dirs -o ${model} ${MODEL_URL} && tg config set transcribe.local.model ${model}`,
        retryable: false,
      },
    });
    expect(runnerCalls()).toEqual([]);
  });

  it("names a configured model file that is missing, with the download command", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper-cli", FAKE_WHISPER_CPP);
    const model = join(env.dataDir, "gone", "ggml-example.bin");
    writeConfig({ model });
    note(1, "Hello.");

    const result = await transcribe("--id", "1");

    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({
      error: {
        code: "INVALID_ARGS",
        message: `whisper.cpp model file not found or not readable: ${model}`,
        details: { model },
        suggestion: `Download the 574 MB model to that path: curl -L --create-dirs -o ${model} ${MODEL_URL}`,
      },
    });
  });

  for (const output of ["no JSON", "parseable JSON"] as const) {
    it(`reports a runner that exited 2 after writing ${output} with its exit code and stderr`, async () => {
      install("ffmpeg", FAKE_FFMPEG);
      install(
        "whisper",
        `${output === "no JSON" ? "#!/bin/sh\n" : FAKE_OPENAI_RUNNER}echo "loading model" >&2\necho "RuntimeError: out of memory" >&2\nexit 2\n`,
      );
      note(1, "Hello.");

      const result = await transcribe("--id", "1");

      const json = result.json as { error: { message: string } };
      expect(result.exitCode).toBe(1);
      expect(json).toMatchObject({
        success: false,
        error: {
          code: "GENERAL_ERROR",
          details: {
            chatId: SELF_ID,
            messageId: 1,
            runnerPath: join(binDir, "whisper"),
            exitCode: 2,
            stderr: "loading model\nRuntimeError: out of memory",
          },
        },
      });
      expect(json.error.message).toStartWith("whisper produced no transcript");
      expect(env.openCacheDb(1).query("SELECT 1 FROM message_transcripts").get()).toBeNull();
    });
  }

  it("removes the converted audio when the whole run fails", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Hello.");
    note(2, "Not downloaded yet.", { file: false });
    const tmp = join(env.dataDir, "tmp");
    mkdirSync(tmp);

    const result = await tg(["media", "transcribe", "--chat", "me", "--id", "1", "--id", "2"], {
      TMPDIR: tmp,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({ success: false });
    expect(readFileSync(logPath, "utf-8")).toContain("ffmpeg ");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("stores silent audio as empty without calling the runner", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "SILENT");

    const result = await transcribe("--id", "1");

    expect(result.json).toEqual({
      success: true,
      data: {
        chatId: SELF_ID,
        messageId: 1,
        text: "",
        language: null,
        source: "local",
        runner: null,
        model: null,
        cached: false,
      },
    });
    expect(runnerCalls()).toEqual([]);
    const row = env.openCacheDb(1).query("SELECT text, runner FROM message_transcripts").get();
    expect(row).toEqual({ text: "", runner: null });
  });

  it("reports a missing runner with the install and model commands for this OS", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    note(1, "Hello.");

    const result = await transcribe("--id", "1");

    expect(result.exitCode).toBe(1);
    expect(result.json).toEqual({
      success: false,
      error: {
        code: "TRANSCRIBER_NOT_FOUND",
        message: "No speech-to-text program found on PATH",
        details: {
          chatId: SELF_ID,
          messageId: 1,
          searched: ["whisper-cli", "mlx_whisper", "whisper-ctranslate2", "whisper"],
          runnerPath: null,
          ffmpeg: join(binDir, "ffmpeg"),
        },
        suggestion: installSuggestion({ runner: true, ffmpeg: false }, defaultModelPath(cacheHome)),
        retryable: false,
      },
    });
    if (process.platform !== "win32") {
      const model = join(cacheHome, "whisper-cli", "ggml-large-v3-turbo-q5_0.bin");
      expect((result.json as { error: { suggestion: string } }).error.suggestion).toStartWith(
        `Install whisper.cpp: brew install whisper-cpp ffmpeg, then download the 574 MB model and point tg at it: curl -L --create-dirs -o ${model} ${MODEL_URL} && tg config set transcribe.local.model ${model}`,
      );
    }
  });

  it("reports missing ffmpeg with its install command", async () => {
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Hello.");

    const result = await transcribe("--id", "1");

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      error: {
        code: "TRANSCRIBER_NOT_FOUND",
        message: "No ffmpeg found on PATH",
        details: { runnerPath: join(binDir, "whisper"), ffmpeg: null },
        suggestion:
          process.platform === "win32"
            ? "Install ffmpeg and put it on PATH"
            : "brew install ffmpeg",
      },
    });
  });

  it("looks for transcribe.local.command instead of the list", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    writeConfig({ command: "example-whisper" });
    note(1, "Hello.");

    const result = await transcribe("--id", "1");

    expect(result.json).toMatchObject({
      error: {
        code: "TRANSCRIBER_NOT_FOUND",
        details: { searched: ["example-whisper"] },
      },
    });
  });

  it("refuses a content-protected message as tg media download does", async () => {
    install("ffmpeg", FAKE_FFMPEG);
    install("whisper", FAKE_OPENAI_RUNNER);
    note(1, "Secret.", { extra: { noforwards: true } });

    const result = await transcribe("--id", "1");
    const download = await tg(["media", "download", "--chat", "me", "--id", "1"]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: "CONTENT_PROTECTED",
        details: { chatId: SELF_ID, messageId: 1, reason: "message" },
      },
    });
    expect(download.json).toMatchObject({ error: { code: "CONTENT_PROTECTED" } });
    expect(result.json).toMatchObject({
      error: {
        code: "CONTENT_PROTECTED",
        suggestion: expect.stringContaining("tg media download"),
      },
    });
    expect(readFileSync(logPath, "utf-8")).toBe("");
    expect(env.openCacheDb(1).query("SELECT 1 FROM message_transcripts").get()).toBeNull();
  });

  describe("regressions found in review", () => {
    it("transcribes again when the message's attachment changed", async () => {
      install("ffmpeg", FAKE_FFMPEG);
      install("whisper", FAKE_OPENAI_RUNNER);
      note(1, "Old words.", { fileId: "6000000000000000201" });
      await transcribe("--id", "1");

      note(1, "New words.", { fileId: "6000000000000000202" });
      createHistoryRanges(env.openCacheDb(1)).add(SELF_ID, { low: 1, high: 1 });
      const get = await tg(["messages", "get", "--chat", "me", "--id", "1"]);
      expect(get.json).toMatchObject({
        data: { message: { messageId: 1, transcript: null } },
      });
      const result = await transcribe("--id", "1");

      expect(result.exitCode).toBe(0);
      expect((result.json as { data: Result }).data).toMatchObject({
        text: "New words.",
        cached: false,
      });
      expect(runnerCalls()).toHaveLength(2);
    });

    const interrupts = [
      { stage: "ffmpeg", signals: ["SIGTERM"] },
      { stage: "whisper", signals: ["SIGTERM"] },
      { stage: "whisper", signals: ["SIGHUP"] },
      { stage: "whisper", signals: ["SIGINT", "SIGINT"] },
    ] as const;
    for (const { stage, signals } of interrupts) {
      it(`removes the temporary audio and stops ${stage} on ${signals.join(" then ")}, exit 130`, async () => {
        const pidFile = join(env.dataDir, "child.pid");
        const sleepPidFile = join(env.dataDir, "sleep.pid");
        const stoppedFile = join(env.dataDir, "child.stopped");
        const stubborn = signals.length > 1;
        const hang = stubborn
          ? `#!/bin/sh\ntrap 'echo stopped > "${stoppedFile}"' TERM\nsleep 30 &\necho $! > "${sleepPidFile}"\necho $$ > "${pidFile}"\nwait $!\nwait $!\n`
          : `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`;
        install("ffmpeg", stage === "ffmpeg" ? hang : FAKE_FFMPEG);
        install("whisper", stage === "whisper" ? hang : FAKE_OPENAI_RUNNER);
        symlinkSync(Bun.which("sleep")!, join(toolsDir, "sleep"));
        note(1, "Hello.");
        const tmp = join(env.dataDir, "tmp");
        mkdirSync(tmp);
        const written = (file: string) => existsSync(file) && readFileSync(file, "utf-8") !== "";
        const whenWritten = (file: string) => {
          const watcher = watch(env.dataDir);
          return new Promise<void>((resolve) => {
            const check = () => {
              if (!written(file)) return;
              watcher.close();
              resolve();
            };
            watcher.on("change", check);
            check();
          });
        };
        const started = whenWritten(pidFile);

        const proc = spawnCli(["media", "transcribe", "--chat", "me", "--id", "1"], {
          env: {
            ...env.getCliOptions().env,
            ...NO_CREDENTIALS,
            PATH: `${binDir}:${toolsDir}`,
            XDG_CACHE_HOME: cacheHome,
            FAKE_LOG: logPath,
            TMPDIR: tmp,
          },
        });
        await started;
        const childPid = Number(readFileSync(pidFile, "utf-8").trim());
        expect(readdirSync(tmp)).not.toEqual([]);

        try {
          const stopped = whenWritten(stoppedFile);
          proc.kill(signals[0]);
          if (stubborn) {
            await stopped;
            proc.kill(signals[1]!);
          }
          const exitCode = await proc.exited;

          expect(exitCode).toBe(130);
          expect(readdirSync(tmp)).toEqual([]);
          expect(await processStopped(childPid)).toBe(true);
          if (stubborn)
            expect(await processStopped(Number(readFileSync(sleepPidFile, "utf-8")))).toBe(true);
          expect(env.openCacheDb(1).query("SELECT 1 FROM message_transcripts").get()).toBeNull();
        } finally {
          if (stubborn) {
            for (const pid of [childPid, Number(readFileSync(sleepPidFile, "utf-8"))]) {
              killIfRunning(pid);
            }
          }
        }
      });
    }

    it("prints the ready results of a batch when the program is missing for the rest, uncached ones included", async () => {
      install("ffmpeg", FAKE_FFMPEG);
      install("whisper", FAKE_OPENAI_RUNNER);
      note(1, "Already done.");
      await transcribe("--id", "1");
      rmSync(join(binDir, "whisper"));
      note(2, "Still waiting.");

      const result = await transcribe("--id", "1", "--id", "2", "--id", "3");

      expect(result.exitCode).toBe(1);
      expect(lines(result.stdout)).toEqual([
        {
          success: true,
          data: expect.objectContaining({
            messageId: 1,
            text: "Already done.",
            cached: true,
          }),
        },
        {
          success: false,
          error: expect.objectContaining({
            code: "TRANSCRIBER_NOT_FOUND",
            details: expect.objectContaining({ chatId: SELF_ID, messageId: 2 }),
          }),
        },
        {
          success: false,
          error: expect.objectContaining({
            code: "TRANSCRIBER_NOT_FOUND",
            details: expect.objectContaining({ chatId: SELF_ID, messageId: 3 }),
          }),
        },
      ]);
    });

    it("refuses a stored transcript once the message is content-protected", async () => {
      install("ffmpeg", FAKE_FFMPEG);
      install("whisper", FAKE_OPENAI_RUNNER);
      note(1, "Was public.", { fileId: "6000000000000000301" });
      await transcribe("--id", "1");
      note(1, "Was public.", {
        fileId: "6000000000000000301",
        extra: { noforwards: true },
      });
      note(2, "Was public.", {
        fileId: "6000000000000000301",
        extra: { noforwards: true },
      });

      const byMessage = await transcribe("--id", "1");
      const byFile = await transcribe("--id", "2");
      const download = await tg(["media", "download", "--chat", "me", "--id", "1"]);

      expect(byMessage.exitCode).toBe(1);
      expect(download.json).toMatchObject({ error: { code: "CONTENT_PROTECTED" } });
      expect(byMessage.json).toMatchObject({
        error: {
          code: "CONTENT_PROTECTED",
          suggestion: expect.stringContaining("tg media download"),
        },
      });
      expect(byFile.json).toMatchObject({
        success: false,
        error: {
          code: "CONTENT_PROTECTED",
          details: { chatId: SELF_ID, messageId: 2, reason: "message" },
        },
      });
      expect(runnerCalls()).toHaveLength(1);
      expect(await readerTranscripts("me", 2)).toEqual({ get: [null], list: [null, null] });
    });

    it("refuses a stored transcript and hides it from tg messages once its chat is content-protected", async () => {
      install("ffmpeg", FAKE_FFMPEG);
      install("whisper", FAKE_OPENAI_RUNNER);
      const db = env.openCacheDb(1);
      createUsersCache(db).upsert({
        user_id: String(PEER_ID),
        first_name: "Example",
        last_name: "Person",
        access_hash: "1111",
        fetched_at: Date.now(),
        raw_json: "{}",
      });
      note(1, "Said before protection.", { peer: PEER_ID });
      const chat = String(PEER_ID);
      await tg(["media", "transcribe", "--chat", chat, "--id", "1"]);
      expect(await readerTranscripts(chat, 1)).toEqual({
        get: ["Said before protection."],
        list: ["Said before protection."],
      });

      createChatProtectionStore(db).record(
        PEER_ID,
        { protected: true, reason: "private_chat" },
        Date.now(),
      );
      const again = await tg(["media", "transcribe", "--chat", chat, "--id", "1"]);

      expect(again.json).toMatchObject({
        success: false,
        error: {
          code: "CONTENT_PROTECTED",
          details: { chatId: PEER_ID, messageId: 1, reason: "private_chat" },
        },
      });
      expect(runnerCalls()).toHaveLength(1);
      expect(await readerTranscripts(chat, 1)).toEqual({ get: [null], list: [null] });
    });
  });
});
