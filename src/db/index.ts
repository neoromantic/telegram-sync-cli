/**
 * Database module using bun:sqlite
 * Supports both file-based (production) and in-memory (testing) databases
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Account } from '../types'
import { info } from '../utils/output'
import {
  accountCachePath,
  accountDirPath,
  accountMediaPath,
  type CacheLayoutMode,
  type CacheLayoutResult,
  createCacheLayoutGuard,
  legacyCachePath,
} from './cache-layout'
import { checkCacheOwner } from './cache-meta'
import { enableWal, initCacheSchema } from './schema'
import { initSyncSchema } from './sync-schema'

/**
 * Get the data directory path
 * Supports TELEGRAM_SYNC_CLI_DATA_DIR env var for testing isolation
 */
function resolveDataDir(): string {
  return (
    process.env.TELEGRAM_SYNC_CLI_DATA_DIR ??
    join(homedir(), '.telegram-sync-cli')
  )
}

// Database location: ~/.telegram-sync-cli/data.db (or TELEGRAM_SYNC_CLI_DATA_DIR if set)
const DATA_DIR = resolveDataDir()
const DB_PATH = join(DATA_DIR, 'data.db')

/**
 * Initialize database schema
 */
function initSchema(db: Database): void {
  // Several tg processes write data.db, and the move of a shared cache holds
  // its write lock (cache-layout.ts): wait for it instead of failing at once
  db.run('PRAGMA busy_timeout = 5000')
  enableWal(db)

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

  // Migration: add user_id column if it doesn't exist (for existing databases)
  // Note: SQLite doesn't allow UNIQUE constraint in ALTER TABLE, so we add the column
  // without it and create a unique index separately
  try {
    db.run('ALTER TABLE accounts ADD COLUMN user_id INTEGER')
  } catch {
    // Column already exists, ignore
  }

  // Migration: add username column if it doesn't exist
  try {
    db.run('ALTER TABLE accounts ADD COLUMN username TEXT')
  } catch {
    // Column already exists, ignore
  }

  // Migration: add label column if it doesn't exist
  try {
    db.run('ALTER TABLE accounts ADD COLUMN label TEXT')
  } catch {
    // Column already exists, ignore
  }

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

  // Migration: extract user_id from "user:xxx" phone values and resolve duplicates
  migrateAndResolveDuplicates(db)
}

/**
 * Extract user_id from "user:xxx" phone patterns and resolve duplicate accounts
 */
function migrateAndResolveDuplicates(db: Database): void {
  // Step 1: Extract user_id from phone values like "user:12345"
  const accountsWithUserPhone = db
    .query(
      "SELECT id, phone FROM accounts WHERE phone LIKE 'user:%' AND user_id IS NULL",
    )
    .all() as Array<{ id: number; phone: string }>

  for (const acc of accountsWithUserPhone) {
    const userId = parseInt(acc.phone.replace('user:', ''), 10)
    if (!Number.isNaN(userId)) {
      // Check if this user_id already exists in another account
      const existing = db
        .query('SELECT id FROM accounts WHERE user_id = ?')
        .get(userId) as { id: number } | null

      if (existing) {
        // Duplicate found! Keep the existing account (with real phone number),
        // delete the QR-based account (user:xxx phone)
        db.query('DELETE FROM accounts WHERE id = ?').run(acc.id)
      } else {
        // No duplicate, just update the user_id
        db.query('UPDATE accounts SET user_id = ? WHERE id = ?').run(
          userId,
          acc.id,
        )
      }
    }
  }

  // Step 2: Handle accounts with the same name but no user_id
  // This is a heuristic for accounts that might be the same user
  // We don't auto-merge these since name matching is not reliable
}

/** Account row class for typed queries */
class AccountRow {
  id!: number
  phone!: string
  user_id!: number | null
  name!: string | null
  username!: string | null
  label!: string | null
  session_data!: string
  is_active!: number
  created_at!: string
  updated_at!: string
}

