import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TelegramClient } from "@mtcute/bun";

import { MediaError } from "./errors";
import {
  type PipelineDeps,
  type TranscribeOutcome,
  transcribeMessages,
} from "./transcription-pipeline";
import type {
  ProviderDeclaration,
  ProviderResult,
  TranscriptionProvider,
  TranscriptionRequest,
} from "./transcription-provider";
import type { HistoryClient } from "../messages/helpers";
import { createDmLookup } from "../send/peer-resolver";
import { parseRawMessage } from "../../daemon/sync-worker-real-helpers";
import { createChatsCache } from "../../db/chats-cache";
import { createMessageTranscriptsStore } from "../../db/message-transcripts";
import { createMessageTranscriptsSchema } from "../../db/sync-schema";
import { createMessagesCache } from "../../db/messages-cache";
import { createUsersCache } from "../../db/users-cache";
import { type Account, ErrorCodes } from "../../types";
import { extractAttachment } from "../../utils/attachment";
import { mediaPaths } from "../../utils/media-cache";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { documentMessage } from "../../test/media-messages.test-utils";
import { photoMessage } from "../../test/photo-message.test-utils";

const SELF_ID = 5_550_001;
const SELF = { _: "peerUser" as const, userId: SELF_ID };
const ACCOUNT: Account = {
  id: 1,
  phone: "+15550000000",
  user_id: SELF_ID,
  name: "Example Account",
  username: null,
  label: null,
  session_data: "",
  is_active: 1,
  created_at: "2026-10-01 00:00:00",
  updated_at: "2026-10-01 00:00:00",
};

let db: Database;
let root: string;
let mediaDir: string;
let tmpRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tg-transcription-pipeline-"));
  mediaDir = join(root, "media");
  tmpRoot = join(root, "tmp");
  mkdirSync(tmpRoot);
  db = createAccountCacheDb();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function voiceNote(
  id: number,
  options: {
    bytes?: string;
    fileId?: string;
    duration?: number;
    extra?: object;
  } = {},
) {
  const raw = documentMessage(
    SELF,
    id,
    {
      id: options.fileId ?? `60000000000000004${String(id).padStart(2, "0")}`,
      mimeType: "audio/ogg",
      size: options.bytes === undefined ? 24_000 : Buffer.byteLength(options.bytes),
      thumbs: [],
      attributes: [
        {
          _: "documentAttributeAudio",
          voice: true,
          duration: options.duration ?? 5,
        },
      ],
    },
    options.extra as Record<string, unknown>,
  );
  createMessagesCache(db).upsert(parseRawMessage(raw, SELF_ID)!);
  if (options.bytes !== undefined) {
    const { file } = mediaPaths(mediaDir, extractAttachment(raw)!);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, options.bytes);
  }
  return raw;
}

const noClient: () => TelegramClient = () => {
  throw new Error("no download or fetch was expected");
};

function deps(provider: TranscriptionProvider, overrides: Partial<PipelineDeps["download"]> = {}) {
  const offline: HistoryClient = {
    call: (() => {
      throw new Error("--chat resolves offline");
    }) as HistoryClient["call"],
    getMe: () => {
      throw new Error("--chat resolves offline");
    },
  };
  return {
    download: {
      cacheDb: db,
      mediaDir,
      getClient: noClient,
      history: {
        client: offline,
        usersCache: createUsersCache(db),
        chatsCache: createChatsCache(db),
        dms: createDmLookup(db),
        accounts: {
          getById: () => ACCOUNT,
          getActive: () => ACCOUNT,
          update: () => ACCOUNT,
        },
        accountId: ACCOUNT.id,
      },
      signal: new AbortController().signal,
      ...overrides,
    },
    setup: { ready: true, provider, ffmpeg: null },
    language: null,
    force: false,
    tmpRoot,
    now: () => 1_000,
  } satisfies PipelineDeps;
}

