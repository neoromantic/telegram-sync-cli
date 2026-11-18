import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMessagesCache } from "../db/messages-cache";
import { createNewMessagesFeed } from "../db/new-messages";
import { initCacheSchema } from "../db/schema";
import { initSyncSchema } from "../db/sync-schema";
import { takePartIn } from "./helpers/participation";

const CHAT = -1001234567890;
const OTHER = 42;

describe("createNewMessagesFeed", () => {
  let dir: string;
  let writer: Database;
  let reader: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-new-messages-"));
    const path = join(dir, "cache.db");
    writer = new Database(path);
    writer.run("PRAGMA journal_mode = WAL");
    initCacheSchema(writer);
    initSyncSchema(writer);
    reader = new Database(path);
  });

  afterEach(() => {
    reader.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function store(chatId: number, ids: number[], extra: { is_deleted?: boolean } = {}): void {
    takePartIn(writer, CHAT);
    createMessagesCache(writer).upsertBatch(
      ids.map((id) => ({
        chat_id: chatId,
        message_id: id,
        text: `message ${id}`,
        message_type: "text",
        date: 1_700_000_000 + id,
        raw_json: "{}",
        ...extra,
      })),
    );
  }

  const ids = (rows: { chat_id: number; message_id: number }[]) =>
    rows.map((row) => [row.chat_id, row.message_id]);

  it("counts only messages newer than every one of their chat", () => {
    store(CHAT, [10, 20]);
    const feed = createNewMessagesFeed(reader);
    expect(feed.initial).toEqual([]);
    expect(feed.poll()).toEqual([]);

    store(CHAT, [15, 21]);
    expect(ids(feed.poll())).toEqual([[CHAT, 21]]);

    store(OTHER, [500]);
    expect(ids(feed.poll())).toEqual([[OTHER, 500]]);
    store(OTHER, [400, 450]);
    expect(feed.poll()).toEqual([]);

    createMessagesCache(writer).updateText(CHAT, 21, "edited", 1_700_000_100);
    expect(feed.poll()).toEqual([]);
  });

  it("keeps only the chats of chatIds", () => {
    const feed = createNewMessagesFeed(reader, { chatIds: [CHAT] });
    store(OTHER, [1]);
    store(CHAT, [2]);
    expect(ids(feed.poll())).toEqual([[CHAT, 2]]);

    const none = createNewMessagesFeed(reader, { chatIds: [] });
    store(CHAT, [3]);
    expect(none.poll()).toEqual([]);
  });

  it("leaves out deleted messages and keeps to --chat", () => {
    const feed = createNewMessagesFeed(reader, { chatId: CHAT });
    store(CHAT, [1], { is_deleted: true });
    store(OTHER, [2]);
    store(CHAT, [3]);

    expect(ids(feed.poll())).toEqual([[CHAT, 3]]);
  });

  it("returns the cached messages after --after, then only newer ones", () => {
    store(CHAT, [1, 2, 3]);
    const feed = createNewMessagesFeed(reader, { chatId: CHAT, after: 1 });
    expect(ids(feed.initial)).toEqual([
      [CHAT, 2],
      [CHAT, 3],
    ]);

    store(CHAT, [4]);
    expect(ids(feed.poll())).toEqual([[CHAT, 4]]);
  });
});