function normalizeUsernameValue(username?: string | null): string | null {
  if (username === undefined || username === null) return null
  const trimmed = username.trim()
  if (!trimmed) return null
  const cleaned = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
  return cleaned.toLowerCase()
}

function normalizeLabelValue(label?: string | null): string | null {
  if (label === undefined || label === null) return null
  const trimmed = label.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Create prepared statements for a database instance
 */
function createStatements(db: Database) {
  return {
    getAllAccounts: db
      .query('SELECT * FROM accounts ORDER BY id')
      .as(AccountRow),
    getAccountById: db
      .query('SELECT * FROM accounts WHERE id = $id')
      .as(AccountRow),
    getAccountByPhone: db
      .query('SELECT * FROM accounts WHERE phone = $phone')
      .as(AccountRow),
    getAccountByUserId: db
      .query('SELECT * FROM accounts WHERE user_id = $user_id')
      .as(AccountRow),
    getAccountByUsername: db
      .query('SELECT * FROM accounts WHERE username = $username')
      .as(AccountRow),
    getAccountsByLabel: db
      .query('SELECT * FROM accounts WHERE label = $label ORDER BY id')
      .as(AccountRow),
    getActiveAccount: db
      .query('SELECT * FROM accounts WHERE is_active = 1 LIMIT 1')
      .as(AccountRow),

    insertAccount: db
      .query(`
      INSERT INTO accounts (phone, user_id, name, username, label, session_data, is_active)
      VALUES ($phone, $user_id, $name, $username, $label, $session_data, $is_active)
      RETURNING *
    `)
      .as(AccountRow),

    updateAccount: db
      .query(`
      UPDATE accounts
      SET phone = $phone, user_id = $user_id, name = $name, username = $username, label = $label, session_data = $session_data, updated_at = CURRENT_TIMESTAMP
      WHERE id = $id
      RETURNING *
    `)
      .as(AccountRow),

    updateSessionData: db.query(`
      UPDATE accounts
      SET session_data = $session_data, updated_at = CURRENT_TIMESTAMP
      WHERE id = $id
    `),

    setActiveAccount: db.query(`
      UPDATE accounts SET is_active = CASE WHEN id = $id THEN 1 ELSE 0 END
    `),

    deleteAccount: db.query('DELETE FROM accounts WHERE id = $id'),

    countAccounts: db.query('SELECT COUNT(*) as count FROM accounts'),
  }
}

/**
 * AccountsDb interface for dependency injection
 */
export interface AccountsDbInterface {
  getAll(): Account[]
  getById(id: number): Account | null
  getByPhone(phone: string): Account | null
  getByUserId(userId: number): Account | null
  getByUsername(username: string): Account | null
  getAllByLabel(label: string): Account[]
  getActive(): Account | null
  create(data: {
    phone: string
    user_id?: number
    name?: string
    username?: string
    label?: string
    session_data?: string
    is_active?: boolean
  }): Account
  update(
    id: number,
    data: {
      phone?: string
      user_id?: number | null
      name?: string
      username?: string | null
      label?: string | null
      session_data?: string
    },
  ): Account | null
  updateSession(id: number, session_data: string): void
  setActive(id: number): void
  delete(id: number): boolean
  count(): number
}

/**
 * Create an AccountsDb instance for a database
 */
export function createAccountsDb(db: Database): AccountsDbInterface {
  const statements = createStatements(db)

  return {
    /** Get all accounts */
    getAll(): Account[] {
      return statements.getAllAccounts.all()
    },

    /** Get account by ID */
    getById(id: number): Account | null {
      return statements.getAccountById.get({ $id: id }) ?? null
    },

    /** Get account by phone number */
    getByPhone(phone: string): Account | null {
      return statements.getAccountByPhone.get({ $phone: phone }) ?? null
    },

    /** Get account by Telegram user ID */
    getByUserId(userId: number): Account | null {
      return statements.getAccountByUserId.get({ $user_id: userId }) ?? null
    },

    /** Get account by Telegram username */
    getByUsername(username: string): Account | null {
      const normalized = normalizeUsernameValue(username)
      if (!normalized) return null
      return (
        statements.getAccountByUsername.get({ $username: normalized }) ?? null
      )
    },

    /** Get accounts by custom label */
    getAllByLabel(label: string): Account[] {
      const normalized = normalizeLabelValue(label)
      if (!normalized) return []
      return statements.getAccountsByLabel.all({ $label: normalized })
    },

    /** Get the currently active account */
    getActive(): Account | null {
      return statements.getActiveAccount.get() ?? null
    },

    /** Create a new account */
    create(data: {
      phone: string
      user_id?: number
      name?: string
      username?: string
      label?: string
      session_data?: string
      is_active?: boolean
    }): Account {
      const result = statements.insertAccount.get({
        $phone: data.phone,
        $user_id: data.user_id ?? null,
        $name: data.name ?? null,
        $username: normalizeUsernameValue(data.username),
        $label: normalizeLabelValue(data.label),
        $session_data: data.session_data ?? '',
        $is_active: data.is_active ? 1 : 0,
      })
      if (!result) throw new Error('Failed to create account')
      return result
    },

    /** Update account */
    update(
      id: number,
      data: {
        phone?: string
        user_id?: number | null
        name?: string
        username?: string | null
        label?: string | null
        session_data?: string
      },
    ): Account | null {
      const current = this.getById(id)
      if (!current) return null

      const nextUsername =
        data.username !== undefined
          ? normalizeUsernameValue(data.username)
          : current.username
      const nextLabel =
        data.label !== undefined
          ? normalizeLabelValue(data.label)
          : current.label

      return (
        statements.updateAccount.get({
          $id: id,
          $phone: data.phone ?? current.phone,
          $user_id: data.user_id !== undefined ? data.user_id : current.user_id,
          $name: data.name ?? current.name,
          $username: nextUsername,
          $label: nextLabel,
          $session_data: data.session_data ?? current.session_data,
        }) ?? null
      )
    },

    /** Update just the session data */
    updateSession(id: number, session_data: string): void {
      statements.updateSessionData.run({ $id: id, $session_data: session_data })
    },

    /** Set an account as active (deactivates all others) */
    setActive(id: number): void {
      statements.setActiveAccount.run({ $id: id })
    },

    /** Delete an account */
    delete(id: number): boolean {
      const result = statements.deleteAccount.run({ $id: id })
      return result.changes > 0
    },

    /** Count total accounts */
    count(): number {
      const result = statements.countAccounts.get() as { count: number } | null
      return result?.count ?? 0
    },
  }
}

/**
 * Create an in-memory database for testing
 */
export function createTestDatabase(): {
  db: Database
  accountsDb: AccountsDbInterface
} {
  const db = new Database(':memory:')
  initSchema(db)
  return { db, accountsDb: createAccountsDb(db) }
}

// Ensure data directory exists for production
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true })
}

