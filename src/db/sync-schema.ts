/**
 * Sync system database schema
 * Extends the base cache schema with tables for:
 * - messages_cache: Cached messages from synchronized chats
 * - chat_sync_state: Per-chat sync state with dual cursors
 * - sync_jobs: Job queue for background sync
 * - daemon_status: Daemon status key-value store
 */
import type { Database } from 'bun:sqlite'

import { migratePeerIds } from './peer-id-migration'

const SEARCH_INDEX_VERSION = 1
const MESSAGE_SEARCH_COLUMNS = ['text', 'sender', 'chat', 'files'] as const

function buildSenderSearchExpr(prefix: string): string {
  return `
    COALESCE(
      (
        SELECT trim(
          COALESCE(username, '') || ' ' ||
          COALESCE(first_name, '') || ' ' ||
          COALESCE(last_name, '') || ' ' ||
          COALESCE(display_name, '') || ' ' ||
          COALESCE(user_id, '')
        )
        FROM users_cache
        WHERE user_id = CAST(${prefix}.from_id AS TEXT)
      ),
      COALESCE(CAST(${prefix}.from_id AS TEXT), '')
    )
  `
}

function buildChatSearchExpr(prefix: string): string {
  return `
    COALESCE(
      (
        SELECT trim(
          COALESCE(title, '') || ' ' ||
          COALESCE(username, '') || ' ' ||
          COALESCE(chat_id, '')
        )
        FROM chats_cache
        WHERE chat_id = CAST(${prefix}.chat_id AS TEXT)
      ),
      COALESCE(CAST(${prefix}.chat_id AS TEXT), '')
    )
  `
}

function dropMessageSearchSchema(db: Database): void {
  db.run('DROP TRIGGER IF EXISTS messages_cache_ai')
  db.run('DROP TRIGGER IF EXISTS messages_cache_ad')
  db.run('DROP TRIGGER IF EXISTS messages_cache_au')
  db.run('DROP TABLE IF EXISTS message_search')
}

