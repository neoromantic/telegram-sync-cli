import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySyncMode } from "../commands/chats/sync";
import { readMigrationStatus } from "./background-migrations";
import { checkCacheOwner } from "./cache-meta";
import { PEER_ID_USER_VERSION } from "./peer-id-migration";
import { initCacheSchema } from "./schema";
import { initSyncSchema } from "./sync-schema";
import { seedLegacyCache } from "../test/legacy-cache.test-utils";
import { seedOldFormCache } from "../test/old-form-cache.test-utils";
import { assertPeerIdInvariants } from "../test/peer-id-invariants.test-utils";
import { seedInChild } from "../test/seed-in-child.test-utils";

const SCHEMA_MODULE = join(import.meta.dir, "schema.ts");
const SYNC_SCHEMA_MODULE = join(import.meta.dir, "sync-schema.ts");
const DB_MODULE = join(import.meta.dir, "index.ts");

const INIT_SCHEMA = `
  import { Database } from 'bun:sqlite'
  const { initCacheSchema } = await import(process.env.SCHEMA_MODULE)
  const { initSyncSchema } = await import(process.env.SYNC_SCHEMA_MODULE)
  const db = new Database(process.env.LOCK_DB_PATH)
  initCacheSchema(db)
  console.log('opening')
  initSyncSchema(db)
  db.close()
`;

const BUILD_INDEX = `
  import { Database } from 'bun:sqlite'
  const { initCacheSchema } = await import(process.env.SCHEMA_MODULE)
  const { initSyncSchema } = await import(process.env.SYNC_SCHEMA_MODULE)
  const db = new Database(process.env.LOCK_DB_PATH)
  initCacheSchema(db)
  db.run('PRAGMA busy_timeout = 0')
  console.log('waiting')
  initSyncSchema(db)
  console.log('busy_timeout ' + db.query('PRAGMA busy_timeout').get().timeout)
`;

const RETRY_OPEN = `
  import { Database } from 'bun:sqlite'
  const { accountsDb, getAccountCacheDb } = await import(process.env.DB_MODULE)
  accountsDb.create({ phone: '+15550000001', is_active: true })
  try {
    getAccountCacheDb(1)
    console.log('first open: ok')
  } catch (err) {
    console.log('first open: ' + err.message)
  }
  const other = new Database(process.env.LOCK_DB_PATH)
  other.run('DROP TRIGGER fail_rekey')
  other.close()
  const db = getAccountCacheDb(1)
  console.log('second open: ' + db.query('PRAGMA user_version').get().user_version)
`;

const OPEN_ACCOUNT_CACHE = `
  const { getAccountCacheDb } = await import(process.env.DB_MODULE)
  try {
    const db = getAccountCacheDb(1)
    const row = db.query('SELECT COUNT(*) AS count FROM chats_cache').get()
    console.log('chats: ' + row.count)
  } catch (err) {
    console.log((err.reason ?? 'error') + ': ' + err.message)
  }
`;

function seedSharedCache(path: string) {
  rmSync(path, { force: true });
  for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, { force: true });
  seedInChild(path, "legacySharedCache");
}

function seedAccounts(dir: string, count: number) {
  const data = new Database(join(dir, "data.db"));
  data.run("PRAGMA journal_mode = WAL");
  data.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      name TEXT,
      username TEXT,
      label TEXT,
      session_data TEXT NOT NULL DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  for (let i = 1; i <= count; i++) {
    data.run("INSERT INTO accounts (phone, is_active) VALUES (?, ?)", [
      `+1555000000${i}`,
      i === 1 ? 1 : 0,
    ]);
  }
  data.close();
}

function listCacheFiles(dir: string) {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => /cache[^/]*\.db$/.test(name))
    .sort();
}

function spawnBun(script: string, env: Record<string, string>) {
  return Bun.spawn(["bun", "--no-env-file", "-e", script], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForLine(stream: ReadableStream<Uint8Array>, line: string) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(line)) return;
  }
  throw new Error(`stream ended before "${line}"`);
}

async function stdoutAfter(child: ReturnType<typeof spawnBun>, line: string, then: () => void) {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of child.stdout) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes(line)) then();
  }
  return text;
}

function holdWriteLock(path: string) {
  const holder = new Database(path);
  holder.run("BEGIN IMMEDIATE");
  holder.run("INSERT INTO daemon_status (key, value) VALUES ('holder', '1')");
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      holder.run("COMMIT");
      holder.close();
    },
  };
}

