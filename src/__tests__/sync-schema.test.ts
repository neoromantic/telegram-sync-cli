/**
 * Tests for sync system database schema
 * Tests the new tables: messages_cache, chat_sync_state, sync_jobs, daemon_status
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import {
  ChatSyncStateRow,
  DaemonStatusRow,
  determineSyncPolicy,
  initSyncSchema,
  isContentlessSearch,
  MessageCacheRow,
  SyncJobRow,
  SyncPriority,
  supportsContentlessSearch,
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

    it('indexes message_id for deletes without chat context', () => {
      expect(
        db
          .query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_cache_message_id'",
          )
          .get(),
      ).toEqual({ name: 'idx_messages_cache_message_id' })

      const plan = db
        .query(
          'EXPLAIN QUERY PLAN SELECT chat_id FROM messages_cache WHERE message_id = ? AND is_deleted = 0',
        )
        .all(7) as Array<{ detail: string }>
      expect(
        plan.some((step) =>
          step.detail.includes('USING INDEX idx_messages_cache_message_id'),
        ),
      ).toBe(true)
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

  it('leaves communities off', () => {
    expect(determineSyncPolicy('community')).toEqual(off)
    expect(determineSyncPolicy('community', 10)).toEqual(off)
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

  // sync_jobs as 0.1.4 created it
  const SYNC_JOBS_0_1_4 = `
    CREATE TABLE sync_jobs (
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
    db.run(SYNC_JOBS_0_1_4)
    db.run(`
      INSERT INTO sync_jobs (chat_id, job_type, priority, status, error_message, completed_at)
      VALUES
        (42, 'backward_history', 1, 'pending', NULL, NULL),
        (42, 'forward_catchup', 0, 'failed', 'Rate limited: wait 30s', 1700000000000)
    `)
    return db
  }

  const jobsOf = (db: Database) =>
    db
      .prepare(
        'SELECT id, status, attempts, next_run_at FROM sync_jobs ORDER BY id',
      )
      .all()
  const columnsOf = (db: Database, table: string) =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string
      }>
    ).map((col) => col.name)

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
      sync_mode: 'auto',
    })

    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sync_jobs_lane'",
        )
        .get(),
    ).toEqual({ name: 'idx_sync_jobs_lane' })

    const schema = schemaOf(db)
    const row = rowOf(db)
    initSyncSchema(db)
    expect(schemaOf(db)).toEqual(schema)
    expect(rowOf(db)).toEqual(row)
    db.close()
  })

  it('gives existing sync jobs no attempts and makes them due', () => {
    const db = createOldDatabase(join(dir, 'cache.db'))

    initSyncSchema(db)

    const jobs = [
      { id: 1, status: 'pending', attempts: 0, next_run_at: 0 },
      { id: 2, status: 'failed', attempts: 0, next_run_at: 0 },
    ]
    expect(jobsOf(db)).toEqual(jobs)

    const schema = schemaOf(db)
    initSyncSchema(db)
    expect(schemaOf(db)).toEqual(schema)
    expect(jobsOf(db)).toEqual(jobs)

    const fresh = new Database(':memory:')
    initCacheSchema(fresh)
    initSyncSchema(fresh)
    expect(columnsOf(db, 'sync_jobs')).toEqual(columnsOf(fresh, 'sync_jobs'))
    expect(columnsOf(db, 'sync_jobs').slice(-2)).toEqual([
      'attempts',
      'next_run_at',
    ])
    fresh.close()
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

describe('message_id index on an existing cache', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-sync-schema-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const schemaOf = (db: Database) =>
    db.query('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()
  const messagesOf = (db: Database) =>
    db
      .prepare(
        'SELECT chat_id, message_id, text, is_deleted FROM messages_cache ORDER BY chat_id, message_id',
      )
      .all()
  const hasIndex = (db: Database) =>
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_cache_message_id'",
      )
      .get() !== null

  it('adds the message_id index to an existing cache and keeps its messages', () => {
    const path = join(dir, 'cache.db')

    // A cache from before the index
    const old = new Database(path)
    initCacheSchema(old)
    initSyncSchema(old)
    old.run('DROP INDEX idx_messages_cache_message_id')
    old.run(
      `INSERT INTO messages_cache (chat_id, message_id, text, date, fetched_at, raw_json)
       VALUES (4242, 7, 'see you at noon', 1700000000, 1700000000000, '{}'),
              (-1001234567890, 7, 'weekly digest', 1700000100, 1700000100000, '{}')`,
    )
    const before = messagesOf(old)
    expect(hasIndex(old)).toBe(false)
    old.close()

    const db = new Database(path)
    initCacheSchema(db)
    initSyncSchema(db)

    expect(hasIndex(db)).toBe(true)
    expect(messagesOf(db)).toEqual(before)
    expect(before).toHaveLength(2)

    const schema = schemaOf(db)
    initSyncSchema(db)
    expect(schemaOf(db)).toEqual(schema)
    expect(messagesOf(db)).toEqual(before)
    db.close()
  })
})

describe('contentless message_search', () => {
  const searchSql = (db: Database) =>
    (
      db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_search'",
        )
        .get() as { sql: string }
    ).sql
  const searchMeta = (db: Database) =>
    db
      .query(
        "SELECT value, updated_at FROM search_meta WHERE key = 'search_index_version'",
      )
      .get() as { value: string; updated_at: number }
  const triggers = (db: Database) =>
    (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_cache_a%' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  const find = (db: Database, query: string) =>
    (
      createMessagesSearch(db).search(query) as Array<{ message_id: number }>
    ).map((row) => row.message_id)

  function seed(db: Database, ids: number[], word = 'lighthouse') {
    createMessagesCache(db).upsertBatch(
      ids.map((id) => ({
        chat_id: 4242,
        message_id: id,
        text: `${word} note ${id}`,
        message_type: 'text',
        date: 1_700_000_000 + id,
        raw_json: '{}',
      })),
    )
  }

  function openCache(contentlessSearch?: boolean): Database {
    const db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db, { contentlessSearch })
    return db
  }

  it('this SQLite supports it', () => {
    expect(supportsContentlessSearch(new Database(':memory:'))).toBe(true)
  })

  it('creates a new cache with a contentless index, or a regular one when asked', () => {
    const contentless = openCache()
    expect(searchSql(contentless)).toContain('contentless_delete=1')
    expect(isContentlessSearch(contentless)).toBe(true)

    const regular = openCache(false)
    expect(searchSql(regular)).not.toContain('contentless_delete')
    expect(isContentlessSearch(regular)).toBe(false)
  })

  it('moves a cache with the full-content index to the contentless one once', () => {
    const db = openCache(false)
    seed(db, [1, 2, 3])
    db.run(
      "UPDATE search_meta SET updated_at = 0 WHERE key = 'search_index_version'",
    )

    initSyncSchema(db)

    expect(isContentlessSearch(db)).toBe(true)
    expect(searchMeta(db).value).toBe('1')
    const migratedAt = searchMeta(db).updated_at
    expect(migratedAt).toBeGreaterThan(0)
    expect(find(db, 'lighthouse')).toEqual([3, 2, 1])

    initSyncSchema(db)
    expect(searchMeta(db).updated_at).toBe(migratedAt)
  })

  it('on an older SQLite drops only the triggers, and a newer one rebuilds the index', () => {
    const db = openCache()
    seed(db, [1, 2])

    // An older SQLite, without contentless_delete, opens the cache
    initSyncSchema(db, { contentlessSearch: false })

    expect(triggers(db)).toEqual([])
    expect(searchMeta(db).value).toBe('0')
    expect(isContentlessSearch(db)).toBe(true)
    seed(db, [3])
    expect(
      (
        db.query('SELECT COUNT(*) AS n FROM messages_cache').get() as {
          n: number
        }
      ).n,
    ).toBe(3)

    initSyncSchema(db)

    expect(triggers(db)).toEqual([
      'messages_cache_ad',
      'messages_cache_ai',
      'messages_cache_au',
    ])
    expect(searchMeta(db).value).toBe('1')
    expect(find(db, 'lighthouse')).toEqual([3, 2, 1])
  })
})

describe('messages_cache writes on a cache from 0.5.0', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-sync-schema-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The update trigger 0.5.0 created: it re-indexed on every update */
  const OLD_UPDATE_TRIGGER = `
    CREATE TRIGGER messages_cache_au
    AFTER UPDATE ON messages_cache
    BEGIN
      DELETE FROM message_search WHERE rowid = old.rowid;
      INSERT INTO message_search(rowid, text, sender, chat, files)
      VALUES (new.rowid, COALESCE(new.text, ''), '', '', '');
    END
  `
  const schemaOf = (db: Database) =>
    db.query('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()
  const triggerSql = (db: Database) =>
    (
      db
        .query(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_cache_au'",
        )
        .get() as { sql: string }
    ).sql
  const hasFetchedIndex = (db: Database) =>
    db
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_cache_fetched'",
      )
      .get() !== null
  const find = (db: Database, query: string) =>
    createMessagesSearch(db)
      .search(query)
      .map((row) => row.message_id)

  const harborNotes = {
    chat_id: 4242,
    message_id: 7,
    text: 'harbor notes',
    message_type: 'text',
    date: 1_700_000_000,
    raw_json: '{}',
  }

  function oldCache(path: string, contentlessSearch: boolean): void {
    const old = new Database(path)
    initCacheSchema(old)
    initSyncSchema(old, { contentlessSearch })
    old.run('DROP TRIGGER messages_cache_au')
    old.run(OLD_UPDATE_TRIGGER)
    old.run(
      'CREATE INDEX idx_messages_cache_fetched ON messages_cache(fetched_at)',
    )
    createMessagesCache(old).upsert(harborNotes)
    old.close()
  }

  for (const contentlessSearch of [true, false]) {
    it(`gets the new trigger and loses the fetched_at index once (${contentlessSearch ? 'contentless' : 'full-content'} index)`, () => {
      const path = join(dir, 'cache.db')
      oldCache(path, contentlessSearch)

      const db = new Database(path)
      initCacheSchema(db)
      initSyncSchema(db, { contentlessSearch })

      expect(triggerSql(db)).toContain(
        'AFTER UPDATE OF text, from_id, media_path ON messages_cache',
      )
      expect(hasFetchedIndex(db)).toBe(false)
      expect(isContentlessSearch(db)).toBe(contentlessSearch)
      expect(find(db, 'harbor')).toEqual([7])

      const cache = createMessagesCache(db)
      const changes = () =>
        (db.query('SELECT total_changes() AS n').get() as { n: number }).n
      const before = changes()
      cache.upsert({ ...harborNotes, raw_json: '{"views":1}' })
      expect(changes()).toBe(before + 1)
      cache.updateText(4242, 7, 'lighthouse notes', 1_700_000_100)
      expect(find(db, 'lighthouse')).toEqual([7])
      expect(find(db, 'harbor')).toEqual([])

      const schema = schemaOf(db)
      db.close()

      // A second open has nothing to do, so it only reads
      const again = new Database(path, { readonly: true })
      initCacheSchema(again)
      initSyncSchema(again, { contentlessSearch })
      expect(schemaOf(again)).toEqual(schema)
      again.close()
    })
  }
})
