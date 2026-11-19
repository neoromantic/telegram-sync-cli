import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createMessagesCache, type MessageInput, type MessagesCache } from "./messages-cache";
import { createMessagesSearch } from "./messages-search";
import { createUsersCache } from "./users-cache";
import { toRawJson } from "../utils/raw-json";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { takePartIn } from "../test/participation.test-utils";
import { REPORT_BLOCKS, REPORT_TEXT, richTlMessage } from "../test/rich-message.test-utils";

describe("MessagesCache", () => {
  let cache: MessagesCache;

  beforeEach(() => {
    const db = createAccountCacheDb();
    takePartIn(db, -5151, -1001234567890, -1009876543210);
    cache = createMessagesCache(db);
  });

  afterEach(() => {
    setSystemTime();
  });

  function message(chatId: number, messageId: number, extra: Partial<MessageInput> = {}) {
    return {
      chat_id: chatId,
      message_id: messageId,
      text: `made-up message ${messageId} in ${chatId}`,
      message_type: "text",
      date: 1_760_000_000 + messageId,
      raw_json: "{}",
      ...extra,
    };
  }

  it("updates a cached message in place, keeping created_at", () => {
    setSystemTime(1_760_000_000_000);
    cache.upsert(message(100, 1, { from_id: 123, text: "Original" }));
    const createdAt = cache.get(100, 1)?.created_at;
    setSystemTime(1_760_000_000_010);
    cache.upsert(message(100, 1, { from_id: 123, text: "Updated", is_edited: true }));

    expect(cache.get(100, 1)).toMatchObject({
      from_id: 123,
      text: "Updated",
      is_edited: 1,
      created_at: createdAt,
      updated_at: 1_760_000_000_010,
    });
  });

  it("marks the given messages of a chat deleted", () => {
    cache.upsertBatch([1, 2, 3].map((id) => message(100, id)));

    cache.markDeleted(100, [1, 3]);

    expect([1, 2, 3].map((id) => cache.get(100, id)?.is_deleted)).toEqual([1, 0, 1]);
  });

  it("stores the text and date of a live edit", () => {
    cache.upsert(message(100, 1));

    cache.updateText(100, 1, "First edit", 1_760_000_060);
    cache.updateText(100, 1, "Second edit", 1_760_000_120);

    expect(cache.get(100, 1)).toMatchObject({
      text: "Second edit",
      is_edited: 1,
      edit_date: 1_760_000_120,
    });
  });

  it("reads a chat's newest and oldest message IDs, null for a chat without messages", () => {
    cache.upsertBatch([5, 10, 3].map((id) => message(100, id)));
    cache.upsert(message(200, 50));

    expect(cache.getLatestMessageId(100)).toBe(10);
    expect(cache.getOldestMessageId(100)).toBe(3);
    expect(cache.getLatestMessageId(300)).toBeNull();
    expect(cache.getOldestMessageId(300)).toBeNull();
  });

  describe("markDeletedByMessageIds", () => {
    function cacheMessage(messageId: number, chatIds: number[]) {
      for (const chatId of chatIds) cache.upsert(message(chatId, messageId));
    }

    it("marks each ID in the one chat that has it, skipping unknown IDs", () => {
      cache.upsertBatch([message(100, 1), message(200, 2), message(100, 3), message(300, 4)]);

      expect(cache.markDeletedByMessageIds([1, 2, 3, 999])).toEqual({
        deleted: 3,
        ambiguous: [],
      });
      expect(
        [cache.get(100, 1), cache.get(200, 2), cache.get(100, 3), cache.get(300, 4)].map(
          (row) => row?.is_deleted,
        ),
      ).toEqual([1, 1, 1, 0]);
    });

    it("marks the private chat's or basic group's message when a channel or supergroup has the same ID", () => {
      cacheMessage(7, [4242, -1001234567890]);
      cacheMessage(8, [-5151, -1009876543210]);

      expect(cache.markDeletedByMessageIds([7, 8])).toEqual({
        deleted: 2,
        ambiguous: [],
      });
      expect(cache.get(4242, 7)?.is_deleted).toBe(1);
      expect(cache.get(-1001234567890, 7)?.is_deleted).toBe(0);
      expect(cache.get(-5151, 8)?.is_deleted).toBe(1);
      expect(cache.get(-1009876543210, 8)?.is_deleted).toBe(0);
    });

    it("leaves a channel post that is the only cached message with the ID", () => {
      cacheMessage(7, [-1001234567890]);

      expect(cache.markDeletedByMessageIds([7])).toEqual({
        deleted: 0,
        ambiguous: [],
      });
      expect(cache.get(-1001234567890, 7)?.is_deleted).toBe(0);
    });

    it("leaves a channel post when the private message with the ID is already marked", () => {
      cacheMessage(7, [4242, -1001234567890]);
      cache.markDeleted(4242, [7]);

      expect(cache.markDeletedByMessageIds([7])).toEqual({
        deleted: 0,
        ambiguous: [],
      });
      expect(cache.get(4242, 7)?.is_deleted).toBe(1);
      expect(cache.get(-1001234567890, 7)?.is_deleted).toBe(0);
    });

    it("marks the unique ID and reports the ambiguous one of the same delete once", () => {
      cacheMessage(7, [4242, -5151]);
      cache.upsert(message(4242, 8));

      expect(cache.markDeletedByMessageIds([7, 8, 7])).toEqual({
        deleted: 1,
        ambiguous: [{ messageId: 7, chatIds: [-5151, 4242] }],
      });
      expect(cache.get(4242, 8)?.is_deleted).toBe(1);
      expect(cache.get(4242, 7)?.is_deleted).toBe(0);
      expect(cache.get(-5151, 7)?.is_deleted).toBe(0);
    });
  });
});