describe("cache database lock", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tg-cache-lock-"));
    path = join(dir, "cache.db");
    const db = new Database(path);
    initCacheSchema(db);
    initSyncSchema(db);
    db.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets tg chats sync wait for the write lock instead of failing at once", () => {
    const chat = {
      id: -1001234567890,
      peerId: -1001234567890,
      type: "channel" as const,
      title: "Example News",
      username: "examplenews",
      memberCount: 5000,
    };
    const db = new Database(path);
    initCacheSchema(db);
    db.run("PRAGMA busy_timeout = 100");
    const lock = holdWriteLock(path);
    try {
      const started = performance.now();
      expect(() => applySyncMode(db, chat, "on")).toThrow("database is locked");
      expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    } finally {
      lock.release();
    }

    expect(applySyncMode(db, chat, "on").state).toMatchObject({
      sync_mode: "on",
      sync_enabled: 1,
    });
    db.close();
  });

  it("opens an upgraded, stamped cache with migrations pending without the write lock", () => {
    const owner = { id: 1, user_id: 101 };
    const seed = new Database(path);
    seedOldFormCache(seed, { messages: 3 });
    checkCacheOwner(seed, owner, path);
    seed.close();

    const lock = holdWriteLock(path);
    try {
      const db = new Database(path);
      initCacheSchema(db);
      db.run("PRAGMA busy_timeout = 0");
      initSyncSchema(db);
      checkCacheOwner(db, owner, path);
      expect(readMigrationStatus(db)[0]?.state).toBe("pending");
      db.close();
    } finally {
      lock.release();
    }
  });

  it("lets several processes switch a new or folded cache to WAL at once", async () => {
    for (const kind of ["new", "folded"] as const) {
      for (let round = 0; round < 3; round++) {
        const file = join(dir, `${kind}-${round}.db`);
        if (kind === "folded") {
          const db = new Database(file);
          db.run("PRAGMA journal_mode = DELETE");
          db.run("CREATE TABLE filler (n INTEGER)");
          db.transaction(() => {
            for (let n = 0; n < 100; n++) {
              db.run("INSERT INTO filler (n) VALUES (?)", [n]);
            }
          })();
          db.close();
        }

        const env = { LOCK_DB_PATH: file, SCHEMA_MODULE, SYNC_SCHEMA_MODULE };
        const children = Array.from({ length: 6 }, () => spawnBun(INIT_SCHEMA, env));
        const results = await Promise.all(
          children.map(async (child) => ({
            code: await child.exited,
            stderr: await new Response(child.stderr).text(),
          })),
        );

        expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
        const db = new Database(file);
        expect(db.query("PRAGMA journal_mode").get()).toEqual({
          journal_mode: "wal",
        });
        db.close();
      }
    }
  });

  async function initAtOnceAfterLock(count: number) {
    const lock = holdWriteLock(path);
    const env = { LOCK_DB_PATH: path, SCHEMA_MODULE, SYNC_SCHEMA_MODULE };
    const children = Array.from({ length: count }, () => spawnBun(INIT_SCHEMA, env));
    try {
      await Promise.all(children.map((child) => waitForLine(child.stdout, "opening")));
    } finally {
      lock.release();
    }
    return Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );
  }

  it("lets several processes rebuild an outdated search index at once", async () => {
    const outdated = new Database(path);
    for (let id = 1; id <= 50; id++) {
      outdated.run(
        `INSERT INTO messages_cache (chat_id, message_id, text, date, fetched_at, raw_json)
         VALUES (101, ?, ?, 1700000000, 1700000000000, '{}')`,
        [id, `made-up message ${id}`],
      );
    }
    for (const trigger of ["ai", "ad", "au"]) {
      outdated.run(`DROP TRIGGER messages_cache_${trigger}`);
    }
    outdated.run("DROP TABLE message_search");
    outdated.run(
      "CREATE VIRTUAL TABLE message_search USING fts5(text, sender, chat, tokenize='unicode61')",
    );
    outdated.close();

    const results = await initAtOnceAfterLock(4);

    expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
    const rebuilt = new Database(path);
    rebuilt.run("PRAGMA busy_timeout = 5000");
    expect(
      rebuilt
        .query("PRAGMA table_info(message_search)")
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(["text", "sender", "chat", "files"]);
    expect(
      rebuilt
        .query("SELECT COUNT(*) AS count FROM message_search WHERE message_search MATCH 'made'")
        .get(),
    ).toEqual({ count: 50 });
    expect(
      rebuilt
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_cache_a_'",
        )
        .get(),
    ).toEqual({ count: 3 });
    rebuilt.close();
  });

  it("lets several processes move a 0.2.0 cache to marked IDs at once", async () => {
    const legacy = new Database(path);
    seedLegacyCache(legacy);
    legacy.close();

    const results = await initAtOnceAfterLock(4);

    expect(results).toEqual(results.map(() => ({ code: 0, stderr: "" })));
    const migrated = new Database(path);
    migrated.run("PRAGMA busy_timeout = 5000");
    expect(migrated.query("PRAGMA user_version").get()).toEqual({
      user_version: PEER_ID_USER_VERSION,
    });
    expect(
      migrated
        .query("SELECT chat_id FROM chats_cache ORDER BY chat_id")
        .all()
        .map((row) => (row as { chat_id: string }).chat_id)
        .sort(),
    ).toEqual(["-1001234567890", "-1002222222222", "-4242", "10"]);
    assertPeerIdInvariants(migrated);
    migrated.close();
  });

  it("waits past the busy timeout to build the message_id index", async () => {
    const cache = new Database(path);
    cache.run("DROP INDEX idx_messages_cache_message_id");
    cache.close();

    const lock = holdWriteLock(path);
    const child = spawnBun(BUILD_INDEX, { LOCK_DB_PATH: path, SCHEMA_MODULE, SYNC_SCHEMA_MODULE });
    let stdout: string;
    try {
      stdout = await stdoutAfter(child, "waiting", lock.release);
    } finally {
      lock.release();
    }

    expect({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim().split("\n")).toEqual(["waiting", "busy_timeout 0"]);
    const db = new Database(path, { readonly: true });
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_cache_message_id'",
        )
        .get(),
    ).toEqual({ name: "idx_messages_cache_message_id" });
    db.close();
  });

  it("opens the cache again after a migration that failed", async () => {
    const accountCache = join(dir, "accounts", "1", "cache.db");
    mkdirSync(join(dir, "accounts", "1"), { recursive: true });
    const legacy = new Database(accountCache);
    initCacheSchema(legacy);
    initSyncSchema(legacy);
    seedLegacyCache(legacy);
    legacy.run(`
      CREATE TRIGGER fail_rekey BEFORE UPDATE OF chat_id ON chats_cache
      BEGIN SELECT RAISE(ABORT, 'disk full'); END
    `);
    legacy.close();

    const child = spawnBun(RETRY_OPEN, {
      DB_MODULE,
      LOCK_DB_PATH: accountCache,
      TELEGRAM_SYNC_CLI_DATA_DIR: dir,
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout.trim().split("\n")).toEqual([
      "first open: disk full",
      `second open: ${PEER_ID_USER_VERSION}`,
    ]);
  });

  it("lets several processes move a shared cache to its only account at once", async () => {
    seedSharedCache(path);
    seedAccounts(dir, 1);

    const env = { DB_MODULE, TELEGRAM_SYNC_CLI_DATA_DIR: dir };
    const children = Array.from({ length: 4 }, () => spawnBun(OPEN_ACCOUNT_CACHE, env));
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
      })),
    );

    expect(results).toEqual(results.map(() => ({ code: 0, stdout: "chats: 4", stderr: "" })));
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(join(dir, "accounts", "1", "cache.db"))).toBe(true);
    expect(listCacheFiles(dir)).toEqual(["accounts/1/cache.db"]);
  });

  it("lets several processes migrate a 0.1.4 database at once", async () => {
    const db = new Database(path);
    db.run("DROP INDEX idx_sync_jobs_lane");
    db.run("DROP INDEX idx_messages_cache_message_id");
    db.run("ALTER TABLE chat_sync_state DROP COLUMN top_message_id");
    db.run("ALTER TABLE chat_sync_state DROP COLUMN sync_mode");
    db.run("ALTER TABLE sync_jobs DROP COLUMN attempts");
    db.run("ALTER TABLE sync_jobs DROP COLUMN next_run_at");
    db.close();

    const results = await initAtOnceAfterLock(4);

    expect(results).toEqual(results.map(() => ({ code: 0, stderr: expect.any(String) })));
    for (const { stderr } of results) {
      expect(stderr).not.toContain("error");
    }

    const migrated = new Database(path);
    const columnsOf = (table: string) =>
      (
        migrated.query(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((col) => col.name);
    expect(columnsOf("chat_sync_state")).toContain("top_message_id");
    expect(columnsOf("chat_sync_state")).toContain("sync_mode");
    expect(columnsOf("sync_jobs")).toContain("attempts");
    expect(columnsOf("sync_jobs")).toContain("next_run_at");
    expect(
      migrated
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_cache_message_id'",
        )
        .get(),
    ).toEqual({ name: "idx_messages_cache_message_id" });
    migrated.close();
  });
});
