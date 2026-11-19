import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessagesCache } from "./messages-cache";
import { createMessagesSearch } from "./messages-search";
import { initCacheSchema } from "./schema";
import {
  determineSyncPolicy,
  initSyncSchema,
  isContentlessSearch,
  type SyncPolicy,
  type SyncPolicyReason,
  SyncPriority,
} from "./sync-schema";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

describe("messages_cache indexes", () => {
  it("indexes message_id for deletes without chat context", () => {
    const db = createAccountCacheDb();
    const plan = db
      .query(
        "EXPLAIN QUERY PLAN SELECT chat_id FROM messages_cache WHERE message_id = ? AND is_deleted = 0",
      )
      .all(7) as Array<{ detail: string }>;
    expect(
      plan.some((step) => step.detail.includes("USING INDEX idx_messages_cache_message_id")),
    ).toBe(true);
  });
});

describe("determineSyncPolicy", () => {
  const high = { priority: SyncPriority.High, enabled: true, history: true };
  const medium = { priority: SyncPriority.Medium, enabled: true, history: true };
  const firstPageOnly = {
    priority: SyncPriority.Medium,
    enabled: true,
    history: false,
  };
  const off = { priority: SyncPriority.Low, enabled: false, history: false };
  const policy = (tier: Omit<SyncPolicy, "reason">, reason: SyncPolicyReason) => ({
    ...tier,
    reason,
  });

  it("syncs private chats in full", () => {
    expect(determineSyncPolicy("private")).toEqual(policy(high, "dm"));
  });

  it("gives bots and deleted accounts the newest page only (#131)", () => {
    expect(determineSyncPolicy("private", null, { bot: true })).toEqual(
      policy(firstPageOnly, "bot"),
    );
    expect(determineSyncPolicy("private", null, { deleted: true })).toEqual(
      policy(firstPageOnly, "deleted_account"),
    );
    expect(determineSyncPolicy("private", null, { bot: false, deleted: false })).toEqual(
      policy(high, "dm"),
    );
  });

  it("treats a group of unknown size as large", () => {
    const unknown = policy(off, "unknown_size");
    for (const type of ["group", "supergroup"] as const) {
      expect(determineSyncPolicy(type)).toEqual(unknown);
      expect(determineSyncPolicy(type, undefined)).toEqual(unknown);
      expect(determineSyncPolicy(type, null)).toEqual(unknown);
      expect(determineSyncPolicy(type, 0)).toEqual(unknown);
    }
  });

  it("syncs groups under 20 members in full", () => {
    const small = policy(high, "small_group");
    expect(determineSyncPolicy("group", 1)).toEqual(small);
    expect(determineSyncPolicy("supergroup", 19)).toEqual(small);
  });

  it("gives groups of 20 to 100 members the medium tier", () => {
    const group = policy(medium, "medium_group");
    expect(determineSyncPolicy("group", 20)).toEqual(group);
    expect(determineSyncPolicy("supergroup", 100)).toEqual(group);
  });

  it("leaves groups over 100 members and channels off", () => {
    expect(determineSyncPolicy("supergroup", 101)).toEqual(policy(off, "large_group"));
    expect(determineSyncPolicy("channel")).toEqual(policy(off, "channel"));
    expect(determineSyncPolicy("channel", 10)).toEqual(policy(off, "channel"));
  });

  it("leaves communities off", () => {
    const community = policy(off, "community");
    expect(determineSyncPolicy("community")).toEqual(community);
    expect(determineSyncPolicy("community", 10)).toEqual(community);
  });
});

