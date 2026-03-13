/**
 * Sync system database schema
 * Extends the base cache schema with tables for:
 * - messages_cache: Cached messages from synchronized chats
 * - chat_sync_state: Per-chat sync state with dual cursors
 * - sync_jobs: Job queue for background sync
 * - daemon_status: Daemon status key-value store
 */
import type { Database } from 'bun:sqlite'

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

function rebuildMessageSearchIndex(db: Database): void {
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

function ensureMessageSearchIndex(db: Database): void {
  const result = db
    .query(`SELECT value FROM search_meta WHERE key = 'search_index_version'`)
    .get() as { value?: string } | null
  const storedVersion = Number(result?.value ?? 0)

  const columns = getMessageSearchColumns(db)
  const hasAllColumns = MESSAGE_SEARCH_COLUMNS.every((col) =>
    columns.includes(col),
  )
  const needsSchemaRebuild = columns.length === 0 || !hasAllColumns

  if (needsSchemaRebuild) {
    dropMessageSearchSchema(db)
    createMessageSearchSchema(db)
  }

  if (needsSchemaRebuild || storedVersion !== SEARCH_INDEX_VERSION) {
    rebuildMessageSearchIndex(db)
  }
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

  createMessageSearchSchema(db)

  ensureMessageSearchIndex(db)

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
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

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
      completed_at      INTEGER
    )
  `)

  // Sync jobs indexes
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sync_jobs_priority
    ON sync_jobs(priority, created_at) WHERE status = 'pending'
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
}

/** Daemon status row class */
export class DaemonStatusRow {
  key!: string
  value!: string | null
  updated_at!: number
}

/** Sync priority levels */
export enum SyncPriority {
  /** P0 - Real-time updates, immediate sync */
  Realtime = 0,
  /** P1 - DMs and small groups (<20 members), full sync */
  High = 1,
  /** P2 - Medium groups (20-100 members), partial sync */
  Medium = 2,
  /** P3 - Large groups (>100 members) and channels, on-demand only */
  Low = 3,
  /** P4 - Background history backfill */
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
export type SyncChatType = 'private' | 'group' | 'supergroup' | 'channel'

/**
 * Determine sync policy based on chat type and member count
 */
export function determineSyncPolicy(
  chatType: SyncChatType,
  memberCount?: number,
): { priority: SyncPriority; enabled: boolean } {
  switch (chatType) {
    case 'private':
      return { priority: SyncPriority.High, enabled: true }

    case 'group':
    case 'supergroup':
      if (memberCount === undefined || memberCount < 20) {
        return { priority: SyncPriority.High, enabled: true }
      }
      if (memberCount <= 100) {
        return { priority: SyncPriority.Medium, enabled: true }
      }
      return { priority: SyncPriority.Low, enabled: false }

    case 'channel':
      return { priority: SyncPriority.Low, enabled: false }

    default:
      return { priority: SyncPriority.Low, enabled: false }
  }
}
