import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLazyClient } from "./helpers";
import {
  type FilteredCoverage,
  type HistoryChat,
  type HistoryWindow,
  type ListHistoryResult,
  listHistory,
  readFilteredPage,
} from "./history";
import { createChatsCache } from "../../db/chats-cache";
import { createHistoryRanges } from "../../db/history-ranges";
import { createMessagesCache } from "../../db/messages-cache";
import type { MessageFilter } from "../../db/messages-history";
import { initCacheSchema } from "../../db/schema";
import { initSyncSchema } from "../../db/sync-schema";
import { toLong } from "../../utils/long";
import { chatRow, createAccountCacheDb } from "../../test/cache-db.test-utils";
import { takePartIn } from "../../test/participation.test-utils";

const CHAT_RAW_ID = 1_555_000_031;
const CHAT_ID = -1_001_555_000_031;
const DATE = 1_760_000_000;
const MAX_ID = 2_147_483_647;

const CHAT: HistoryChat = {
  chatId: CHAT_ID,
  inputPeer: {
    _: "inputPeerChannel",
    channelId: CHAT_RAW_ID,
    accessHash: toLong("3131"),
  },
};

const VOICE = { types: ["voice"] };

type Page = ListHistoryResult & FilteredCoverage;

interface Row {
  id: number;
  date?: number;
  type?: string;
  rawJson?: string;
  hasMedia?: boolean;
}

function cache(db: Database, rows: Row[]) {
  createMessagesCache(db).upsertBatch(
    rows.map(({ id, date, type = "voice", rawJson, hasMedia }) => ({
      chat_id: CHAT_ID,
      message_id: id,
      from_id: 10,
      text: null,
      message_type: type,
      has_media: hasMedia ?? type !== "text",
      date: date ?? DATE + id,
      raw_json: rawJson ?? JSON.stringify({ _: "message", id }),
    })),
  );
}

function cover(db: Database, low: number, high: number) {
  createHistoryRanges(db).add(CHAT_ID, { low, high });
}

function list(db: Database, window: HistoryWindow, filter: MessageFilter = VOICE) {
  return listHistory({
    cacheDb: db,
    client: createLazyClient(() => {
      throw new Error("a filtered read must not reach Telegram");
    }),
    chat: CHAT,
    window,
    includeDeleted: false,
    fresh: false,
    filter,
  }) as Promise<Page>;
}

const ids = (page: Page) => page.items.map((item) => item.messageId);