describe("migration from 0.1.4", () => {
  const CHAT_SYNC_STATE_0_1_4 = `
    CREATE TABLE chat_sync_state (
      chat_id           INTEGER PRIMARY KEY,
      chat_type         TEXT NOT NULL,
      member_count      INTEGER,
      forward_cursor    INTEGER,
      backward_cursor   INTEGER,
      sync_priority     INTEGER NOT NULL DEFAULT 3,
      sync_enabled      INTEGER NOT NULL DEFAULT 0,
      history_complete  INTEGER DEFAULT 0,
      total_messages    INTEGER,
      synced_messages   INTEGER DEFAULT 0,
      last_forward_sync INTEGER,
      last_backward_sync INTEGER,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `;

  const SYNC_JOBS_0_1_4 = `
    CREATE TABLE sync_jobs (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id           INTEGER NOT NULL,
      job_type          TEXT NOT NULL,
      priority          INTEGER NOT NULL DEFAULT 3,
      status            TEXT NOT NULL DEFAULT 'pending',
      cursor_start      INTEGER,
      cursor_end        INTEGER,
      messages_fetched  INTEGER DEFAULT 0,
      error_message     TEXT,
      created_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      started_at        INTEGER,
      completed_at      INTEGER
    )
  `;

  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-sync-schema-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function createOldDatabase(path: string) {
    const db = new Database(path);
    initCacheSchema(db);
    db.run(CHAT_SYNC_STATE_0_1_4);
    db.run(`
      INSERT INTO chat_sync_state
        (chat_id, chat_type, forward_cursor, backward_cursor, sync_priority, sync_enabled, synced_messages)
      VALUES (42, 'private', 1000, 1, 1, 1, 1000)
    `);
    db.run(SYNC_JOBS_0_1_4);
    db.run(`
      INSERT INTO sync_jobs (chat_id, job_type, priority, status, error_message, completed_at)
      VALUES
        (42, 'backward_history', 1, 'pending', NULL, NULL),
        (42, 'forward_catchup', 0, 'failed', 'Rate limited: wait 30s', 1700000000000)
    `);
    return db;
  }

  const jobsOf = (db: Database) =>
    db.prepare("SELECT id, status, attempts, next_run_at FROM sync_jobs ORDER BY id").all();
  const columnsOf = (db: Database, table: string) =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((col) => col.name);

  const schemaOf = (db: Database) =>
    db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  const rowOf = (db: Database) =>
    db.prepare("SELECT * FROM chat_sync_state WHERE chat_id = 42").get();

  it("gives a 0.1.4 cache the columns of a new one, keeps its rows and makes its jobs due", () => {
    const db = createOldDatabase(join(dir, "cache.db"));

    initSyncSchema(db);

    const fresh = createAccountCacheDb();
    for (const table of ["chat_sync_state", "sync_jobs"]) {
      expect(columnsOf(db, table)).toEqual(columnsOf(fresh, table));
    }
    fresh.close();
    expect(rowOf(db)).toMatchObject({
      chat_id: 42,
      forward_cursor: 1000,
      backward_cursor: 1,
      sync_enabled: 1,
      synced_messages: 1000,
      top_message_id: null,
      sync_mode: "auto",
    });
    const jobs = [
      { id: 1, status: "pending", attempts: 0, next_run_at: 0 },
      { id: 2, status: "failed", attempts: 0, next_run_at: 0 },
    ];
    expect(jobsOf(db)).toEqual(jobs);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_jobs_lane'",
        )
        .get(),
    ).toEqual({ name: "idx_sync_jobs_lane" });

    const schema = schemaOf(db);
    const row = rowOf(db);
    initSyncSchema(db);
    expect(schemaOf(db)).toEqual(schema);
    expect(rowOf(db)).toEqual(row);
    expect(jobsOf(db)).toEqual(jobs);
    db.close();
  });
});

