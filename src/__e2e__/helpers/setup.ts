/**
 * Test environment setup for E2E tests
 *
 * Creates isolated temporary directories with fresh databases
 * to ensure tests don't affect production data.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'

const E2E_TEST_BASE = join(tmpdir(), 'telegram-sync-cli-e2e-tests')

export interface TestEnvironment {
  /** Path to the isolated data directory */
  dataDir: string

  /** Initialize database with schema */
  initDatabase(): Database

  /** Seed accounts into the database */
  seedAccounts(
    accounts: Array<{
      phone: string
      user_id?: number | null
      name?: string
      username?: string | null
      label?: string | null
      is_active?: boolean
      session_data?: string
    }>,
  ): void

  /** `accounts/<id>/cache.db`: the account's cache, where tg reads it */
  cachePath(accountId?: number): string

  /**
   * Open the account's cache with the current schema, creating it. The
   * handle stays open until cleanup(); a test may keep it while the CLI runs.
   */
  openCacheDb(accountId?: number): Database

  /** Clean up the test environment */
  cleanup(): void

  /** Get CLI options with isolated data dir */
  getCliOptions(): { env: Record<string, string> }
}

/**
 * Initialize database schema (matches src/db/index.ts)
 */
function initSchema(db: Database): void {
  db.run('PRAGMA journal_mode = WAL')

  db.run(`
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
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone)')
  db.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_label ON accounts(label)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active)',
  )
}

/**
 * Create an isolated test environment
 *
 * @param testName - Unique name for this test (used in directory path)
 */
export function createTestEnvironment(testName: string): TestEnvironment {
  // Create unique directory for this test
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  const dataDir = join(
    E2E_TEST_BASE,
    `${testName}-${timestamp}-${randomSuffix}`,
  )

  // Ensure directory exists
  mkdirSync(dataDir, { recursive: true })

  let db: Database | null = null
  const cacheDbs = new Map<number, Database>()
  const cachePath = (accountId = 1) =>
    join(dataDir, 'accounts', String(accountId), 'cache.db')

  return {
    dataDir,

    cachePath,

    openCacheDb(accountId = 1): Database {
      const open = cacheDbs.get(accountId)
      if (open) return open
      const path = cachePath(accountId)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const cacheDb = new Database(path)
      initCacheSchema(cacheDb)
      initSyncSchema(cacheDb)
      cacheDbs.set(accountId, cacheDb)
      return cacheDb
    },

    initDatabase(): Database {
      const dbPath = join(dataDir, 'data.db')
      db = new Database(dbPath)
      initSchema(db)
      return db
    },

    seedAccounts(accounts): void {
      if (!db) {
        this.initDatabase()
      }

      const stmt = db!.prepare(`
        INSERT INTO accounts (phone, user_id, name, username, label, session_data, is_active)
        VALUES ($phone, $user_id, $name, $username, $label, $session_data, $is_active)
      `)

      for (const account of accounts) {
        stmt.run({
          $phone: account.phone,
          $user_id: account.user_id ?? null,
          $name: account.name ?? null,
          $username: account.username ?? null,
          $label: account.label ?? null,
          $session_data: account.session_data ?? '',
          $is_active: account.is_active ? 1 : 0,
        })
      }
    },

    cleanup(): void {
      // Close database if open
      if (db) {
        db.close()
        db = null
      }
      for (const cacheDb of cacheDbs.values()) cacheDb.close()
      cacheDbs.clear()

      // Remove the test directory
      if (existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },

    getCliOptions(): { env: Record<string, string> } {
      return {
        env: {
          TELEGRAM_SYNC_CLI_DATA_DIR: dataDir,
        },
      }
    },
  }
}

/**
 * Clean up all E2E test directories
 * Useful for manual cleanup if tests fail
 */
export function cleanupAllTestEnvironments(): void {
  if (existsSync(E2E_TEST_BASE)) {
    rmSync(E2E_TEST_BASE, { recursive: true, force: true })
  }
}