function createMessageSearchSchema(db: Database): void {
  // Message search index (FTS5)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
      text,
      sender,
      chat,
      files,
      tokenize='unicode61'
    )
  `)

  // Search metadata table
  db.run(`
    CREATE TABLE IF NOT EXISTS search_meta (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  const senderExprNew = buildSenderSearchExpr('new')
  const chatExprNew = buildChatSearchExpr('new')

  // Search triggers (keep FTS index in sync)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_cache_ai
    AFTER INSERT ON messages_cache
    BEGIN
      INSERT INTO message_search(rowid, text, sender, chat, files)
      VALUES (
        new.rowid,
        COALESCE(new.text, ''),
        ${senderExprNew},
        ${chatExprNew},
        COALESCE(new.media_path, '')
      );
    END;
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_cache_ad
    AFTER DELETE ON messages_cache
    BEGIN
      DELETE FROM message_search WHERE rowid = old.rowid;
    END;
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS messages_cache_au
    AFTER UPDATE ON messages_cache
    BEGIN
      DELETE FROM message_search WHERE rowid = old.rowid;
      INSERT INTO message_search(rowid, text, sender, chat, files)
      VALUES (
        new.rowid,
        COALESCE(new.text, ''),
        ${senderExprNew},
        ${chatExprNew},
        COALESCE(new.media_path, '')
      );
    END;
  `)
}

/** Fill the search index again from messages_cache, in one transaction */
export function rebuildMessageSearchIndex(db: Database): void {
  const senderExpr = buildSenderSearchExpr('m')
  const chatExpr = buildChatSearchExpr('m')

  db.transaction(() => {
    db.run('DELETE FROM message_search')

    db.run(`
      INSERT INTO message_search(rowid, text, sender, chat, files)
      SELECT
        m.rowid,
        COALESCE(m.text, ''),
        ${senderExpr},
        ${chatExpr},
        COALESCE(m.media_path, '')
      FROM messages_cache m
    `)

    db.query(
      `
        INSERT INTO search_meta (key, value, updated_at)
        VALUES ($key, $value, $updated_at)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `,
    ).run({
      $key: 'search_index_version',
      $value: String(SEARCH_INDEX_VERSION),
      $updated_at: Date.now(),
    })
  })()
}

function getMessageSearchColumns(db: Database): string[] {
  try {
    return (
      db.query('PRAGMA table_info(message_search)').all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
  } catch {
    return []
  }
}

/** What the search index needs: nothing, its rows again, or a new table */
function searchIndexWork(db: Database): 'none' | 'rows' | 'schema' {
  const result = db
    .query(`SELECT value FROM search_meta WHERE key = 'search_index_version'`)
    .get() as { value?: string } | null
  const storedVersion = Number(result?.value ?? 0)

  const columns = getMessageSearchColumns(db)
  const hasAllColumns = MESSAGE_SEARCH_COLUMNS.every((col) =>
    columns.includes(col),
  )
  if (columns.length === 0 || !hasAllColumns) return 'schema'
  return storedVersion === SEARCH_INDEX_VERSION ? 'none' : 'rows'
}

/**
 * Bring the search index up to date. Processes that open a new cache at
 * once all find it unbuilt, and one that read the table while another was
 * creating it can find no columns. So the work runs under the write lock
 * and is checked again there: one process builds the index while the
 * others wait and then find nothing left, and none drops a table another
 * one is filling. An up-to-date index is only read, so opening the cache
 * never waits for the lock.
 */
function ensureMessageSearchIndex(db: Database): void {
  if (searchIndexWork(db) === 'none') return

  db.transaction(() => {
    const work = searchIndexWork(db)
    if (work === 'none') return
    if (work === 'schema') {
      dropMessageSearchSchema(db)
      createMessageSearchSchema(db)
    }
    rebuildMessageSearchIndex(db)
  }).immediate()
}

/**
 * Add a column that an older version's table lacks. The CLI and the daemon
 * can both run this on the first start of a new version, so a column the
 * other one just added is fine.
 */
function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
  }>
  if (columns.some((col) => col.name === column)) return

  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  } catch (err) {
    if (
      !(err instanceof Error) ||
      !err.message.includes('duplicate column name')
    ) {
      throw err
    }
  }
}

/** How long an index build waits for the write lock, as the peer ID migration does */
export const INDEX_BUILD_BUSY_TIMEOUT_MS = 60_000

/** Run `work` with busy_timeout raised to `timeoutMs`, then restore it */
export function withBusyTimeout<T>(
  db: Database,
  timeoutMs: number,
  work: () => T,
): T {
  const { timeout } = db.query('PRAGMA busy_timeout').get() as {
    timeout: number
  }
  db.run(`PRAGMA busy_timeout = ${timeoutMs}`)
  try {
    return work()
  } finally {
    db.run(`PRAGMA busy_timeout = ${timeout}`)
  }
}

/**
 * Create an index an older cache lacks. Building it reads the whole table,
 * which on a large cache read cold from disk can take longer than the
 * 5-second busy_timeout, and another process that opens the cache meanwhile
 * (the daemon next to a command) waits for the same write lock. So the build
 * waits up to a minute; a process that waited finds the index there and
 * creates nothing. A cache that has the index is only read, so opening it
 * never waits for the lock.
 */
function ensureIndex(db: Database, name: string, definition: string): void {
  const exists = db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name)
  if (exists) return

  withBusyTimeout(db, INDEX_BUILD_BUSY_TIMEOUT_MS, () => {
    db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${definition}`)
  })
}

/**
 * Initialize the sync schema
 * Creates all tables and indexes for the sync system
 */