describe("filtered list coverage", () => {
  let db: Database;

  beforeEach(() => {
    db = createAccountCacheDb();
    takePartIn(db, CHAT_ID);
  });

  afterEach(() => {
    db.close();
  });

  it("is incomplete below the newest message the dialog list knows", async () => {
    cache(db, [{ id: 1 }]);
    cover(db, 1, 1);
    createChatsCache(db).upsert(chatRow(CHAT_ID, "supergroup", { last_message_id: 3 }));

    const page = await list(db, { limit: 20, after: 1 });

    expect(page).toMatchObject({
      items: [],
      complete: false,
      missing: ["history"],
      missingBefore: null,
    });
  });

  it("is incomplete below the newest message the sync state knows", async () => {
    cache(db, [{ id: 1 }]);
    cover(db, 1, 1);
    db.run(
      "INSERT INTO chat_sync_state (chat_id, chat_type, top_message_id) VALUES (?, 'supergroup', 3)",
      [CHAT_ID],
    );

    const page = await list(db, { limit: 20 });

    expect(ids(page)).toEqual([1]);
    expect(page).toMatchObject({ complete: false, missingBefore: null });
  });

  it.each<[string, Row[], Row, MessageFilter, number[], number[]]>([
    [
      "out of order",
      [
        { id: 1, date: DATE + 100 },
        { id: 3, date: DATE + 50 },
      ],
      { id: 2, date: DATE + 90 },
      { since: DATE + 80 },
      [1],
      [2, 1],
    ],
    [
      "in order before --since",
      [
        { id: 1, date: DATE + 100 },
        { id: 3, date: DATE + 130 },
      ],
      { id: 2, date: DATE + 180 },
      { since: DATE + 150 },
      [],
      [2],
    ],
    [
      "in order after --until",
      [
        { id: 1, date: DATE + 130 },
        { id: 3, date: DATE + 140 },
      ],
      { id: 2, date: DATE + 110 },
      { until: DATE + 120 },
      [],
      [2],
    ],
  ])(
    "keeps a gap in a date window open whatever the cached dates around it, %s",
    async (_name, around, missing, filter, gapped, filled) => {
      cache(db, around);
      cover(db, 1, 1);
      cover(db, 3, 3);

      const page = await list(db, { limit: 20 }, filter);
      expect(ids(page)).toEqual(gapped);
      expect(page).toMatchObject({ complete: false, missingBefore: 3 });

      cache(db, [missing]);
      cover(db, 1, 3);
      const whole = await list(db, { limit: 20 }, filter);
      expect(ids(whole)).toEqual(filled);
      expect(whole.complete).toBe(true);
    },
  );

  it("is complete for a chat the dialog list shows empty", async () => {
    createChatsCache(db).upsert(chatRow(CHAT_ID, "supergroup", { last_message_id: 0 }));

    expect(await list(db, { limit: 20 })).toMatchObject({
      items: [],
      complete: true,
      missing: [],
    });
  });

  it("is complete below message 1 whatever the cache holds", async () => {
    expect(await list(db, { limit: 20, before: 1 })).toMatchObject({
      items: [],
      complete: true,
    });
  });

  it("points at the newest page, not past the largest ID, for a gap at the top", async () => {
    cache(db, [{ id: MAX_ID }]);

    const page = await list(db, { limit: 20 });

    expect(page).toMatchObject({ complete: false, missingBefore: null });
  });

  it("is incomplete for --type while a media row waits for its raw message", async () => {
    cache(db, [
      { id: 1, type: "text" },
      { id: 2, type: "video", rawJson: "{}" },
      { id: 3, type: "text" },
    ]);
    cover(db, 1, 3);

    expect(await list(db, { limit: 20 }, { types: ["round"] })).toMatchObject({
      items: [],
      complete: false,
      missing: ["types"],
    });
    expect((await list(db, { limit: 20 }, { since: DATE })).complete).toBe(true);
  });

  it.each<[string, MessageFilter, number]>([
    ["--since", { since: DATE + 150 }, 1],
    ["--until", { until: DATE + 150 }, 3],
  ])(
    "is incomplete for --type while a row in the %s window waits, whatever the dates around it",
    async (_name, window, awaiting) => {
      cache(
        db,
        [180, 120, 100].map((date, i) =>
          i + 1 === awaiting
            ? { id: i + 1, date: DATE + date, type: "video", rawJson: "{}" }
            : { id: i + 1, date: DATE + date, type: "text" },
        ),
      );
      cover(db, 1, 3);

      expect(await list(db, { limit: 20 }, { types: ["round"], ...window })).toMatchObject({
        items: [],
        complete: false,
        missing: ["types"],
      });
    },
  );

  it("ignores a media row waiting for its raw message that the page leaves out", async () => {
    cache(db, [
      { id: 1, type: "text" },
      { id: 2, type: "video", rawJson: "{}" },
      { id: 3, type: "video", rawJson: "{}", date: DATE - 100 },
      { id: 4, type: "text" },
    ]);
    cover(db, 1, 4);
    db.run("UPDATE messages_cache SET is_deleted = 1 WHERE chat_id = ? AND message_id = 2", [
      CHAT_ID,
    ]);

    expect(await list(db, { limit: 20 }, { types: ["round"], since: DATE })).toMatchObject({
      items: [],
      complete: true,
      missing: [],
    });
  });

  it("marks a gap it can not fill in a group the account left", async () => {
    cache(db, [{ id: 1 }, { id: 5 }]);
    cover(db, 1, 1);
    db.run("UPDATE group_participation SET last_own_date = NULL WHERE chat_id = ?", [CHAT_ID]);

    const { page, gap } = readFilteredPage(db, CHAT_ID, { limit: 20 }, false, VOICE);

    expect(page).toMatchObject({ complete: false, missing: ["history"] });
    expect(gap).toEqual({ low: 2, high: 5, before: null, fillable: false });
  });

  it("marks a gap it can not fill from a time the account didn't take part", async () => {
    cache(db, [{ id: 1 }, { id: 5 }, { id: 9 }]);
    cover(db, 1, 1);
    cover(db, 5, 5);
    cover(db, 9, 9);
    db.run("INSERT INTO group_capture_gaps (chat_id, start_date, end_date) VALUES (?, ?, ?)", [
      CHAT_ID,
      DATE + 6,
      DATE + 7,
    ]);

    const read = (before: number) =>
      readFilteredPage(db, CHAT_ID, { limit: 20, before }, false, VOICE).gap;

    expect(read(9)).toEqual({ low: 6, high: 8, before: 9, fillable: false });
    expect(read(5)).toEqual({ low: 2, high: 4, before: 5, fillable: true });
  });
});

describe("filtered list snapshot", () => {
  let dir: string;
  let db: Database;
  let writer: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-list-snapshot-"));
    const path = join(dir, "cache.db");
    db = new Database(path);
    db.run("PRAGMA journal_mode = WAL");
    initCacheSchema(db);
    initSyncSchema(db);
    takePartIn(db, CHAT_ID);
    writer = new Database(path);
  });

  afterEach(() => {
    writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function interleaved(hook: () => void) {
    let fired = false;
    const wrap = <T extends object>(statement: T, sql: string) =>
      new Proxy(statement, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function" || prop !== "all") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            if (!fired && sql.includes("FROM messages_cache m")) {
              fired = true;
              hook();
            }
            return result;
          };
        },
      });
    return new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop === "query" || prop === "prepare") {
          return (sql: string) => wrap(value.call(target, sql), sql);
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("reads the rows and their coverage in one snapshot", async () => {
    cache(db, [{ id: 1 }, { id: 3 }]);
    cover(db, 1, 1);
    cover(db, 3, 3);

    const racing = interleaved(() => {
      cache(writer, [{ id: 2 }]);
      cover(writer, 1, 3);
    });
    const raced = await list(racing, { limit: 20 });
    expect(ids(raced)).toEqual([3, 1]);
    expect(raced.complete).toBe(false);

    const after = await list(db, { limit: 20 });
    expect(ids(after)).toEqual([3, 2, 1]);
    expect(after.complete).toBe(true);
  });
});