describe("MessagesCache writes and the search index", () => {
  let db: Database;
  let cache: MessagesCache;

  const message: MessageInput = {
    chat_id: 100,
    message_id: 1,
    from_id: 123,
    text: "harbor notes",
    message_type: "text",
    date: 1_700_000_000,
    raw_json: '{"_":"message","views":10}',
  };

  const totalChanges = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
  const find = (query: string) =>
    createMessagesSearch(db)
      .search(query, { includeDeleted: true })
      .map((row) => row.message_id);
  const renameSender = (lastName: string) =>
    createUsersCache(db).upsert({
      user_id: "123",
      first_name: "Ann",
      last_name: lastName,
      fetched_at: 1_000,
      raw_json: "{}",
    });

  beforeEach(() => {
    setSystemTime(new Date("2026-01-01T00:00:00Z"));
    db = createAccountCacheDb();
    cache = createMessagesCache(db);
    renameSender("Archer");
    cache.upsert(message);
  });

  afterEach(() => {
    setSystemTime();
    db.close();
  });

  it("leaves an unchanged message fetched again and its index row alone", () => {
    const before = cache.get(100, 1);
    renameSender("Baker");
    const changes = totalChanges();

    setSystemTime(new Date("2026-01-02T00:00:00Z"));
    cache.upsert(message);
    cache.upsertBatch([message]);

    expect(totalChanges()).toBe(changes);
    expect(cache.get(100, 1)).toEqual(before);
    expect(find("Archer")).toEqual([1]);
    expect(find("Baker")).toEqual([]);
  });

  it("updates a message whose raw_json changed without re-indexing it", () => {
    renameSender("Baker");
    const changes = totalChanges();

    setSystemTime(new Date("2026-01-02T00:00:00Z"));
    cache.upsert({ ...message, raw_json: '{"_":"message","views":11}' });

    expect(totalChanges()).toBe(changes + 1);
    expect(cache.get(100, 1)).toMatchObject({
      raw_json: '{"_":"message","views":11}',
      updated_at: Date.parse("2026-01-02T00:00:00Z"),
      fetched_at: Date.parse("2026-01-02T00:00:00Z"),
    });
    expect(find("Archer")).toEqual([1]);
    expect(find("Baker")).toEqual([]);
  });

  it("re-indexes an edited message", () => {
    renameSender("Baker");

    cache.upsert({ ...message, text: "lighthouse notes", is_edited: true });

    expect(find("lighthouse")).toEqual([1]);
    expect(find("harbor")).toEqual([]);
    expect(find("Baker")).toEqual([1]);
  });

  it("re-indexes a message whose sender changed", () => {
    cache.upsert({ ...message, from_id: 456 });

    expect(find("Archer")).toEqual([]);
    expect(find("456")).toEqual([1]);
  });

  it("stores and indexes the text of a rich message, which has none of its own", () => {
    const raw = richTlMessage({ _: "peerUser", userId: 100 }, 2, REPORT_BLOCKS);
    cache.upsert({
      ...message,
      message_id: 2,
      text: "",
      raw_json: toRawJson(raw),
    });

    expect(cache.get(100, 2)?.text).toBe(REPORT_TEXT);
    expect(find("zucchini")).toEqual([2]);
  });

  it("does not re-index a message marked deleted", () => {
    renameSender("Baker");
    const changes = totalChanges();

    cache.markDeleted(100, [1]);

    expect(totalChanges()).toBe(changes + 1);
    expect(cache.get(100, 1)?.is_deleted).toBe(1);
    expect(find("Archer")).toEqual([1]);
    expect(find("Baker")).toEqual([]);
  });
});
