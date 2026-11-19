import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { documentMessage, pdfDocumentMessage } from "./media-messages.test-utils";
import { fakeBytes, photoMessage } from "./photo-message.test-utils";
import { parseRawMessage } from "../daemon/sync-worker-real-helpers";
import { createChatProtectionStore } from "../db/chat-protection";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import { extractAttachment, pickThumb } from "../utils/attachment";
import { mediaPaths, thumbPaths } from "../utils/media-cache";
import { NO_CREDENTIALS, runCli, runCliSuccess, spawnCli } from "./cli.test-utils";
import {
  FAKE_MEDIA_CALL,
  FAKE_MEDIA_CLI,
  FAKE_MEDIA_ENV,
  type FakeMediaFile,
  type FakeMediaScenario,
  mediaBytes,
  mediaMessage,
} from "./fake-media-cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const SELF_ID = 5_550_001;
const OTHER_CHAT_ID = 5_550_002;
const DAY = 24 * 60 * 60 * 1000;

interface CleanResult {
  success: boolean;
  data: {
    accountId: number;
    removedFiles: number;
    removedPartialFiles: number;
    freedBytes: number;
    keptFiles: number;
    sharedFiles: number;
    filters: { all: boolean; olderThan: string | null; chat: number | null };
  };
}

describe("E2E: media clean", () => {
  let env: TestEnvironment;
  let mediaDir: string;

  beforeEach(() => {
    env = createTestEnvironment("media-clean");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    env.openCacheDb(1);
    mediaDir = join(env.dataDir, "accounts", "1", "media");
  });

  afterEach(() => {
    env.cleanup();
  });

  function place(folder: string, name: string, size: number, ageMs = 0) {
    const path = join(mediaDir, folder, name);
    mkdirSync(join(mediaDir, folder), { recursive: true });
    writeFileSync(path, Buffer.alloc(size, 1));
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
    return path;
  }

  async function clean(args: string[] = []) {
    const result = await runCliSuccess(["media", "clean", ...args], {
      env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
    });
    return (result.json as CleanResult).data;
  }

  it("bare: keeps complete files and removes stale partial downloads", async () => {
    const file = place("AgADexample1", "report.pdf", 10, 90 * DAY);
    const stale = place("AgADexample2", ".video.mp4.part", 6, 2 * DAY);
    const fresh = place("AgADexample3", ".big.zip.part", 4, 60_000);

    expect(await clean()).toEqual({
      accountId: 1,
      removedFiles: 0,
      removedPartialFiles: 1,
      freedBytes: 6,
      keptFiles: 1,
      sharedFiles: 0,
      filters: { all: false, olderThan: null, chat: null },
    });
    expect(existsSync(file)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("reports nothing removed for an account without a media cache", async () => {
    const data = await clean(["--all"]);
    expect(data).toMatchObject({ removedFiles: 0, freedBytes: 0 });
    expect(existsSync(mediaDir)).toBe(false);
  });

  it("--older-than removes files not used since then", async () => {
    const old = place("AgADexample1", "old.pdf", 10, 3 * DAY);
    const recent = place("AgADexample2", "new.pdf", 5, 60_000);

    const data = await clean(["--older-than", "1d"]);
    expect(data).toMatchObject({
      removedFiles: 1,
      freedBytes: 10,
      keptFiles: 1,
    });
    expect(Date.parse(data.filters.olderThan!)).toBeLessThan(Date.now() - DAY + 60_000);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("--all removes every file and partial download", async () => {
    place("AgADexample1", "a.pdf", 10);
    place("AgADexample1", "thumb-m.jpg", 3);
    place("AgADexample2", ".b.zip.part", 4, 60_000);

    expect(await clean(["--all"])).toMatchObject({
      removedFiles: 2,
      removedPartialFiles: 1,
      freedBytes: 17,
      keptFiles: 0,
    });
    expect(readdirSync(mediaDir)).toEqual([]);
  });

  it("--chat removes a chat's files and keeps one another chat holds", async () => {
    const self = { _: "peerUser" as const, userId: SELF_ID };
    const photo = photoMessage(self, 1);
    const pdf = pdfDocumentMessage(self, 2);
    const forwarded = photoMessage({ _: "peerUser", userId: OTHER_CHAT_ID }, 7);
    createMessagesCache(env.openCacheDb(1)).upsertBatch([
      parseRawMessage(photo, SELF_ID)!,
      parseRawMessage(pdf, SELF_ID)!,
      parseRawMessage(forwarded, OTHER_CHAT_ID)!,
    ]);
    const photoId = extractAttachment(photo)!.uniqueFileId;
    const pdfId = extractAttachment(pdf)!.uniqueFileId;
    const sharedPhoto = place(photoId, "photo.jpg", 60);
    const pdfFile = place(pdfId, "example-report.pdf", 12);
    const unrelated = place("AgADunrelated", "other.bin", 5);

    expect(await clean(["--chat", "me"])).toEqual({
      accountId: 1,
      removedFiles: 1,
      removedPartialFiles: 0,
      freedBytes: 12,
      keptFiles: 2,
      sharedFiles: 1,
      filters: { all: false, olderThan: null, chat: SELF_ID },
    });
    expect(existsSync(pdfFile)).toBe(false);
    expect(existsSync(sharedPhoto)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("refuses --all with --chat or --older-than", async () => {
    for (const args of [
      ["--all", "--chat", "me"],
      ["--all", "--older-than", "7d"],
    ]) {
      const result = await runCli(["media", "clean", ...args], {
        env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
      });
      expect(result.exitCode).toBe(3);
      expect(result.json).toMatchObject({
        success: false,
        error: { code: "INVALID_ARGS" },
      });
    }
  });

  it("refuses an --older-than that is no duration, date or time", async () => {
    const result = await runCli(["media", "clean", "--older-than", "nonsense"], {
      env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
    });
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({
      success: false,
      error: { code: "INVALID_ARGS", details: { older_than: "nonsense" } },
    });
  });
});

interface DownloadOutput {
  success: boolean;
  data: {
    path: string;
    cachePath: string;
    fileName: string;
    mimeType: string | null;
    size: number;
    kind: string;
    chatId: number;
    messageId: number;
    uniqueFileId: string;
    groupedId: string | null;
    cached: boolean;
    resumedFrom: number | null;
    thumb: { type: string; width: number; height: number } | null;
  };
}

describe("E2E: media download", () => {
  const ALICE_ID = 5_550_003;
  const PHOTO_SIZE = 60_000;
  let env: TestEnvironment;
  let mediaDir: string;
  let offline: { env: Record<string, string | undefined> };

  beforeEach(() => {
    env = createTestEnvironment("media-download");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    env.openCacheDb(1);
    mediaDir = join(env.dataDir, "accounts", "1", "media");
    offline = { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } };
  });

  afterEach(() => {
    env.cleanup();
  });

  function cache(chatId: number, raw: unknown) {
    createMessagesCache(env.openCacheDb(1)).upsert(parseRawMessage(raw, chatId)!);
  }

  function cachedPhoto(id = 1, extra: Record<string, unknown> = {}) {
    const photo = {
      ...photoMessage({ _: "peerUser", userId: SELF_ID }, id),
      ...extra,
    };
    cache(SELF_ID, photo);
    const { file } = mediaPaths(mediaDir, extractAttachment(photo)!);
    mkdirSync(join(file, ".."), { recursive: true });
    const bytes = fakeBytes(PHOTO_SIZE, 3);
    writeFileSync(file, bytes);
    return { photo, file, bytes };
  }

  async function download(args: string[]) {
    const result = await runCliSuccess(["media", "download", ...args], offline);
    return result.json as DownloadOutput;
  }

  it("serves a cached file without network or credentials", async () => {
    const { photo, file } = cachedPhoto();

    const output = await download(["--chat", "me", "--id", "1"]);

    expect(output).toEqual({
      success: true,
      data: {
        path: file,
        cachePath: file,
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        size: PHOTO_SIZE,
        kind: "photo",
        chatId: SELF_ID,
        messageId: 1,
        uniqueFileId: extractAttachment(photo)!.uniqueFileId,
        groupedId: null,
        cached: true,
        resumedFrom: null,
        thumb: null,
      },
    });
  });

  it("reports NO_MEDIA for a cached message without a file", async () => {
    cache(SELF_ID, {
      _: "message",
      id: 3,
      peerId: { _: "peerUser", userId: SELF_ID },
      date: 1_760_000_003,
      message: "Just text",
    });

    const result = await runCli(["media", "download", "--chat", "me", "--id", "3"], offline);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: "NO_MEDIA",
        details: { chatId: SELF_ID, messageId: 3, messageType: "text" },
      },
    });
  });

  it("needs credentials for a file the cache lacks", async () => {
    const result = await runCli(["media", "download", "--chat", "me", "--id", "42"], offline);
    expect(result.exitCode).toBe(3);
    expect(result.json).toMatchObject({
      success: false,
      error: { code: "INVALID_ARGS" },
    });
  });

  it("copies into an --out directory, never over an existing file unless asked", async () => {
    const { file, bytes } = cachedPhoto();
    const outDir = join(env.dataDir, "exports");
    mkdirSync(outDir);
    const args = ["--chat", "me", "--id", "1", "--out", outDir];

    const output = await download(args);
    const target = join(outDir, "photo.jpg");
    expect(output.data).toMatchObject({ path: target, cachePath: file });
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0);

    const identical = await runCli(["media", "download", ...args], offline);
    expect(identical.json).toMatchObject({ error: { code: "FILE_EXISTS" } });
    expect(identical.exitCode).toBe(1);
    writeFileSync(target, "edited copy");
    const again = await runCli(["media", "download", ...args], offline);
    expect(again.exitCode).toBe(1);
    expect(again.json).toMatchObject({
      success: false,
      error: { code: "FILE_EXISTS", details: { path: target } },
    });
    expect(readFileSync(target, "utf-8")).toBe("edited copy");

    await download([...args, "--overwrite"]);
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0);
    expect(readdirSync(outDir)).toEqual(["photo.jpg"]);
  });

  it("writes an --out file path, creating its folders", async () => {
    const { bytes } = cachedPhoto();
    const target = join(env.dataDir, "exports", "lake", "example-lake.jpg");

    const output = await download(["--chat", "me", "--id", "1", "--out", target]);

    expect(output.data.path).toBe(target);
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0);
  });

  it("writes the bytes alone to stdout with --out -", async () => {
    const { bytes } = cachedPhoto();

    const proc = spawnCli(
      ["media", "download", "--chat", "me", "--id", "1", "--out", "-"],
      offline,
    );
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
    ]);

    expect(exitCode).toBe(0);
    expect(Buffer.compare(new Uint8Array(stdout), bytes)).toBe(0);
  });

  it("serves a cached preview of its own size with --thumb", async () => {
    const pdf = pdfDocumentMessage({ _: "peerUser", userId: SELF_ID }, 5);
    cache(SELF_ID, pdf);
    const thumb = pickThumb(pdf)!;
    const { file } = thumbPaths(mediaDir, extractAttachment(pdf)!, thumb);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, fakeBytes(thumb.size));

    const output = await download(["--chat", "me", "--id", "5", "--thumb"]);

    expect(output.data).toMatchObject({
      path: file,
      fileName: "thumb-m.jpg",
      size: 3_000,
      kind: "thumbnail",
      uniqueFileId: thumb.uniqueFileId,
      cached: true,
      thumb: { type: "m", width: 320, height: 180 },
    });
  });

  it("refuses a cached message with content protection", async () => {
    const { file } = cachedPhoto(1, { noforwards: true });

    const result = await runCli(["media", "download", "--chat", "me", "--id", "1"], offline);
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: "CONTENT_PROTECTED",
        details: { chatId: SELF_ID, messageId: 1, reason: "message" },
      },
    });
    expect(existsSync(file)).toBe(true);
  });

  it("refuses the cached file of a chat an online check found protected", async () => {
    const db = env.openCacheDb(1);
    createUsersCache(db).upsert({
      user_id: String(ALICE_ID),
      first_name: "Alice",
      last_name: "Example",
      access_hash: "1111",
      fetched_at: Date.now(),
      raw_json: "{}",
    });
    const photo = photoMessage({ _: "peerUser", userId: ALICE_ID }, 2);
    cache(ALICE_ID, photo);
    const { file } = mediaPaths(mediaDir, extractAttachment(photo)!);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, fakeBytes(PHOTO_SIZE));
    createChatProtectionStore(db).record(
      ALICE_ID,
      { protected: true, reason: "private_chat" },
      Date.now(),
    );

    const result = await runCli(
      ["media", "download", "--chat", String(ALICE_ID), "--id", "2"],
      offline,
    );
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: "CONTENT_PROTECTED",
        details: { chatId: ALICE_ID, messageId: 2, reason: "private_chat" },
      },
    });
  });
});

