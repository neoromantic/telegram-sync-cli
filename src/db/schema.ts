/**
 * Database schema for caching
 * Uses bun:sqlite for local data storage
 *
 * Tables:
 * - users_cache: Cached user/contact information
 * - chats_cache: Cached chat/channel/group information
 * - sync_state: Tracks synchronization progress
 * - rate_limits: API rate limiting data
 * - api_activity: API call audit log
 */
import { Database } from 'bun:sqlite'

/**
 * Initialize the cache schema
 * Creates all tables and indexes for caching
 */
export function initCacheSchema(db: Database): void {
  // The CLI and the daemon write this database at the same time. Wait up to
  // 5 s for the other one's write lock instead of failing at once (SQLite's
  // default is not to wait).
  db.run('PRAGMA busy_timeout = 5000')

  // Enable WAL mode for better concurrent access
  db.run('PRAGMA journal_mode = WAL')

  // Users cache table
  db.run(`
    CREATE TABLE IF NOT EXISTS users_cache (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      display_name TEXT,
      phone TEXT,
      access_hash TEXT,
      is_contact INTEGER DEFAULT 0,
      is_bot INTEGER DEFAULT 0,
      is_premium INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  // Users cache indexes
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_users_cache_username ON users_cache(username) WHERE username IS NOT NULL',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_users_cache_phone ON users_cache(phone) WHERE phone IS NOT NULL',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_users_cache_fetched_at ON users_cache(fetched_at)',
  )

  // Chats cache table
  db.run(`
    CREATE TABLE IF NOT EXISTS chats_cache (
      chat_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      username TEXT,
      member_count INTEGER,
      access_hash TEXT,
      is_creator INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      last_message_id INTEGER,
      last_message_at INTEGER,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  // Chats cache indexes
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_chats_cache_username ON chats_cache(username) WHERE username IS NOT NULL',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_chats_cache_type ON chats_cache(type)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_chats_cache_fetched_at ON chats_cache(fetched_at)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_chats_cache_last_message_at ON chats_cache(last_message_at DESC)',
  )

  // Sync state table
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      entity_type TEXT PRIMARY KEY,
      forward_cursor TEXT,
      backward_cursor TEXT,
      is_complete INTEGER DEFAULT 0,
      last_sync_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  // Rate limits table
  db.run(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      method TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      call_count INTEGER DEFAULT 1,
      last_call_at INTEGER,
      flood_wait_until INTEGER,
      PRIMARY KEY (method, window_start)
    )
  `)

  // Rate limits index
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_rate_limits_method ON rate_limits(method)',
  )

  // API activity table
  db.run(`
    CREATE TABLE IF NOT EXISTS api_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      success INTEGER NOT NULL,
      error_code TEXT,
      response_ms INTEGER,
      context TEXT
    )
  `)

  // API activity indexes
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_api_activity_timestamp ON api_activity(timestamp DESC)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_api_activity_method ON api_activity(method)',
  )
}

/**
 * Create an in-memory database with cache schema for testing
 */
export function createTestCacheDatabase(): { db: Database } {
  const db = new Database(':memory:')
  initCacheSchema(db)
  return { db }
}

// Row class types for typed queries

/** User cache row class */
export class UserCacheRow {
  user_id!: string
  username!: string | null
  first_name!: string | null
  last_name!: string | null
  display_name!: string | null
  phone!: string | null
  access_hash!: string | null
  is_contact!: number
  is_bot!: number
  is_premium!: number
  fetched_at!: number
  raw_json!: string
  created_at!: number
  updated_at!: number
}

/** Chat cache row class */
export class ChatCacheRow {
  chat_id!: string
  type!: string
  title!: string | null
  username!: string | null
  member_count!: number | null
  access_hash!: string | null
  is_creator!: number
  is_admin!: number
  last_message_id!: number | null
  last_message_at!: number | null
  fetched_at!: number
  raw_json!: string
  created_at!: number
  updated_at!: number
}

/** Sync state row class */
export class SyncStateRow {
  entity_type!: string
  forward_cursor!: string | null
  backward_cursor!: string | null
  is_complete!: number
  last_sync_at!: number | null
  created_at!: number
  updated_at!: number
}

/** Rate limit row class */
export class RateLimitRow {
  method!: string
  window_start!: number
  call_count!: number
  last_call_at!: number | null
  flood_wait_until!: number | null
}

/** API activity row class */
export class ApiActivityRow {
  id!: number
  timestamp!: number
  method!: string
  success!: number
  error_code!: string | null
  response_ms!: number | null
  context!: string | null
}
