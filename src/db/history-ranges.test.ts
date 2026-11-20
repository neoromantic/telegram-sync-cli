import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  createHistoryRanges,
  type HistoryRange,
  type HistoryRanges,
  type PageBounds,
} from "./history-ranges";
import { createChatsCache } from "./chats-cache";
import { createMessagesCache } from "./messages-cache";
import { chatRow, createAccountCacheDb } from "../test/cache-db.test-utils";
import { takePartIn } from "../test/participation.test-utils";

const CHAT_ID = -1001234567890;
const OTHER_CHAT_ID = 10;

describe("HistoryRanges", () => {
  let db: Database;
  let ranges: HistoryRanges;

  beforeEach(() => {
    db = createAccountCacheDb();
    ranges = createHistoryRanges(db);
  });

  afterEach(() => {
    db.close();
  });

  function stored(chatId = CHAT_ID) {
    return db
      .query("SELECT low, high FROM history_ranges WHERE chat_id = ? ORDER BY low")
      .all(chatId) as HistoryRange[];
  }

  describe("add", () => {
    it.each<[string, HistoryRange[], HistoryRange[]]>([
      [
        "keeps apart ranges with a gap",
        [
          { low: 1, high: 5 },
          { low: 7, high: 9 },
        ],
        [
          { low: 1, high: 5 },
          { low: 7, high: 9 },
        ],
      ],
      [
        "merges touching ranges",
        [
          { low: 1, high: 5 },
          { low: 6, high: 9 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        "merges overlapping ranges",
        [
          { low: 1, high: 5 },
          { low: 3, high: 9 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        "bridges ranges on both sides",
        [
          { low: 1, high: 3 },
          { low: 7, high: 9 },
          { low: 4, high: 6 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        "ignores empty and invalid ranges",
        [
          { low: 5, high: 4 },
          { low: 0, high: 3 },
          { low: Number.POSITIVE_INFINITY, high: 8 },
        ],
        [],
      ],
    ])("%s", (_name, added, expected) => {
      for (const range of added) ranges.add(CHAT_ID, range);

      expect(stored()).toEqual(expected);
    });

    it("keeps chats apart", () => {
      ranges.add(CHAT_ID, { low: 1, high: 5 });
      ranges.add(OTHER_CHAT_ID, { low: 6, high: 9 });

      expect(stored(CHAT_ID)).toEqual([{ low: 1, high: 5 }]);
      expect(stored(OTHER_CHAT_ID)).toEqual([{ low: 6, high: 9 }]);
    });
  });

  describe("find", () => {
    it("returns the range that holds the message ID", () => {
      ranges.add(CHAT_ID, { low: 10, high: 20 });

      expect(ranges.find(CHAT_ID, 10)).toEqual({ low: 10, high: 20 });
      expect(ranges.find(CHAT_ID, 20)).toEqual({ low: 10, high: 20 });
      expect(ranges.find(CHAT_ID, 9)).toBeNull();
      expect(ranges.find(CHAT_ID, 21)).toBeNull();
      expect(ranges.find(OTHER_CHAT_ID, 15)).toBeNull();
    });
  });

  describe("recordPage", () => {
    it.each<[string, number[], PageBounds, HistoryRange[]]>([
      ["counts empty messages, but not IDs of 0", [12, 0, 10], {}, [{ low: 10, high: 12 }]],
      ["covers from just above after", [8, 9], { after: 5 }, [{ low: 6, high: 9 }]],
      [
        "covers down to message 1 when the page reached the start",
        [4, 3],
        { reachedStart: true },
        [{ low: 1, high: 4 }],
      ],
    ])("%s", (_name, ids, bounds, expected) => {
      ranges.recordPage(CHAT_ID, ids, bounds);

      expect(stored()).toEqual(expected);
    });

    it.each<[string, number[], PageBounds, HistoryRange[]]>([
      [
        "vouches up to before for a message known before the request",
        [10, 1],
        { before: 21, reachedStart: true, knownTop: 30 },
        [{ low: 1, high: 20 }],
      ],
      [
        "vouches only up to the message known before the request",
        [10, 1],
        { before: 21, reachedStart: true, knownTop: 15 },
        [{ low: 1, high: 15 }],
      ],
      [
        "stops at the newest message below before when nothing newer was known",
        [21, 17],
        { before: 40, knownTop: 21 },
        [{ low: 17, high: 21 }],
      ],
      [
        "settles an empty page below before",
        [],
        { before: 21, reachedStart: true, knownTop: 30 },
        [{ low: 1, high: 20 }],
      ],
      [
        "records nothing for an empty page below before when nothing was known",
        [],
        { before: 40, reachedStart: true, knownTop: null },
        [],
      ],
      [
        "vouches for the newest page up to the known top",
        [10, 1],
        { reachedStart: true, knownTop: 30 },
        [{ low: 1, high: 30 }],
      ],
      [
        "records an empty newest page as a chat without messages",
        [],
        { reachedStart: true, knownTop: null },
        [{ low: 1, high: 0 }],
      ],
      [
        "vouches for a short forward page up to before",
        [12],
        { after: 10, before: 21, knownTop: 30 },
        [{ low: 11, high: 20 }],
      ],
    ])("%s", (_name, ids, bounds, expected) => {
      ranges.recordPage(CHAT_ID, ids, bounds);

      expect(stored()).toEqual(expected);
    });

    it("lets no message cached after the request vouch for the page", () => {
      takePartIn(db, CHAT_ID);
      createMessagesCache(db).upsertBatch([
        {
          chat_id: CHAT_ID,
          message_id: 30,
          from_id: 10,
          text: "arrived during the request",
          message_type: "text",
          date: 1_760_000_030,
          raw_json: "{}",
        },
      ]);

      ranges.recordPage(CHAT_ID, [10, 1], { before: 21, reachedStart: true, knownTop: 10 });
      ranges.recordPage(CHAT_ID, [10, 1], { before: 21, reachedStart: true });

      expect(ranges.knownTop(CHAT_ID)).toBe(30);
      expect(stored()).toEqual([{ low: 1, high: 10 }]);
    });

    it("merges a chat recorded empty with its first page", () => {
      ranges.recordPage(CHAT_ID, [], { reachedStart: true, knownTop: null });
      ranges.recordPage(CHAT_ID, [2, 1], { reachedStart: true, knownTop: 0 });

      expect(stored()).toEqual([{ low: 1, high: 2 }]);
      expect(ranges.find(CHAT_ID, 1)).toEqual({ low: 1, high: 2 });
    });
  });

  describe("knownTop", () => {
    it("is the highest of the cached messages, the dialog, the sync state and the ranges", () => {
      expect(ranges.knownTop(CHAT_ID)).toBeNull();

      ranges.add(CHAT_ID, { low: 1, high: 0 });
      expect(ranges.knownTop(CHAT_ID)).toBe(0);

      createChatsCache(db).upsert(chatRow(CHAT_ID, "supergroup", { last_message_id: 30 }));
      expect(ranges.knownTop(CHAT_ID)).toBe(30);

      db.run(
        "INSERT INTO chat_sync_state (chat_id, chat_type, top_message_id) VALUES (?, 'supergroup', 40)",
        [CHAT_ID],
      );
      expect(ranges.knownTop(CHAT_ID)).toBe(40);

      ranges.add(CHAT_ID, { low: 1, high: 45 });
      expect(ranges.knownTop(CHAT_ID)).toBe(45);
      expect(ranges.knownTop(OTHER_CHAT_ID)).toBeNull();
    });
  });
});