function fakeProvider(
  declaration: Partial<ProviderDeclaration>,
  answer: (request: TranscriptionRequest) => ProviderResult,
) {
  const calls: TranscriptionRequest[][] = [];
  const provider: TranscriptionProvider = {
    declaration: {
      id: "local",
      engine: "example-engine",
      model: "example-model",
      sendsTo: null,
      cost: "free",
      input: { kind: "message" },
      batchSize: 10,
      concurrency: 1,
      maxDurationSeconds: null,
      ...declaration,
    },
    async transcribe(requests) {
      calls.push([...requests]);
      return requests.map(answer);
    },
  };
  return { provider, calls };
}

function remoteProvider(answer: (request: TranscriptionRequest) => ProviderResult) {
  return fakeProvider(
    {
      engine: "example-speech-api",
      sendsTo: "speech.example.com",
      cost: "paid",
      input: { kind: "audio", formats: ["original"] },
      batchSize: 1,
      concurrency: 2,
      maxDurationSeconds: 60,
    },
    answer,
  );
}

function messageProvider(answer: (request: TranscriptionRequest) => ProviderResult) {
  return fakeProvider(
    { engine: "example-message-service", sendsTo: "messages.example.com" },
    answer,
  );
}

const done = (text: string) =>
  ({
    status: "done",
    text,
    language: "en",
    model: "example-model",
  }) satisfies ProviderResult;

function stored(messageId: number) {
  return createMessageTranscriptsStore(db).get(SELF_ID, messageId);
}

function asError(outcome: TranscribeOutcome | undefined) {
  expect(outcome).toBeInstanceOf(MediaError);
  return outcome as MediaError;
}

describe("transcribeMessages with a provider that reads the message", () => {
  it("withholds a cached transcript when its attachment changes while another ID runs", async () => {
    voiceNote(1);
    voiceNote(2);
    const first = messageProvider(() => done("Earlier words."));
    await transcribeMessages(deps(first.provider), "me", [1]);
    const second = messageProvider(() => {
      voiceNote(1, { fileId: "6000000000000000877" });
      return done("Second note.");
    });
    const [old, fresh] = await transcribeMessages(deps(second.provider), "me", [1, 2]);
    expect(asError(old).details.reason).toBe("attachment_changed");
    expect(fresh).toMatchObject({ text: "Second note." });
  });

  it("fetches no file and converts nothing", async () => {
    const raw = voiceNote(1, { duration: 7 });
    const fake = messageProvider(() => done("Read from the message."));

    const [outcome] = await transcribeMessages(deps(fake.provider), "me", [1]);

    expect(outcome).toEqual({
      chatId: SELF_ID,
      messageId: 1,
      text: "Read from the message.",
      language: "en",
      source: "local",
      runner: "example-message-service",
      model: "example-model",
      cached: false,
    });
    expect(fake.calls).toEqual([
      [
        {
          chatId: SELF_ID,
          messageId: 1,
          kind: "voice",
          durationSeconds: 7,
          uniqueFileId: extractAttachment(raw)!.uniqueFileId,
          audio: null,
        },
      ],
    ]);
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(stored(1)?.text).toBe("Read from the message.");
  });
});