describe("E2E: media download of several messages", () => {
  const ALICE_ID = 5_550_003;
  let env: TestEnvironment;
  let mediaDir: string;

  beforeEach(() => {
    env = createTestEnvironment("media-batch");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    createUsersCache(env.openCacheDb(1)).upsert({
      user_id: String(ALICE_ID),
      first_name: "Alice",
      last_name: "Example",
      access_hash: "1111",
      fetched_at: Date.now(),
      raw_json: "{}",
    });
    mediaDir = join(env.dataDir, "accounts", "1", "media");
  });

  afterEach(() => {
    env.cleanup();
  });

  function run(args: string[], files: FakeMediaFile[] = [], tty = false) {
    const scenario: FakeMediaScenario = { userId: ALICE_ID, files, tty };
    return runCli(["media", "download", ...args], {
      env: {
        ...env.getCliOptions().env,
        [FAKE_MEDIA_ENV]: JSON.stringify(scenario),
      },
      entry: FAKE_MEDIA_CLI,
      timeout: 20_000,
    });
  }

  type Line =
    | DownloadOutput
    | {
        success: false;
        error: {
          code: string;
          message: string;
          details: { messageId: number } & Record<string, unknown>;
          retryable: boolean;
        };
      };

  function lines(stdout: string) {
    const id = (line: Line) =>
      "data" in line ? line.data.messageId : line.error.details.messageId;
    return stdout
      .split("\n")
      .map((line) => JSON.parse(line) as Line)
      .sort((a, b) => id(a) - id(b));
  }

  function calls(stderr: string) {
    return stderr
      .split("\n")
      .filter((line) => line.startsWith(FAKE_MEDIA_CALL))
      .map((line) => JSON.parse(line.slice(FAKE_MEDIA_CALL.length)));
  }

  function cacheFile(chatId: number, raw: unknown, bytes: Uint8Array) {
    createMessagesCache(env.openCacheDb(1)).upsert(parseRawMessage(raw, chatId)!);
    const { file } = mediaPaths(mediaDir, extractAttachment(raw)!);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  }

  const VOICE = { id: 11, size: 30_000, fileName: "example-voice.ogg" };
  const CLIP = { id: 12, size: 700_000, fileName: "example-clip.mp4" };
  const NOTES = { id: 13, size: 5_000, fileName: "example-notes.txt" };

  it("downloads several messages in one run: one fetch, one line per file", async () => {
    const files = [VOICE, CLIP, NOTES];
    const ids = files.flatMap((file) => ["--id", String(file.id)]);

    const result = await run(["--chat", String(ALICE_ID), ...ids], files);

    expect(result.exitCode).toBe(0);
    const output = lines(result.stdout) as DownloadOutput[];
    expect(output.map((line) => line.data)).toEqual(
      files.map((file) =>
        expect.objectContaining({
          chatId: ALICE_ID,
          messageId: file.id,
          fileName: file.fileName,
          size: file.size,
          cached: false,
          resumedFrom: null,
        }),
      ),
    );
    for (const [index, line] of output.entries()) {
      expect(line.data.path).toBe(line.data.cachePath);
      expect(Buffer.compare(readFileSync(line.data.path), mediaBytes(files[index]!))).toBe(0);
    }
    const made = calls(result.stderr);
    expect(made.filter((call) => call.method !== "upload.getFile")).toEqual([
      { method: "messages.getMessages", ids: [11, 12, 13] },
      { method: "users.getFullUser" },
    ]);
    expect(result.stderr).toContain("Downloaded 3 of 3 files");
  });

  it("serves cached files without network and fetches only the rest", async () => {
    const cached = mediaMessage(ALICE_ID, NOTES);
    const file = cacheFile(ALICE_ID, cached, mediaBytes(NOTES));

    const result = await run(["--chat", String(ALICE_ID), "--id", "13", "--id", "11"], [VOICE]);

    expect(result.exitCode).toBe(0);
    const [voice, notes] = lines(result.stdout) as DownloadOutput[];
    expect(notes!.data).toMatchObject({ path: file, cached: true });
    expect(voice!.data).toMatchObject({ messageId: 11, cached: false });
    expect(calls(result.stderr)[0]).toEqual({
      method: "messages.getMessages",
      ids: [11],
    });
  });

  it("resumes a partial download from its last whole part", async () => {
    const big = { id: 14, size: 1_200_000, fileName: "example-talk.ogg" };
    const { part } = mediaPaths(mediaDir, extractAttachment(mediaMessage(ALICE_ID, big))!);
    mkdirSync(join(part, ".."), { recursive: true });
    writeFileSync(part, mediaBytes(big).subarray(0, 600_000));

    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "14", "--id", "11"],
      [big, VOICE],
    );

    expect(result.exitCode).toBe(0);
    const [, talk] = lines(result.stdout) as DownloadOutput[];
    expect(talk!.data).toMatchObject({ resumedFrom: 524_288, cached: false });
    expect(Buffer.compare(readFileSync(talk!.data.path), mediaBytes(big))).toBe(0);
    const offsets = calls(result.stderr)
      .filter((call) => call.method === "upload.getFile" && call.id === 14)
      .map((call) => call.offset);
    expect(offsets).toEqual([524_288, 1_048_576]);
  });

  it("reports a failed file on its own line, finishes the others and exits 1", async () => {
    const broken = {
      id: 15,
      size: 9_000,
      fileName: "broken.bin",
      error: "FILE_ID_INVALID",
    };

    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "11", "--id", "15", "--id", "13"],
      [VOICE, broken, NOTES],
    );

    expect(result.exitCode).toBe(1);
    const [voice, notes, failed] = lines(result.stdout);
    expect(voice).toMatchObject({ success: true, data: { messageId: 11 } });
    expect(notes).toMatchObject({ success: true, data: { messageId: 13 } });
    expect(failed).toEqual({
      success: false,
      error: {
        code: "TELEGRAM_ERROR",
        message: "Telegram refused the download: FILE_ID_INVALID",
        details: {
          chatId: ALICE_ID,
          messageId: 15,
          method: "upload.getFile",
          error: "FILE_ID_INVALID",
        },
        retryable: false,
      },
    });
    expect(result.stderr).toContain("Downloaded 2 of 3 files, 1 failed");
  });

  it("pauses the whole batch for a flood wait and then completes it", async () => {
    const flooded = { ...CLIP, floodWaitOnce: 2 };
    const started = Date.now();

    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "11", "--id", "12", "--id", "13"],
      [VOICE, flooded, NOTES],
    );

    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout).every((line) => line.success)).toBe(true);
    expect(result.stderr).toContain("[flood-wait] upload.getFile: pausing the batch for 2s");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000);
    expect(
      calls(result.stderr).filter((call) => call.method === "messages.getMessages"),
    ).toHaveLength(1);
  });

  it("names files by template: two photos into one directory and a name made safe", async () => {
    const self = { _: "peerUser" as const, userId: SELF_ID };
    const bytes = fakeBytes(60_000, 3);
    cacheFile(SELF_ID, photoMessage(self, 1), bytes);
    cacheFile(SELF_ID, photoMessage(self, 2), bytes);
    const draft = documentMessage(self, 3, {
      id: "6000000000000000031",
      mimeType: "application/pdf",
      size: 4_000,
      thumbs: [],
      attributes: [{ _: "documentAttributeFilename", fileName: "Q3 report: draft?.pdf" }],
    });
    cacheFile(SELF_ID, draft, fakeBytes(4_000));
    const outDir = join(env.dataDir, "exports");
    const offline = { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } };

    const photos = await runCliSuccess(
      ["media", "download", "--chat", "me", "--id", "1", "--id", "2", "--out", outDir],
      offline,
    );
    expect(lines(photos.stdout).map((line) => (line as DownloadOutput).data.path)).toEqual([
      join(outDir, "1_photo.jpg"),
      join(outDir, "2_photo.jpg"),
    ]);

    const template = join(outDir, "{chat}", "{date}_{id}_{kind}_{name}");
    const args = ["media", "download", "--chat", "me", "--id", "3", "--id", "1", "--out", template];
    const named = await runCliSuccess(args, offline);
    expect(lines(named.stdout).map((line) => (line as DownloadOutput).data.path)).toEqual([
      join(outDir, String(SELF_ID), "2025-10-09_1_photo_photo.jpg"),
      join(outDir, String(SELF_ID), "2025-10-09_3_document_Q3 report_ draft_.pdf"),
    ]);

    await runCliSuccess(args, offline);
    expect(readdirSync(join(outDir, String(SELF_ID))).sort()).toEqual([
      "2025-10-09_1_photo_photo.jpg",
      "2025-10-09_3_document_Q3 report_ draft_.pdf",
    ]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable equal-size export as a local error",
    async () => {
      const out = join(env.dataDir, "existing");
      mkdirSync(out);
      const target = join(out, "11_example-voice.ogg");
      writeFileSync(target, mediaBytes(VOICE), { mode: 0o000 });
      try {
        const result = await run(
          ["--chat", String(ALICE_ID), "--id", "11", "--id", "13", "--out", out],
          [VOICE, NOTES],
        );
        expect(result.exitCode).toBe(1);
        expect(lines(result.stdout)[0]).toMatchObject({
          error: { code: "GENERAL_ERROR", details: { messageId: 11 } },
        });
      } finally {
        chmodSync(target, 0o600);
      }
    },
  );

  it("keeps a local error when the output parent is a regular file", async () => {
    const parent = join(env.dataDir, "regular-file");
    writeFileSync(parent, "unchanged");
    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "11", "--id", "13", "--out", join(parent, "{id}")],
      [VOICE, NOTES],
    );
    expect(result.exitCode).toBe(1);
    expect(lines(result.stdout)).toMatchObject([
      { error: { code: "GENERAL_ERROR" } },
      { error: { code: "GENERAL_ERROR" } },
    ]);
    expect(readFileSync(parent, "utf8")).toBe("unchanged");
  });

  it("downloads and accounts for calls in the selected account only", async () => {
    env.seedAccounts([{ phone: "+15550000002", user_id: 5_550_010, is_active: false }]);
    for (const file of [VOICE, NOTES])
      cacheFile(ALICE_ID, mediaMessage(ALICE_ID, file), mediaBytes(file));
    const result = await run(
      ["--account", "2", "--chat", String(ALICE_ID), "--id", "11", "--id", "13"],
      [VOICE, NOTES],
    );
    expect(result.exitCode).toBe(0);
    for (const line of lines(result.stdout) as DownloadOutput[]) {
      expect(line.data.cached).toBe(false);
      expect(line.data.cachePath).toStartWith(join(env.dataDir, "accounts", "2", "media"));
    }
    for (const [account, expected] of [
      [1, 0],
      [2, 1],
    ] as const) {
      expect(
        env
          .openCacheDb(account)
          .query("SELECT COUNT(*) AS n FROM api_activity WHERE method='users.getFullUser'")
          .get(),
      ).toEqual({ n: expected });
    }
  });

  it("reports completed files on a terminal before the final summary", async () => {
    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "11", "--id", "13"],
      [VOICE, NOTES],
      true,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Processed 1 of 2 files");
    expect(result.stderr).toContain("Downloaded 2 of 2 files");
  });

  it("prints one JSON line per ID even in pretty mode", async () => {
    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "11", "--id", "13", "-f", "pretty"],
      [VOICE, NOTES],
    );
    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout)).toHaveLength(2);
  });

  it("uses a template ending in a slash as a directory", async () => {
    const folder = `${join(env.dataDir, "{date}")}/`;
    const result = await run(
      ["--chat", String(ALICE_ID), "--id", "11", "--id", "13", "--out", folder],
      [VOICE, NOTES],
    );
    expect(result.exitCode).toBe(0);
    expect(readdirSync(join(env.dataDir, "2025-10-09")).sort()).toEqual([
      "11_example-voice.ogg",
      "13_example-notes.txt",
    ]);
  });

  it.each([false, true])(
    "keeps the successful bytes on a template collision (overwrite %s)",
    async (overwrite) => {
      const out = join(env.dataDir, "{kind}");
      const files = [VOICE, NOTES];
      const result = await run(
        [
          "--chat",
          String(ALICE_ID),
          "--id",
          "11",
          "--id",
          "13",
          "--out",
          out,
          ...(overwrite ? ["--overwrite"] : []),
        ],
        files,
      );
      expect(result.exitCode).toBe(1);
      const output = lines(result.stdout);
      expect(output.filter((line) => !line.success)).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({ code: "FILE_EXISTS" }),
        }),
      ]);
      const saved = output.find((line) => "data" in line) as DownloadOutput;
      const file = files.find((file) => file.id === saved.data.messageId)!;
      expect(Buffer.compare(readFileSync(saved.data.path), mediaBytes(file))).toBe(0);
    },
  );

  it("refuses --out - and unknown placeholders", async () => {
    const offline = { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } };
    for (const out of ["-", "exports/{title}"]) {
      const result = await runCli(
        ["media", "download", "--chat", "me", "--id", "1", "--id", "2", "--out", out],
        offline,
      );
      expect(result.exitCode).toBe(3);
      expect(result.json).toMatchObject({
        success: false,
        error: { code: "INVALID_ARGS", details: { out } },
      });
    }
  });
});
