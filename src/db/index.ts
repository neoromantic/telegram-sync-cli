/**
 * Database module using bun:sqlite
 * Supports both file-based (production) and in-memory (testing) databases
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Account } from '../types'
import { initCacheSchema } from './schema'
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

// Cache database path
const CACHE_DB_PATH = join(DATA_DIR, 'cache.db')

// Lazy-initialized cache database
let cacheDb: Database | null = null

/**
 * Get the cache database instance
 * Lazy-initializes on first call for better startup performance
 */
export function getCacheDb(): Database {
  if (!cacheDb) {
    const db = new Database(CACHE_DB_PATH)
    try {
      initCacheSchema(db)
      initSyncSchema(db)
    } catch (err) {
      // A failed migration rolled back; the next call opens and retries it
      db.close()
      throw err
    }
    cacheDb = db
  }
  return cacheDb
}

/** Get database path for debugging */
export function getDatabasePath(): string {
  return DB_PATH
}

/** Get cache database path for debugging */
export function getCacheDatabasePath(): string {
  return CACHE_DB_PATH
}

/** Get data directory path */
export function getDataDir(): string {
  return DATA_DIR
}

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