describe("transcribeMessages with a provider that uploads the original file", () => {
  it("recognizes a forwarded file once in a cold batch and stores each message", async () => {
    const fileId = "6000000000000000555";
    voiceNote(1, { fileId, bytes: "one" });
    voiceNote(2, { fileId, bytes: "one" });
    const fake = remoteProvider(() => done("Same words."));
    const results = await transcribeMessages(deps(fake.provider), "me", [2, 1]);
    expect(fake.calls.flat()).toHaveLength(1);
    expect(results).toMatchObject([
      { messageId: 2, text: "Same words." },
      { messageId: 1, text: "Same words." },
    ]);
    expect(stored(1)?.text).toBe(stored(2)?.text ?? "missing");
  });

  it("hands over the cached file itself, unconverted", async () => {
    voiceNote(1, { bytes: "OggS example voice bytes" });
    let received = "";
    const fake = remoteProvider((request) => {
      received = readFileSync(request.audio!.path, "utf-8");
      expect(readdirSync(tmpRoot)).toEqual([]);
      expect(request.audio).toMatchObject({
        format: "original",
        mimeType: "audio/ogg",
      });
      return done("Uploaded as it was.");
    });

    const [outcome] = await transcribeMessages(deps(fake.provider), "me", [1]);

    expect(outcome).toMatchObject({
      text: "Uploaded as it was.",
      cached: false,
    });
    expect(received).toBe("OggS example voice bytes");
  });

  it("reports an unknown outcome as such, not retryable, and stores nothing", async () => {
    voiceNote(1, { bytes: "first" });
    voiceNote(2, { bytes: "second" });
    const fake = remoteProvider((request) =>
      request.messageId === 2
        ? {
            status: "failed",
            failure: "outcome_unknown",
            error: new MediaError(
              ErrorCodes.NETWORK_ERROR,
              "The connection closed before the reply arrived",
              {},
            ),
          }
        : done("First is fine."),
    );

    const outcomes = await transcribeMessages(deps(fake.provider), "me", [1, 2]);

    const err = asError(outcomes[1]);
    expect(err).toMatchObject({
      code: "NETWORK_ERROR",
      details: { chatId: SELF_ID, messageId: 2, outcome: "unknown" },
      retryable: false,
    });
    expect(stored(2)).toBeNull();
    expect(fake.calls).toHaveLength(2);
  });

  it("reports a rejection as not retryable, even of a network error, and retry_later as retryable", async () => {
    voiceNote(1, { bytes: "first" });
    voiceNote(2, { bytes: "second" });
    const networkError = () =>
      new MediaError(ErrorCodes.NETWORK_ERROR, "The service refused the audio", {});
    const fake = remoteProvider((request) => ({
      status: "failed",
      failure: request.messageId === 1 ? "rejected" : "retry_later",
      error: networkError(),
    }));

    const outcomes = await transcribeMessages(deps(fake.provider), "me", [1, 2]);

    expect(networkError().retryable).toBe(true);
    expect(asError(outcomes[0]).retryable).toBe(false);
    expect(asError(outcomes[1]).retryable).toBe(true);
  });

  it("keeps the ready results of a batch when other messages fail", async () => {
    voiceNote(1, { bytes: "first" });
    createMessagesCache(db).upsert(parseRawMessage(photoMessage(SELF, 2), SELF_ID)!);
    voiceNote(3, { bytes: "third" });
    voiceNote(4, { bytes: "fourth" });
    const fake = remoteProvider((request) =>
      request.messageId === 3
        ? {
            status: "failed",
            failure: "rejected",
            error: new MediaError(ErrorCodes.GENERAL_ERROR, "Unreadable audio", {}),
          }
        : done(`Message ${request.messageId}.`),
    );

    const outcomes = await transcribeMessages(deps(fake.provider), "me", [1, 2, 3, 4]);

    expect(outcomes[0]).toMatchObject({ messageId: 1, text: "Message 1." });
    expect(asError(outcomes[1]).code).toBe("MEDIA_UNSUPPORTED");
    expect(asError(outcomes[2]).code).toBe("GENERAL_ERROR");
    expect(outcomes[3]).toMatchObject({ messageId: 4, text: "Message 4." });
    expect(stored(1)?.text).toBe("Message 1.");
    expect(stored(4)?.text).toBe("Message 4.");
    expect(stored(3)).toBeNull();
  });

  it("refuses audio longer than the provider takes before fetching it", async () => {
    voiceNote(1, { duration: 90 });
    const fake = remoteProvider(() => done("never"));

    const [outcome] = await transcribeMessages(deps(fake.provider), "me", [1]);

    expect(asError(outcome)).toMatchObject({
      code: "MEDIA_UNSUPPORTED",
      details: { reason: "too_long", duration: 90, maxDuration: 60 },
    });
    expect(fake.calls).toEqual([]);
  });
});