// Production database instance
const db = new Database(DB_PATH)
initSchema(db)

// Production accountsDb instance
export const accountsDb = createAccountsDb(db)

const cacheLayout = createCacheLayoutGuard(() => ({
  dataDir: DATA_DIR,
  db,
  accounts: accountsDb,
  notice: info,
}))

/**
 * Move the shared cache of 0.3 and older to the per-account layout, once
 * per process (see cache-layout.ts). `strict` throws CacheUnavailableError
 * when the only account's cache can't be opened yet; `report` returns it.
 */
export function ensureCacheLayout(options: {
  mode: CacheLayoutMode
  notice?: (message: string) => void
}): CacheLayoutResult {
  return cacheLayout.ensure(options.mode, options.notice)
}

/** `<dataDir>/accounts/<id>`: everything the account has besides its session */
export function getAccountDir(accountId: number): string {
  return accountDirPath(DATA_DIR, accountId)
}

/** `<dataDir>/accounts/<id>/cache.db` */
export function getAccountCachePath(accountId: number): string {
  return accountCachePath(DATA_DIR, accountId)
}

/** `<dataDir>/accounts/<id>/media`: the account's downloaded files */
export function getAccountMediaDir(accountId: number): string {
  return accountMediaPath(DATA_DIR, accountId)
}

