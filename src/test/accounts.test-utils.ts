import { afterEach, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  type AccountsDbInterface,
  accountsDb,
  closeAccountCacheDbs,
  createTestDatabase,
  db,
  getDataDir,
  getLegacyCachePath,
} from "../db";

export type AccountSeed = Parameters<AccountsDbInterface["create"]>[0];

export function testAccount(overrides: Partial<AccountSeed> = {}) {
  const result: AccountSeed = {
    phone: "+15550000001",
    name: "Test User",
    is_active: true,
    ...overrides,
  };
  return result;
}

/** Create the accounts in order, so the first one gets ID 1 on an empty table */
export function seedAccounts(target: AccountsDbInterface, seed: AccountSeed[]) {
  return seed.map((account) => target.create(account));
}

/** The real accounts table on an in-memory SQLite database, seeded */
export function createSeededAccountsDb(seed: AccountSeed[] = [testAccount()]) {
  const { accountsDb: seeded } = createTestDatabase();
  seedAccounts(seeded, seed);
  return seeded;
}

/**
 * Empty the test data dir that test-setup.ts points TELEGRAM_SYNC_CLI_DATA_DIR
 * at: no accounts, IDs from 1 again, and no account caches or shared cache
 */
export function resetDataDir() {
  closeAccountCacheDbs();
  db.run("DELETE FROM accounts");
  db.run("DELETE FROM sqlite_sequence WHERE name = 'accounts'");
  rmSync(join(getDataDir(), "accounts"), { recursive: true, force: true });
  rmSync(getLegacyCachePath(), { force: true });
}

/**
 * Run each test on the real src/db module over the test data dir, with these
 * accounts in data.db and each account's cache.db created on first use
 */
export function useTestDataDir(seed: AccountSeed[] = [testAccount()]) {
  beforeEach(() => {
    resetDataDir();
    seedAccounts(accountsDb, seed);
  });
  afterEach(resetDataDir);
}
