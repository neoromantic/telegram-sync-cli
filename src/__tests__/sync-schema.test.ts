/**
 * Tests for sync system database schema
 * Tests the new tables: messages_cache, chat_sync_state, sync_jobs, daemon_status
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initCacheSchema } from '../db/schema'
import {
  ChatSyncStateRow,
  DaemonStatusRow,
  determineSyncPolicy,
  initSyncSchema,
  MessageCacheRow,
  SyncJobRow,
  SyncPriority,
} from '../db/sync-schema'

describe('sync schema', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
  })

  describe('messages_cache table', () => {
    it('creates messages_cache table', () => {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='messages_cache'",
        )
        .all()
      expect(tables).toHaveLength(1)
    })

    it('inserts and retrieves a message', () => {
      db.run(
        `
        INSERT INTO messages_cache (
          chat_id, message_id, from_id, text, message_type, date, fetched_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          -1001234567890,
          42,
          123456789,
          'Hello world',
          'text',
          Date.now(),
          Date.now(),
          '{}',
        ],
      )

      const row = db
        .query(
          'SELECT * FROM messages_cache WHERE chat_id = ? AND message_id = ?',
        )
        .as(MessageCacheRow)
        .get(-1001234567890, 42)

      expect(row).not.toBeNull()
      expect(row?.text).toBe('Hello world')
      expect(row?.message_type).toBe('text')
    })

    it('supports composite primary key (chat_id, message_id)', () => {
      db.run(
        `
        INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [100, 1, 'First', 'text', Date.now(), Date.now(), '{}'],
      )

      db.run(
        `
        INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [100, 2, 'Second', 'text', Date.now(), Date.now(), '{}'],
      )

      db.run(
        `
        INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [200, 1, 'Different chat', 'text', Date.now(), Date.now(), '{}'],
      )

      const count = db
        .query('SELECT COUNT(*) as count FROM messages_cache')
        .get() as { count: number }
      expect(count.count).toBe(3)
    })

    it('rejects duplicate (chat_id, message_id)', () => {
      db.run(
        `
        INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [100, 1, 'First', 'text', Date.now(), Date.now(), '{}'],
      )

      expect(() => {
        db.run(
          `
          INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
          [100, 1, 'Duplicate', 'text', Date.now(), Date.now(), '{}'],
        )
      }).toThrow()
    })

    it('supports INSERT OR REPLACE for message updates', () => {
      db.run(
        `
        INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [100, 1, 'Original', 'text', Date.now(), Date.now(), '{}'],
      )

      db.run(
        `
        INSERT OR REPLACE INTO messages_cache (chat_id, message_id, text, message_type, is_edited, date, fetched_at, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [100, 1, 'Edited', 'text', 1, Date.now(), Date.now(), '{}'],
      )

      const row = db
        .query(
          'SELECT * FROM messages_cache WHERE chat_id = ? AND message_id = ?',
        )
        .as(MessageCacheRow)
        .get(100, 1)

      expect(row?.text).toBe('Edited')
      expect(row?.is_edited).toBe(1)
    })

    it('has index for date ordering', () => {
      const indexes = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_cache_date'",
        )
        .all()
      expect(indexes).toHaveLength(1)
    })
  })

  describe('message_search table', () => {
    it('creates message_search FTS table', () => {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='message_search'",
        )
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates search_meta table', () => {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='search_meta'",
        )
        .all()
      expect(tables).toHaveLength(1)
    })
  })

  describe('chat_sync_state table', () => {
    it('creates chat_sync_state table', () => {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_sync_state'",
        )
        .all()
      expect(tables).toHaveLength(1)
    })

    it('inserts and retrieves chat sync state', () => {
      db.run(
        `
        INSERT INTO chat_sync_state (
          chat_id, chat_type, member_count, sync_priority, sync_enabled
        ) VALUES (?, ?, ?, ?, ?)
      `,
        [-1001234567890, 'supergroup', 50, 2, 1],
      )

      const row = db
        .query('SELECT * FROM chat_sync_state WHERE chat_id = ?')
        .as(ChatSyncStateRow)
        .get(-1001234567890)

      expect(row).not.toBeNull()
      expect(row?.chat_type).toBe('supergroup')
      expect(row?.member_count).toBe(50)
      expect(row?.sync_priority).toBe(2)
      expect(row?.sync_enabled).toBe(1)
    })

    it('tracks forward and backward cursors', () => {
      db.run(
        `
        INSERT INTO chat_sync_state (
          chat_id, chat_type, forward_cursor, backward_cursor, sync_priority, sync_enabled
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
        [100, 'private', 1000, 500, 1, 1],
      )

      const row = db
        .query('SELECT * FROM chat_sync_state WHERE chat_id = ?')
        .as(ChatSyncStateRow)
        .get(100)

      expect(row?.forward_cursor).toBe(1000)
      expect(row?.backward_cursor).toBe(500)
    })

    it('tracks history completion', () => {
      db.run(
        `
        INSERT INTO chat_sync_state (chat_id, chat_type, history_complete, sync_priority, sync_enabled)
        VALUES (?, ?, ?, ?, ?)
      `,
        [100, 'private', 1, 1, 1],
      )

      const row = db
        .query('SELECT * FROM chat_sync_state WHERE chat_id = ?')
        .as(ChatSyncStateRow)
        .get(100)

      expect(row?.history_complete).toBe(1)
    })

    it('has index for sync-enabled chats', () => {
      const indexes = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_sync_state_enabled'",
        )
        .all()
      expect(indexes).toHaveLength(1)
    })
  })

  describe('sync_jobs table', () => {
    it('creates sync_jobs table', () => {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_jobs'",
        )
        .all()
      expect(tables).toHaveLength(1)
    })

    it('creates a sync job', () => {
      db.run(
        `
        INSERT INTO sync_jobs (chat_id, job_type, priority, status)
        VALUES (?, ?, ?, ?)
      `,
        [100, 'forward_catchup', 0, 'pending'],
      )

      const row = db
        .query('SELECT * FROM sync_jobs WHERE chat_id = ?')
        .as(SyncJobRow)
        .get(100)

      expect(row).not.toBeNull()
      expect(row?.job_type).toBe('forward_catchup')
      expect(row?.priority).toBe(0)
      expect(row?.status).toBe('pending')
    })

    it('auto-increments job id', () => {
      db.run(
        `INSERT INTO sync_jobs (chat_id, job_type, priority, status) VALUES (?, ?, ?, ?)`,
        [100, 'forward_catchup', 0, 'pending'],
      )
      db.run(
        `INSERT INTO sync_jobs (chat_id, job_type, priority, status) VALUES (?, ?, ?, ?)`,
        [200, 'backward_history', 2, 'pending'],
      )

      const jobs = db
        .query('SELECT * FROM sync_jobs ORDER BY id')
        .as(SyncJobRow)
        .all()
      expect(jobs).toHaveLength(2)
      expect(jobs[0]!.id).toBe(1)
      expect(jobs[1]!.id).toBe(2)
    })

    it('tracks job progress', () => {
      db.run(
        `
        INSERT INTO sync_jobs (chat_id, job_type, priority, status, cursor_start, cursor_end, messages_fetched)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
        [100, 'backward_history', 2, 'running', 1000, 500, 50],
      )

      const row = db
        .query('SELECT * FROM sync_jobs WHERE chat_id = ?')
        .as(SyncJobRow)
        .get(100)

      expect(row?.cursor_start).toBe(1000)
      expect(row?.cursor_end).toBe(500)
      expect(row?.messages_fetched).toBe(50)
    })

    it('has index for priority ordering', () => {
      const indexes = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sync_jobs_priority'",
        )
        .all()
      expect(indexes).toHaveLength(1)
    })
  })

  describe('daemon_status table', () => {
    it('creates daemon_status table', () => {
      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='daemon_status'",
        )
        .all()
      expect(tables).toHaveLength(1)
    })

    it('stores key-value status', () => {
      db.run(
        `INSERT OR REPLACE INTO daemon_status (key, value) VALUES (?, ?)`,
        ['daemon_pid', '12345'],
      )
      db.run(
        `INSERT OR REPLACE INTO daemon_status (key, value) VALUES (?, ?)`,
        ['started_at', Date.now().toString()],
      )

      const row = db
        .query('SELECT * FROM daemon_status WHERE key = ?')
        .as(DaemonStatusRow)
        .get('daemon_pid')

      expect(row?.value).toBe('12345')
    })

    it('updates existing keys', () => {
      db.run(
        `INSERT OR REPLACE INTO daemon_status (key, value) VALUES (?, ?)`,
        ['connected_accounts', '2'],
      )
      db.run(
        `INSERT OR REPLACE INTO daemon_status (key, value) VALUES (?, ?)`,
        ['connected_accounts', '3'],
      )

      const row = db
        .query('SELECT * FROM daemon_status WHERE key = ?')
        .as(DaemonStatusRow)
        .get('connected_accounts')

      expect(row?.value).toBe('3')

      const count = db
        .query('SELECT COUNT(*) as count FROM daemon_status WHERE key = ?')
        .get('connected_accounts') as { count: number }
      expect(count.count).toBe(1)
    })
  })

  describe('schema integrity', () => {
    it('creates all required tables', () => {
      const expectedTables = [
        'messages_cache',
        'chat_sync_state',
        'sync_jobs',
        'daemon_status',
      ]

      for (const tableName of expectedTables) {
        const table = db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get(tableName)
        expect(table).not.toBeNull()
      }
    })

    it('is idempotent - can be called multiple times', () => {
      // Should not throw
      initSyncSchema(db)
      initSyncSchema(db)
      initSyncSchema(db)

      const tables = db
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%sync%' OR name LIKE '%message%' OR name LIKE '%daemon%'",
        )
        .all()

      // Should have exactly the expected tables (not duplicates)
      expect(tables.length).toBeGreaterThanOrEqual(3)
    })
  })
})

describe('determineSyncPolicy', () => {
  const high = { priority: SyncPriority.High, enabled: true }
  const medium = { priority: SyncPriority.Medium, enabled: true }
  const off = { priority: SyncPriority.Low, enabled: false }

  it('syncs private chats in full', () => {
    expect(determineSyncPolicy('private')).toEqual(high)
  })

  it('treats a group of unknown size as large', () => {
    for (const type of ['group', 'supergroup'] as const) {
      expect(determineSyncPolicy(type)).toEqual(off)
      expect(determineSyncPolicy(type, undefined)).toEqual(off)
      expect(determineSyncPolicy(type, null)).toEqual(off)
      expect(determineSyncPolicy(type, 0)).toEqual(off)
    }
  })

  it('syncs groups under 20 members in full', () => {
    expect(determineSyncPolicy('group', 1)).toEqual(high)
    expect(determineSyncPolicy('supergroup', 19)).toEqual(high)
  })

  it('gives groups of 20 to 100 members the medium tier', () => {
    expect(determineSyncPolicy('group', 20)).toEqual(medium)
    expect(determineSyncPolicy('supergroup', 100)).toEqual(medium)
  })

  it('leaves groups over 100 members and channels off', () => {
    expect(determineSyncPolicy('supergroup', 101)).toEqual(off)
    expect(determineSyncPolicy('channel')).toEqual(off)
    expect(determineSyncPolicy('channel', 10)).toEqual(off)
  })
})

describe('migration from 0.1.4', () => {
  // chat_sync_state as 0.1.4 created it
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
  `

  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-sync-schema-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function createOldDatabase(path: string): Database {
    const db = new Database(path)
    initCacheSchema(db)
    db.run(CHAT_SYNC_STATE_0_1_4)
    db.run(`
      INSERT INTO chat_sync_state
        (chat_id, chat_type, forward_cursor, backward_cursor, sync_priority, sync_enabled, synced_messages)
      VALUES (42, 'private', 1000, 1, 1, 1, 1000)
    `)
    return db
  }

  const schemaOf = (db: Database) =>
    db.query('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()
  // prepare(), not query(): query() caches the statement and its columns
  const rowOf = (db: Database) =>
    db.prepare('SELECT * FROM chat_sync_state WHERE chat_id = 42').get()

  it('adds the new columns and keeps existing rows', () => {
    const db = createOldDatabase(join(dir, 'cache.db'))

    initSyncSchema(db)

    expect(rowOf(db)).toMatchObject({
      chat_id: 42,
      forward_cursor: 1000,
      backward_cursor: 1,
      sync_enabled: 1,
      synced_messages: 1000,
      top_message_id: null,
    })

    const schema = schemaOf(db)
    const row = rowOf(db)
    initSyncSchema(db)
    expect(schemaOf(db)).toEqual(schema)
    expect(rowOf(db)).toEqual(row)
    db.close()
  })

  it('lets two connections to one file migrate it', () => {
    const path = join(dir, 'cache.db')
    const daemon = createOldDatabase(path)
    const cli = new Database(path)
    // The second connection has read the old schema already
    expect(rowOf(cli)).not.toHaveProperty('top_message_id')

    expect(() => {
      initSyncSchema(daemon)
      initSyncSchema(cli)
    }).not.toThrow()

    expect(rowOf(cli)).toHaveProperty('top_message_id', null)
    expect(rowOf(daemon)).toHaveProperty('top_message_id', null)
    cli.close()
    daemon.close()
  })
})