/** The shared cache of 0.3 and older, `<dataDir>/cache.db` */
export function getLegacyCachePath(): string {
  return legacyCachePath(DATA_DIR)
}

// One connection per account's cache, opened on first use
const accountCaches = new Map<number, Database>()

function openAccountCacheFile(accountId: number): Database {
  const account = accountsDb.getById(accountId)
  if (!account) {
    throw new Error(`Account with ID ${accountId} not found`)
  }

  mkdirSync(getAccountDir(accountId), { recursive: true, mode: 0o700 })
  const path = getAccountCachePath(accountId)
  const cache = new Database(path)
  try {
    initCacheSchema(cache)
    initSyncSchema(cache)
    checkCacheOwner(cache, account, path, {
      accountUserId: (id) => {
        const stamped = accountsDb.getById(id)
        return stamped ? stamped.user_id : undefined
      },
    })
  } catch (err) {
    // A failed migration rolled back; the next call opens and retries it
    cache.close()
    throw err
  }
  accountCaches.set(accountId, cache)
  return cache
}

/**
 * The account's cache database, created on first use. Moves a shared cache
 * first, so a single account's cache from 0.3 is never left behind.
 */
export function getAccountCacheDb(accountId: number): Database {
  const existing = accountCaches.get(accountId)
  if (existing) return existing
  ensureCacheLayout({ mode: 'strict' })
  return openAccountCacheFile(accountId)
}

/**
 * A read-only connection to an account's cache, with query_only on too, so
 * no statement on it changes the file: PRAGMA writes such as user_version
 * or journal_mode included (`tg sql`). Open the cache with getAccountCacheDb
 * first, which creates and migrates it; that connection stays open, so the
 * WAL files a reader needs exist.
 */
export function openReadOnlyAccountCacheDb(accountId: number): Database {
  const db = new Database(getAccountCachePath(accountId), { readonly: true })
  db.run('PRAGMA busy_timeout = 5000')
  db.run('PRAGMA query_only = ON')
  return db
}

/**
 * The account's cache if its file exists, else null; never creates one.
 * Call ensureCacheLayout first.
 */
export function openExistingAccountCacheDb(accountId: number): Database | null {
  const existing = accountCaches.get(accountId)
  if (existing) return existing
  if (!existsSync(getAccountCachePath(accountId))) return null
  return openAccountCacheFile(accountId)
}

/** Close every account's cache connection */
export function closeAccountCacheDbs(): void {
  for (const cache of accountCaches.values()) {
    try {
      cache.close()
    } catch {
      // Already closed
    }
  }
  accountCaches.clear()
}

/**
 * An in-memory database with the cache schema, for `tg sql print-schema`:
 * needs no account and creates no file
 */
export function createSchemaOnlyDb(): Database {
  const schemaDb = new Database(':memory:')
  initCacheSchema(schemaDb)
  initSyncSchema(schemaDb)
  return schemaDb
}

/** Get database path for debugging */
export function getDatabasePath(): string {
  return DB_PATH
}

/** Get data directory path */
export function getDataDir(): string {
  return DATA_DIR
}

export {
  type CacheLayoutResult,
  CacheUnavailableError,
  isCacheUnavailableError,
  listSharedCaches,
} from './cache-layout'
// Re-export sync schema types and functions
export {
  ChatSyncStateRow,
  DaemonStatusRow,
  determineSyncPolicy,
  initSyncSchema,
  MessageCacheRow,
  type SyncChatType,
  SyncJobRow,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from './sync-schema'
export { db }