describe("contentless message_search", () => {
  const searchSql = (db: Database) =>
    (
      db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_search'")
        .get() as { sql: string }
    ).sql;
  const searchMeta = (db: Database) =>
    db
      .query("SELECT value, updated_at FROM search_meta WHERE key = 'search_index_version'")
      .get() as { value: string; updated_at: number };
  const triggers = (db: Database) =>
    (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_cache_a%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  const find = (db: Database, query: string) =>
    (createMessagesSearch(db).search(query) as Array<{ message_id: number }>).map(
      (row) => row.message_id,
    );

  function seed(db: Database, ids: number[], word = "lighthouse") {
    createMessagesCache(db).upsertBatch(
      ids.map((id) => ({
        chat_id: 4242,
        message_id: id,
        text: `${word} note ${id}`,
        message_type: "text",
        date: 1_700_000_000 + id,
        raw_json: "{}",
      })),
    );
  }

  function openCache(contentlessSearch?: boolean) {
    const db = new Database(":memory:");
    initCacheSchema(db);
    initSyncSchema(db, { contentlessSearch });
    return db;
  }

  it("creates a new cache with a contentless index, or a regular one when asked", () => {
    const contentless = openCache();
    expect(searchSql(contentless)).toContain("contentless_delete=1");
    expect(isContentlessSearch(contentless)).toBe(true);

    const regular = openCache(false);
    expect(searchSql(regular)).not.toContain("contentless_delete");
    expect(isContentlessSearch(regular)).toBe(false);
  });

  it("moves a cache with the full-content index to the contentless one once", () => {
    const db = openCache(false);
    seed(db, [1, 2, 3]);
    db.run("UPDATE search_meta SET updated_at = 0 WHERE key = 'search_index_version'");

    initSyncSchema(db);

    expect(isContentlessSearch(db)).toBe(true);
    expect(searchMeta(db).value).toBe("1");
    const migratedAt = searchMeta(db).updated_at;
    expect(migratedAt).toBeGreaterThan(0);
    expect(find(db, "lighthouse")).toEqual([3, 2, 1]);

    initSyncSchema(db);
    expect(searchMeta(db).updated_at).toBe(migratedAt);
  });

  it("on an older SQLite drops only the triggers, and a newer one rebuilds the index", () => {
    const db = openCache();
    seed(db, [1, 2]);

    initSyncSchema(db, { contentlessSearch: false });

    expect(triggers(db)).toEqual([]);
    expect(searchMeta(db).value).toBe("0");
    expect(isContentlessSearch(db)).toBe(true);
    seed(db, [3]);
    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM messages_cache").get() as {
          n: number;
        }
      ).n,
    ).toBe(3);

    initSyncSchema(db);

    expect(triggers(db)).toEqual(["messages_cache_ad", "messages_cache_ai", "messages_cache_au"]);
    expect(searchMeta(db).value).toBe("1");
    expect(find(db, "lighthouse")).toEqual([3, 2, 1]);
  });
});

describe("messages_cache writes on a cache from 0.5.0", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-sync-schema-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const OLD_UPDATE_TRIGGER = `
    CREATE TRIGGER messages_cache_au
    AFTER UPDATE ON messages_cache
    BEGIN
      DELETE FROM message_search WHERE rowid = old.rowid;
      INSERT INTO message_search(rowid, text, sender, chat, files)
      VALUES (new.rowid, COALESCE(new.text, ''), '', '', '');
    END
  `;
  const schemaOf = (db: Database) =>
    db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
  const triggerSql = (db: Database) =>
    (
      db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_cache_au'",
        )
        .get() as { sql: string }
    ).sql;
  const hasFetchedIndex = (db: Database) =>
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_cache_fetched'",
      )
      .get() !== null;
  const find = (db: Database, query: string) =>
    createMessagesSearch(db)
      .search(query)
      .map((row) => row.message_id);

  const harborNotes = {
    chat_id: 4242,
    message_id: 7,
    text: "harbor notes",
    message_type: "text",
    date: 1_700_000_000,
    raw_json: "{}",
  };

  function oldCache(path: string, contentlessSearch: boolean) {
    const old = new Database(path);
    initCacheSchema(old);
    initSyncSchema(old, { contentlessSearch });
    old.run("DROP TRIGGER messages_cache_au");
    old.run(OLD_UPDATE_TRIGGER);
    old.run("CREATE INDEX idx_messages_cache_fetched ON messages_cache(fetched_at)");
    createMessagesCache(old).upsert(harborNotes);
    old.close();
  }

  for (const contentlessSearch of [true, false]) {
    it(`gets the new trigger and loses the fetched_at index once (${contentlessSearch ? "contentless" : "full-content"} index)`, () => {
      const path = join(dir, "cache.db");
      oldCache(path, contentlessSearch);

      const db = new Database(path);
      initCacheSchema(db);
      initSyncSchema(db, { contentlessSearch });

      expect(triggerSql(db)).toContain(
        "AFTER UPDATE OF text, from_id, media_path ON messages_cache",
      );
      expect(hasFetchedIndex(db)).toBe(false);
      expect(isContentlessSearch(db)).toBe(contentlessSearch);
      expect(find(db, "harbor")).toEqual([7]);

      const cache = createMessagesCache(db);
      const changes = () => (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
      const before = changes();
      cache.upsert({ ...harborNotes, raw_json: '{"views":1}' });
      expect(changes()).toBe(before + 1);
      cache.updateText(4242, 7, "lighthouse notes", 1_700_000_100);
      expect(find(db, "lighthouse")).toEqual([7]);
      expect(find(db, "harbor")).toEqual([]);

      const schema = schemaOf(db);
      db.close();

      const again = new Database(path, { readonly: true });
      initCacheSchema(again);
      initSyncSchema(again, { contentlessSearch });
      expect(schemaOf(again)).toEqual(schema);
      again.close();
    });
  }
});