export function initSyncSchema(db: Database): void {
  // Messages cache table - stores synced messages
  db.run(`
    CREATE TABLE IF NOT EXISTS messages_cache (
      chat_id         INTEGER NOT NULL,
      message_id      INTEGER NOT NULL,
      from_id         INTEGER,
      reply_to_id     INTEGER,
      forward_from_id INTEGER,
      text            TEXT,
      message_type    TEXT NOT NULL DEFAULT 'text',
      has_media       INTEGER DEFAULT 0,
      media_path      TEXT,
      is_outgoing     INTEGER DEFAULT 0,
      is_edited       INTEGER DEFAULT 0,
      is_pinned       INTEGER DEFAULT 0,
      is_deleted      INTEGER DEFAULT 0,
      edit_date       INTEGER,
      date            INTEGER NOT NULL,
      fetched_at      INTEGER NOT NULL,
      raw_json        TEXT NOT NULL,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      PRIMARY KEY (chat_id, message_id)
    )
  `)

  // Messages cache indexes
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_cache_date
    ON messages_cache(chat_id, date DESC)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_cache_from
    ON messages_cache(from_id) WHERE from_id IS NOT NULL
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_cache_reply
    ON messages_cache(chat_id, reply_to_id) WHERE reply_to_id IS NOT NULL
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_cache_type
    ON messages_cache(chat_id, message_type) WHERE has_media = 1
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_cache_pinned
    ON messages_cache(chat_id) WHERE is_pinned = 1
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_messages_cache_fetched
    ON messages_cache(fetched_at)
  `)
  // A delete without chat context names only message IDs (#7)
  ensureIndex(db, 'idx_messages_cache_message_id', 'messages_cache(message_id)')

  createMessageSearchSchema(db)

  ensureMessageSearchIndex(db)

  // History ranges - the message ID ranges of a chat cached without gaps
  // (src/db/history-ranges.ts); ranges of one chat never touch or overlap
  db.run(`
    CREATE TABLE IF NOT EXISTS history_ranges (
      chat_id     INTEGER NOT NULL,
      low         INTEGER NOT NULL,
      high        INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      PRIMARY KEY (chat_id, low)
    )
  `)

  // Chat sync state table - tracks sync progress per chat
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_sync_state (
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
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      top_message_id    INTEGER,
      sync_mode         TEXT NOT NULL DEFAULT 'auto'
    )
  `)

  // Columns added after 0.1.4
  ensureColumn(db, 'chat_sync_state', 'top_message_id', 'INTEGER')
  ensureColumn(
    db,
    'chat_sync_state',
    'sync_mode',
    "TEXT NOT NULL DEFAULT 'auto'",
  )

  // Chat sync state indexes
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_sync_state_enabled
    ON chat_sync_state(sync_enabled, sync_priority) WHERE sync_enabled = 1
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_sync_state_priority
    ON chat_sync_state(sync_priority)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_chat_sync_state_incomplete
    ON chat_sync_state(chat_id) WHERE history_complete = 0 AND sync_enabled = 1
  `)

  // Sync jobs table - job queue for background sync
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_jobs (
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
      completed_at      INTEGER,
      attempts          INTEGER NOT NULL DEFAULT 0,
      next_run_at       INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Columns added after 0.1.4
  ensureColumn(db, 'sync_jobs', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'sync_jobs', 'next_run_at', 'INTEGER NOT NULL DEFAULT 0')

  // Sync jobs indexes
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_priority
    ON sync_jobs(priority, created_at) WHERE status = 'pending'
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_lane
    ON sync_jobs(job_type, priority, created_at, id) WHERE status = 'pending'
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_status
    ON sync_jobs(status)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_chat
    ON sync_jobs(chat_id)
  `)

  // Daemon status table - key-value store for daemon state
  db.run(`
    CREATE TABLE IF NOT EXISTS daemon_status (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  // Caches from 0.2.0 and older keep groups and channels in chats_cache
  // under bare IDs (#18)
  migratePeerIds(db, rebuildMessageSearchIndex)
}

// Row class types for typed queries

/** Message cache row class */
export class MessageCacheRow {
  chat_id!: number
  message_id!: number
  from_id!: number | null
  reply_to_id!: number | null
  forward_from_id!: number | null
  text!: string | null
  message_type!: string
  has_media!: number
  media_path!: string | null
  is_outgoing!: number
  is_edited!: number
  is_pinned!: number
  is_deleted!: number
  edit_date!: number | null
  date!: number
  fetched_at!: number
  raw_json!: string
  created_at!: number
  updated_at!: number
}

/** Chat sync state row class */
export class ChatSyncStateRow {
  chat_id!: number
  chat_type!: string
  member_count!: number | null
  forward_cursor!: number | null
  backward_cursor!: number | null
  sync_priority!: number
  sync_enabled!: number
  history_complete!: number
  total_messages!: number | null
  synced_messages!: number
  last_forward_sync!: number | null
  last_backward_sync!: number | null
  created_at!: number
  updated_at!: number
  /** Newest message ID Telegram reported; NULL means unknown */
  top_message_id!: number | null
  /** Set by `tg chats sync`: 'auto' follows the policy, 'on' and 'off' override it */
  sync_mode!: SyncMode
}

/** Sync job row class */
export class SyncJobRow {
  id!: number
  chat_id!: number
  job_type!: string
  priority!: number
  status!: string
  cursor_start!: number | null
  cursor_end!: number | null
  messages_fetched!: number
  error_message!: string | null
  created_at!: number
  started_at!: number | null
  completed_at!: number | null
  /** Failed tries so far; a FLOOD_WAIT doesn't count */
  attempts!: number
  /** When a pending job may run next, in ms since the epoch; 0 means now */
  next_run_at!: number
}

/** Daemon status row class */
export class DaemonStatusRow {
  key!: string
  value!: string | null
  updated_at!: number
}

/**
 * Sync priority levels. A chat's tier (High, Medium, Low) is also the
 * priority of its jobs inside each lane.
 */
export enum SyncPriority {
  /** P0 - The first page of a chat turned on with `tg chats sync` */
  Realtime = 0,
  /** P1 - DMs and small groups (<20 members), full sync */
  High = 1,
  /** P2 - Medium groups (20-100 members), partial sync */
  Medium = 2,
  /** P3 - Groups of unknown size or over 100 members and channels, on request only */
  Low = 3,
  /** P4 - Lowest; older versions gave it to history jobs, new jobs don't use it */
  Background = 4,
}

/** Sync job types */
export enum SyncJobType {
  /** Catch up on missed messages since last sync */
  ForwardCatchup = 'forward_catchup',
  /** Initial load of N most recent messages */
  InitialLoad = 'initial_load',
  /** Load historical messages (backwards in time) */
  BackwardHistory = 'backward_history',
  /** Complete full sync of chat */
  FullSync = 'full_sync',
}

/** Sync job status */
export enum SyncJobStatus {
  Pending = 'pending',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
}

/** Chat types for sync */
export type SyncChatType =
  | 'private'
  | 'group'
  | 'supergroup'
  | 'channel'
  | 'community'

/**
 * Whether a chat syncs: 'auto' follows determineSyncPolicy, 'on' and 'off'
 * are the user's choice from `tg chats sync`, kept across dialog passes
 */
export type SyncMode = 'auto' | 'on' | 'off'

export const SYNC_MODES: readonly SyncMode[] = ['auto', 'on', 'off']

/**
 * Determine sync policy based on chat type and member count:
 * - private chats and groups under 20 members: High, full history
 * - groups of 20-100 members: Medium, the newest 100 messages, then history
 *   after the small chats
 * - groups of unknown size or over 100 members, and channels: off, synced
 *   only on request (`tg chats sync`)
 * - communities: off; the chats linked to one have their own policy
 *
 * Telegram often leaves the member count out of a supergroup's dialog, and
 * such a group may have thousands of members, so an unknown count is treated
 * as large.
 */
export function determineSyncPolicy(
  chatType: SyncChatType,
  memberCount?: number | null,
): { priority: SyncPriority; enabled: boolean } {
  switch (chatType) {
    case 'private':
      return { priority: SyncPriority.High, enabled: true }

    case 'group':
    case 'supergroup':
      if (
        memberCount === undefined ||
        memberCount === null ||
        memberCount <= 0
      ) {
        return { priority: SyncPriority.Low, enabled: false }
      }
      if (memberCount < 20) {
        return { priority: SyncPriority.High, enabled: true }
      }
      if (memberCount <= 100) {
        return { priority: SyncPriority.Medium, enabled: true }
      }
      return { priority: SyncPriority.Low, enabled: false }

    case 'channel':
    case 'community':
      return { priority: SyncPriority.Low, enabled: false }

    default:
      return { priority: SyncPriority.Low, enabled: false }
  }
}
