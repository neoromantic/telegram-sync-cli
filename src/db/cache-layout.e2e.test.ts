import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertPeerIdInvariants } from "../test/peer-id-invariants.test-utils";
import { seedInChild } from "../test/seed-in-child.test-utils";
import { holdOpen, rowCounts } from "../test/shared-cache.test-utils";
import { UPGRADE_DOCS_URL } from "./cache-layout";
import { readCacheMeta } from "./cache-meta";
import { createMessagesCache } from "./messages-cache";
import { PEER_ID_USER_VERSION } from "./peer-id-migration";
import { NO_CREDENTIALS, runCli, runCliSuccess } from "../test/cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "../test/e2e-setup.test-utils";

const SQL_COUNT = "SELECT COUNT(*) AS n FROM messages_cache";

const NOTICE = "each account now has its own cache";

describe("E2E: upgrading from the shared cache", () => {
  let env: TestEnvironment;
  let shared: string;

  beforeEach(() => {
    env = createTestEnvironment("cache-layout");
    env.initDatabase();
    shared = join(env.dataDir, "cache.db");
  });

  afterEach(() => {
    env.cleanup();
  });

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });

  async function sqlCount(...extra: string[]) {
    const result = await runCliSuccess(["sql", SQL_COUNT, ...extra], options());
    return {
      count: (result.json as { data: { rows: Array<{ n: number }> } }).data.rows[0]!.n,
      stderr: result.stderr,
    };
  }

  describe("with one account", () => {
    beforeEach(() => {
      env.seedAccounts([{ phone: "+15550000001", user_id: 9001, is_active: true }]);
    });

    it("moves a cache from 0.2.0 to the account and migrates its peer IDs", async () => {
      seedInChild(shared, "legacySharedCache");
      const before = rowCounts(shared);

      const { count, stderr } = await sqlCount();

      expect(count).toBe(before.messages_cache);
      expect(stderr).not.toContain(NOTICE);
      for (const path of [shared, `${shared}-wal`, `${shared}-shm`]) {
        expect(existsSync(path)).toBe(false);
      }
      const moved = new Database(env.cachePath(1));
      try {
        expect(rowCounts(env.cachePath(1))).toEqual(before);
        expect(moved.query("PRAGMA user_version").get()).toEqual({
          user_version: PEER_ID_USER_VERSION,
        });
        assertPeerIdInvariants(moved);
        expect(readCacheMeta(moved)).toEqual({
          account_id: "1",
          user_id: "9001",
        });
      } finally {
        moved.close();
      }
      expect(statSync(join(env.dataDir, "accounts", "1")).mode & 0o777).toBe(0o700);
    });

    it("fails with CACHE_UNAVAILABLE while an older tg holds it, and moves it after", async () => {
      seedInChild(shared, "legacySharedCache");
      const bytes = readFileSync(shared);
      const holder = holdOpen(shared);
      await holder.ready();

      try {
        const result = await runCli(["sql", SQL_COUNT], options());
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stderr)).toMatchObject({
          success: false,
          error: {
            code: "CACHE_UNAVAILABLE",
            details: { reason: "shared_cache_in_use", path: shared },
          },
        });
        expect(readFileSync(shared).equals(bytes)).toBe(true);
        expect(existsSync(join(env.dataDir, "accounts"))).toBe(false);

        const status = await runCliSuccess(["status"], options());
        expect((status.json as { data: { storage: unknown } }).data.storage).toEqual({
          cache_bytes: 0,
          legacy_caches: [],
          media_bytes: null,
          migration: {
            reason: "shared_cache_in_use",
            path: shared,
            suggestion: expect.stringContaining("tg daemon stop"),
          },
        });
        expect(existsSync(join(env.dataDir, "accounts"))).toBe(false);
      } finally {
        await holder.release();
      }

      expect((await sqlCount()).count).toBe(5);
      expect(existsSync(shared)).toBe(false);
    });

    it("moves the cache to the only account before tg auth login adds another", async () => {
      seedInChild(shared, "legacySharedCache");
      const before = rowCounts(shared);

      const login = await runCli(["auth", "login", "--phone", "+15550000002"], options());

      expect(login.exitCode).not.toBe(0);
      expect(existsSync(shared)).toBe(false);
      expect(rowCounts(env.cachePath(1))).toEqual(before);
      env.seedAccounts([{ phone: "+15550000002" }]);
      expect((await sqlCount("--account", "1")).count).toBe(before.messages_cache);
      expect((await sqlCount("--account", "2")).count).toBe(0);
      expect(existsSync(join(env.dataDir, "shared-cache.db"))).toBe(false);
    });

    it("fails tg auth login while an older tg holds the cache, and adds no account", async () => {
      seedInChild(shared, "legacySharedCache");
      const bytes = readFileSync(shared);
      const holder = holdOpen(shared);
      await holder.ready();

      try {
        const login = await runCli(["auth", "login", "--phone", "+15550000002"], options());

        expect(login.exitCode).toBe(1);
        expect(JSON.parse(login.stderr)).toMatchObject({
          error: {
            code: "CACHE_UNAVAILABLE",
            details: { reason: "shared_cache_in_use", path: shared },
          },
        });
        const accounts = await runCliSuccess(["accounts", "list"], options());
        expect((accounts.json as { data: { accounts: unknown[] } }).data.accounts).toHaveLength(1);
        expect(readFileSync(shared).equals(bytes)).toBe(true);
      } finally {
        await holder.release();
      }
    });

    it("leaves the held cache alone in commands that need no cache", async () => {
      seedInChild(shared, "legacySharedCache");
      const bytes = readFileSync(shared);
      const holder = holdOpen(shared);
      await holder.ready();

      try {
        for (const args of [["--version"], ["--help"], ["accounts", "list"], ["config", "path"]]) {
          const result = await runCli(args, options());
          expect({ args, exitCode: result.exitCode }).toEqual({
            args,
            exitCode: 0,
          });
        }
        expect(readFileSync(shared).equals(bytes)).toBe(true);
        expect(existsSync(join(env.dataDir, "accounts"))).toBe(false);
      } finally {
        await holder.release();
      }
    });

    it("says in tg daemon status that an older daemon still holds the shared cache", async () => {
      seedInChild(shared, "legacySharedCache");
      const holder = holdOpen(shared);
      await holder.ready();
      writeFileSync(join(env.dataDir, "daemon.pid"), String(holder.pid));

      try {
        const result = await runCliSuccess(["daemon", "status"], options());
        const data = (result.json as { data: Record<string, unknown> }).data;

        expect(data).toMatchObject({
          status: "running",
          pid: holder.pid,
          messagesCached: 0,
          storage: {
            legacy_caches: [],
            migration: {
              reason: "shared_cache_in_use",
              path: shared,
              suggestion: expect.stringContaining("tg daemon stop"),
            },
          },
        });
        expect(existsSync(shared)).toBe(true);
        expect(existsSync(join(env.dataDir, "accounts"))).toBe(false);
      } finally {
        await holder.release();
      }
    });
  });

  it("moves the rows still in the WAL to an account with ID 3", async () => {
    env.seedAccounts([
      { phone: "+15550000001" },
      { phone: "+15550000002" },
      { phone: "+15550000003", is_active: true },
    ]);
    const data = new Database(join(env.dataDir, "data.db"));
    data.run("DELETE FROM accounts WHERE id < 3");
    data.close();
    seedInChild(shared, "cacheWithRowsInWal", { messages: 40 });
    expect(statSync(`${shared}-wal`).size).toBeGreaterThan(0);

    expect((await sqlCount()).count).toBe(40);

    for (const path of [shared, `${shared}-wal`, `${shared}-shm`]) {
      expect(existsSync(path)).toBe(false);
    }
    expect(rowCounts(env.cachePath(3)).messages_cache).toBe(40);
  });

  it("adds no first account while an older tg holds a cache of removed accounts", async () => {
    seedInChild(shared, "legacySharedCache");
    const before = rowCounts(shared);
    const holder = holdOpen(shared);
    await holder.ready();

    try {
      const login = await runCli(["auth", "login", "--phone", "+15550000003"], options());

      expect(login.exitCode).toBe(1);
      expect(JSON.parse(login.stderr)).toMatchObject({
        error: {
          code: "CACHE_UNAVAILABLE",
          details: { reason: "shared_cache_in_use", path: shared },
        },
      });
      const accounts = await runCliSuccess(["accounts", "list"], options());
      expect((accounts.json as { data: { accounts: unknown[] } }).data.accounts).toHaveLength(0);
    } finally {
      await holder.release();
    }

    await runCliSuccess(["status"], options());
    const parked = join(env.dataDir, "shared-cache.db");
    expect(existsSync(shared)).toBe(false);
    expect(rowCounts(parked)).toEqual(before);
    env.seedAccounts([{ phone: "+15550000003", is_active: true }]);
    expect((await sqlCount()).count).toBe(0);
  });

  describe("with two accounts", () => {
    beforeEach(() => {
      env.seedAccounts([{ phone: "+15550000001", is_active: true }, { phone: "+15550000002" }]);
    });

    it("sets the cache aside, says so once, and lists it in tg status", async () => {
      seedInChild(shared, "legacySharedCache");
      const before = rowCounts(shared);

      const first = await sqlCount();
      const second = await sqlCount();

      const parked = join(env.dataDir, "shared-cache.db");
      expect(first.count).toBe(0);
      expect(second.count).toBe(0);
      expect(first.stderr.split(NOTICE)).toHaveLength(2);
      expect(first.stderr).toContain(parked);
      expect(first.stderr).toContain(UPGRADE_DOCS_URL);
      expect(second.stderr).not.toContain(NOTICE);
      expect(existsSync(shared)).toBe(false);
      expect(rowCounts(parked)).toEqual(before);
      expect(rowCounts(env.cachePath(1)).messages_cache).toBe(0);

      const status = await runCliSuccess(["status"], options());
      expect((status.json as { data: { storage: unknown } }).data.storage).toEqual({
        cache_bytes: expect.any(Number),
        legacy_caches: [{ path: parked, size_bytes: statSync(parked).size }],
        media_bytes: null,
        migration: null,
      });
      const pretty = await runCliSuccess(["status", "--format", "pretty"], options());
      expect(pretty.stdout).toContain(UPGRADE_DOCS_URL);
    });

    it("prints no notice with --format quiet", async () => {
      seedInChild(shared, "legacySharedCache");

      const result = await runCliSuccess(["--format", "quiet", "sql", SQL_COUNT], options());

      expect(result.stderr).not.toContain(NOTICE);
      expect(existsSync(join(env.dataDir, "shared-cache.db"))).toBe(true);
    });

    it("sets the cache aside before tg accounts remove leaves one account", async () => {
      seedInChild(shared, "legacySharedCache");
      const before = rowCounts(shared);

      await runCliSuccess(["accounts", "remove", "--id", "2"], options());

      const parked = join(env.dataDir, "shared-cache.db");
      expect(existsSync(shared)).toBe(false);
      expect(rowCounts(parked)).toEqual(before);
      expect((await sqlCount()).count).toBe(0);
    });

    it("removes no account while an older tg holds the cache, and sets it aside after", async () => {
      seedInChild(shared, "legacySharedCache");
      const before = rowCounts(shared);
      const holder = holdOpen(shared);
      await holder.ready();

      try {
        for (const args of [
          ["accounts", "remove", "--id", "2"],
          ["auth", "logout", "--account", "2"],
        ]) {
          const result = await runCli(args, options());
          expect(result.exitCode).toBe(1);
          expect(JSON.parse(result.stderr)).toMatchObject({
            error: {
              code: "CACHE_UNAVAILABLE",
              details: { reason: "shared_cache_in_use", path: shared },
            },
          });
        }
        const accounts = await runCliSuccess(["accounts", "list"], options());
        expect((accounts.json as { data: { accounts: unknown[] } }).data.accounts).toHaveLength(2);
        expect(existsSync(shared)).toBe(true);
      } finally {
        await holder.release();
      }

      await runCliSuccess(["accounts", "remove", "--id", "2"], options());

      const parked = join(env.dataDir, "shared-cache.db");
      expect(existsSync(shared)).toBe(false);
      expect(rowCounts(parked)).toEqual(before);
      expect((await sqlCount()).count).toBe(0);
    });

    it("deletes a shared cache that holds nothing", async () => {
      seedInChild(shared, "emptyCache");

      const { stderr } = await sqlCount();

      expect(stderr).not.toContain(NOTICE);
      expect(existsSync(shared)).toBe(false);
      expect(existsSync(join(env.dataDir, "shared-cache.db"))).toBe(false);
    });

    it("leaves a held cache for a later run and goes on", async () => {
      seedInChild(shared, "legacySharedCache");
      const holder = holdOpen(shared);
      await holder.ready();

      try {
        expect((await sqlCount()).count).toBe(0);
        expect(existsSync(shared)).toBe(true);
      } finally {
        await holder.release();
      }

      await sqlCount();
      expect(existsSync(shared)).toBe(false);
      expect(existsSync(join(env.dataDir, "shared-cache.db"))).toBe(true);
    });
  });

  it("gives a logged-out account's cache to the same user's new account", async () => {
    env.seedAccounts([{ phone: "+15550000001", user_id: 9001, is_active: true }]);
    const cache = env.openCacheDb(1);
    createMessagesCache(cache).upsertBatch([
      {
        chat_id: 101,
        message_id: 1,
        text: "kept across a re-login",
        message_type: "text",
        date: 1_760_000_000,
        raw_json: "{}",
      },
    ]);
    cache.run(
      "INSERT INTO cache_meta (key, value) VALUES ('account_id', '1'), ('user_id', '9001')",
    );
    await runCliSuccess(["accounts", "remove", "--id", "1"], options());
    env.seedAccounts([{ phone: "+15550000001", user_id: 9001, is_active: true }]);
    renameSync(join(env.dataDir, "accounts", "1"), join(env.dataDir, "accounts", "2"));

    expect((await sqlCount("--account", "2")).count).toBe(1);

    const moved = new Database(env.cachePath(2), { readonly: true });
    try {
      expect(readCacheMeta(moved)).toEqual({
        account_id: "2",
        user_id: "9001",
      });
    } finally {
      moved.close();
    }
  });

  it("refuses a cache stamped for another Telegram user", async () => {
    env.seedAccounts([{ phone: "+15550000001", user_id: 9001, is_active: true }]);
    env
      .openCacheDb(1)
      .run("INSERT INTO cache_meta (key, value) VALUES ('account_id', '1'), ('user_id', '9002')");

    const result = await runCli(["sql", SQL_COUNT], options());

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: {
        code: "CACHE_UNAVAILABLE",
        details: { reason: "owner_mismatch", path: env.cachePath(1) },
      },
    });
  });
});