describe("transcribeMessages: eligibility checked again before saving", () => {
  it("stores nothing when the file changed during transcription", async () => {
    voiceNote(1);
    const fake = messageProvider(() => {
      voiceNote(1, { fileId: "6000000000000000499" });
      return done("Of the old file.");
    });

    const [outcome] = await transcribeMessages(deps(fake.provider), "me", [1]);

    expect(asError(outcome)).toMatchObject({
      details: { reason: "attachment_changed" },
      retryable: true,
    });
    expect(stored(1)).toBeNull();
  });

  it("rejects and stores nothing when interrupted while the provider answers", async () => {
    voiceNote(1);
    const controller = new AbortController();
    const fake = messageProvider(() => {
      controller.abort();
      return done("Finished as the signal came.");
    });

    const run = transcribeMessages(deps(fake.provider, { signal: controller.signal }), "me", [1]);

    await expect(run).rejects.toThrow();
    expect(stored(1)).toBeNull();
  });

  it("stores nothing when the message became protected during transcription", async () => {
    voiceNote(1);
    const fake = messageProvider(() => {
      voiceNote(1, { extra: { noforwards: true } });
      return done("Protected now.");
    });

    const [outcome] = await transcribeMessages(deps(fake.provider), "me", [1]);

    expect(asError(outcome).code).toBe("CONTENT_PROTECTED");
    expect(stored(1)).toBeNull();
  });
});

describe("transcribeMessages: a message that is not cached", () => {
  it("rejects a replacement returned online before downloading or recognizing its bytes", async () => {
    voiceNote(1);
    const fake = remoteProvider(() => done("never"));
    const client = {
      async call() {
        return { _: "messages.messages", messages: [photoMessage(SELF, 1)], chats: [], users: [] };
      },
    } as unknown as TelegramClient;
    const [outcome] = await transcribeMessages(
      deps(fake.provider, {
        getClient: () => client,
        download: () => {
          throw new Error("replacement must not be downloaded");
        },
      }),
      "me",
      [1],
    );
    expect(asError(outcome).details.reason).toBe("attachment_changed");
    expect(fake.calls).toEqual([]);
    expect(stored(1)).toBeNull();
  });

  it("refuses a photo before any of its bytes are transferred", async () => {
    const calls: string[] = [];
    const client = {
      async call(request: { _: string }) {
        calls.push(request._);
        if (request._ === "messages.getMessages") {
          return {
            _: "messages.messages",
            messages: [photoMessage(SELF, 9)],
            chats: [],
            users: [],
          };
        }
        throw new Error(`Unexpected call ${request._}`);
      },
    } as unknown as TelegramClient;
    const fake = remoteProvider(() => done("never"));

    const [outcome] = await transcribeMessages(
      deps(fake.provider, { getClient: () => client }),
      "me",
      [9],
    );

    expect(asError(outcome)).toMatchObject({
      code: "MEDIA_UNSUPPORTED",
      details: { kind: "photo", reason: "not_speech" },
    });
    expect(calls).toEqual(["messages.getMessages"]);
    expect(fake.calls).toEqual([]);
  });
});

it("upgrades stored speech and keeps the index attached to its row after vacuum", () => {
  db.run("DROP TABLE transcript_search");
  db.run("DROP TABLE message_transcripts");
  db.run(`CREATE TABLE message_transcripts (chat_id INTEGER, message_id INTEGER,
    unique_file_id TEXT, text TEXT, language TEXT, source TEXT, runner TEXT, model TEXT,
    transcribed_at INTEGER, PRIMARY KEY(chat_id, message_id))`);
  db.run(`INSERT INTO message_transcripts VALUES (1, 17, 'fake-a', 'North', 'en','local','whisper','small',1),
    (1, 18, 'fake-b','South','en','local','whisper','small',2)`);
  createMessageTranscriptsSchema(db);
  db.run("DELETE FROM message_transcripts WHERE message_id = 17");
  db.run("VACUUM");
  expect(
    db
      .query(`SELECT t.message_id FROM transcript_search
    JOIN message_transcripts t ON t.id = transcript_search.rowid WHERE transcript_search MATCH 'south'`)
      .get(),
  ).toEqual({ message_id: 18 });
  expect(
    db.query("SELECT rowid FROM transcript_search WHERE transcript_search MATCH 'north'").get(),
  ).toBeNull();
});
