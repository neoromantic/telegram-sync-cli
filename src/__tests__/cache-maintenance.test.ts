/**
 * Cache maintenance: pruning the bookkeeping tables. Each test runs on its
 * own temporary cache file with an injected clock. Made-up data only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  pruneCache,
  readCacheSize,
  rebuildSearchIfRowidsMoved,
  snapshotMessageRowids,
  VacuumNeedsStoppedDaemonError,
  vacuumCache,
} from '../db/cache-maintenance'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { getDefaultRetentionConfig } from '../db/types'

const SECOND = 1000
const HOUR = 60 * 60 * SECOND
const DAY = 24 * HOUR
const NOW = 1_760_000_000_000
const NOW_SEC = NOW / SECOND

let dir: string
let db: Database

function openCache(path: string): Database {
  const cache = new Database(path)
  initCacheSchema(cache)
  initSyncSchema(cache)
  return cache
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tg-cache-maintenance-'))
  db = openCache(join(dir, 'cache.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addActivity(timestamp: number, method = 'messages.getHistory') {
  db.query(
    'INSERT INTO api_activity (timestamp, method, success) VALUES (?, ?, 1)',
  ).run(timestamp, method)
}

function addWindow(windowStart: number, floodWaitUntil: number | null = null) {
  db.query(
    `INSERT INTO rate_limits (method, window_start, call_count, last_call_at, flood_wait_until)
     VALUES ('messages.getHistory', ?, 1, ?, ?)`,
  ).run(windowStart, windowStart, floodWaitUntil)
}

function addJob(status: string, completedAt: number | null): number {
  const row = db
    .query(
      `INSERT INTO sync_jobs (chat_id, job_type, status, completed_at)
       VALUES (101, 'forward_catchup', ?, ?) RETURNING id`,
    )
    .get(status, completedAt) as { id: number }
  return row.id
}

/** Made-up messages in two chats */
function seedMessages(n: number, startId = 1) {
  createMessagesCache(db).upsertBatch(
    Array.from({ length: n }, (_, i) => ({
      chat_id: i % 2 === 0 ? 101 : -1001234567890,
      message_id: startId + i,
      from_id: 5550001 + (i % 3),
      text: `made-up note ${startId + i} about the weekly plan`,
      message_type: 'text',
      date: NOW_SEC - i,
      raw_json: JSON.stringify({ _: 'message', id: startId + i }),
    })),
  )
}

const count = (table: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('pruneCache', () => {
  it('deletes api_activity rows older than the retention, in ms', () => {
    addActivity(NOW - 8 * DAY)
    addActivity(NOW - 7 * DAY - 1)
    addActivity(NOW - 6 * DAY)
    addActivity(NOW)

    const result = pruneCache(db, getDefaultRetentionConfig(), { now: NOW })

    expect(result.api_activity).toBe(2)
    const left = db
      .query('SELECT timestamp FROM api_activity ORDER BY timestamp')
      .all() as Array<{ timestamp: number }>
    expect(left.map((row) => row.timestamp)).toEqual([NOW - 6 * DAY, NOW])
  })

  it('turns the seconds older versions wrote into ms before it prunes', () => {
    addActivity(NOW_SEC - 8 * 24 * 3600) // seconds, past the retention
    addActivity(NOW_SEC - 3600) // seconds, an hour ago
    addActivity(NOW - 60_000) // ms, a minute ago

    const result = pruneCache(db, getDefaultRetentionConfig(), { now: NOW })

    expect(result.api_activity).toBe(1)
    const left = db
      .query('SELECT timestamp FROM api_activity ORDER BY timestamp')
      .all() as Array<{ timestamp: number }>
    expect(left.map((row) => row.timestamp)).toEqual([
      (NOW_SEC - 3600) * 1000,
      NOW - 60_000,
    ])

    // A second pass changes nothing
    pruneCache(db, getDefaultRetentionConfig(), { now: NOW })
    expect(count('api_activity')).toBe(2)
  })

  it('deletes finished jobs by their own retention and keeps pending and running ones', () => {
    const retention = {
      ...getDefaultRetentionConfig(),
      completedJobs: DAY,
      failedJobs: 2 * DAY,
    }
    const oldCompleted = addJob('completed', NOW - DAY - 1)
    const recentCompleted = addJob('completed', NOW - HOUR)
    const oldFailed = addJob('failed', NOW - 2 * DAY - 1)
    const failedInsideItsRetention = addJob('failed', NOW - DAY - 1)
    const pending = addJob('pending', null)
    const running = addJob('running', null)

    const result = pruneCache(db, retention, { now: NOW })

    expect(result.completed_jobs).toBe(1)
    expect(result.failed_jobs).toBe(1)
    const ids = (
      db.query('SELECT id FROM sync_jobs ORDER BY id').all() as Array<{
        id: number
      }>
    ).map((row) => row.id)
    expect(ids).toEqual([
      recentCompleted,
      failedInsideItsRetention,
      pending,
      running,
    ])
    expect(ids).not.toContain(oldCompleted)
    expect(ids).not.toContain(oldFailed)
  })

  it('keeps a rate limit window whose FLOOD_WAIT still runs, not one whose wait ended', () => {
    const oldWindow = NOW_SEC - 2 * 3600
    addWindow(oldWindow, NOW_SEC + 3 * 3600)
    addWindow(oldWindow - 60)
    addWindow(oldWindow - 120, NOW_SEC - 60)

    const result = pruneCache(db, getDefaultRetentionConfig(), { now: NOW })

    expect(result.rate_limits).toBe(2)
    const left = db.query('SELECT window_start FROM rate_limits').all()
    expect(left).toEqual([{ window_start: oldWindow }])
  })

  it('keeps the current 60 s window with a retention shorter than it', () => {
    const currentWindow = Math.floor(NOW_SEC / 60) * 60
    addWindow(currentWindow)
    addWindow(currentWindow - 60)

    const result = pruneCache(
      db,
      { ...getDefaultRetentionConfig(), rateLimits: SECOND },
      { now: (currentWindow + 30) * SECOND },
    )

    expect(result.rate_limits).toBe(1)
    expect(db.query('SELECT window_start FROM rate_limits').all()).toEqual([
      { window_start: currentWindow },
    ])
  })

  it('deletes every old row across several batches', () => {
    for (let i = 0; i < 5; i++) addActivity(NOW - 30 * DAY - i)
    addActivity(NOW)

    const result = pruneCache(db, getDefaultRetentionConfig(), {
      now: NOW,
      batchSize: 2,
    })

    expect(result.api_activity).toBe(5)
    expect(count('api_activity')).toBe(1)
  })
})

describe('readCacheSize', () => {
  it("reports the file, free pages and each table's bytes", () => {
    seedMessages(200)
    db.run('PRAGMA wal_checkpoint(TRUNCATE)')

    const size = readCacheSize(db, join(dir, 'cache.db'), { tables: true })

    expect(size.file_bytes).toBeGreaterThan(0)
    expect(size.page_size).toBeGreaterThan(0)
    expect(size.free_bytes).toBe(size.free_pages * size.page_size)
    expect(['none', 'full', 'incremental']).toContain(size.auto_vacuum)
    expect(size.tables?.messages_cache).toBeGreaterThan(0)
    expect(size.tables?.message_search).toBeGreaterThan(0)
    const names = Object.keys(size.tables ?? {})
    expect(names.filter((name) => name.startsWith('message_search_'))).toEqual(
      [],
    )
    expect(names.filter((name) => name.startsWith('idx_'))).toEqual([])
  })

  it('reads no table sizes unless asked', () => {
    const size = readCacheSize(db, join(dir, 'cache.db'), { tables: false })

    expect('tables' in size).toBe(false)
    expect(size.wal_bytes).toBeGreaterThanOrEqual(0)
  })
})

const pragma = (cache: Database, name: string) =>
  Object.values(cache.query(`PRAGMA ${name}`).get() as object)[0]

/** Turn the test's cache into one of an older version: auto_vacuum off */
function makeLegacyCache() {
  db.run('PRAGMA auto_vacuum = NONE')
  db.run('VACUUM')
  expect(pragma(db, 'auto_vacuum')).toBe(0)
}

/** Seed made-up messages, then delete a third of them (test only) */
function seedAndDeleteAThird() {
  seedMessages(3000)
  db.run('DELETE FROM messages_cache WHERE message_id % 3 = 0')
  db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(pragma(db, 'freelist_count')).toBeGreaterThan(0)
}

describe('auto_vacuum and journal_size_limit', () => {
  it('gives a new cache file incremental auto_vacuum', () => {
    expect(pragma(db, 'auto_vacuum')).toBe(2)
    expect(pragma(db, 'journal_mode')).toBe('wal')
    expect(pragma(db, 'journal_size_limit')).toBe(67108864)
  })

  it('leaves an existing file without auto_vacuum as it is', () => {
    const path = join(dir, 'older.db')
    const older = new Database(path)
    older.run('CREATE TABLE older_table (id INTEGER PRIMARY KEY)')
    older.close()

    const reopened = new Database(path)
    initCacheSchema(reopened)
    expect(pragma(reopened, 'auto_vacuum')).toBe(0)
    reopened.close()
  })
})

describe('vacuumCache', () => {
  const path = () => join(dir, 'cache.db')
  const search = (query: string) =>
    createMessagesSearch(db).search(query, { limit: 5000 })

  it('rewrites a cache without auto_vacuum when the daemon is stopped', () => {
    makeLegacyCache()
    seedAndDeleteAThird()
    const before = search('weekly')

    const result = vacuumCache(db, path(), { daemonRunning: false })

    expect(result.mode).toBe('full')
    expect(result.bytes_after).toBeLessThan(result.bytes_before)
    expect(result.freed_bytes).toBe(result.bytes_before - result.bytes_after)
    expect(result.free_pages_after).toBe(0)
    expect(result.auto_vacuum).toBe('incremental')
    expect(pragma(db, 'auto_vacuum')).toBe(2)
    expect(result.checkpointed).toBe(true)
    expect(search('weekly')).toEqual(before)
    expect(before).toHaveLength(2000)
  })

  it('refuses a cache without auto_vacuum while the daemon runs, writing nothing', () => {
    makeLegacyCache()
    seedAndDeleteAThird()
    const pages = pragma(db, 'page_count')

    expect(() => vacuumCache(db, path(), { daemonRunning: true })).toThrow(
      VacuumNeedsStoppedDaemonError,
    )
    expect(pragma(db, 'page_count')).toBe(pages)
    expect(pragma(db, 'auto_vacuum')).toBe(0)
  })

  it('releases free pages in steps on an incremental cache while the daemon runs', () => {
    seedAndDeleteAThird()

    const result = vacuumCache(db, path(), { daemonRunning: true })

    expect(result.mode).toBe('incremental')
    expect(result.free_pages_after).toBe(0)
    expect(pragma(db, 'freelist_count')).toBe(0)
    expect(result.bytes_after).toBeLessThan(result.bytes_before)
  })

  it("doesn't wait for a reader on an older snapshot while the daemon runs", () => {
    seedAndDeleteAThird()
    db.run('PRAGMA busy_timeout = 5000')
    const reader = new Database(path())
    reader.run('BEGIN')
    reader.query('SELECT COUNT(*) FROM messages_cache').get()

    const started = performance.now()
    const result = vacuumCache(db, path(), { daemonRunning: true })
    const elapsed = performance.now() - started
    reader.run('COMMIT')
    reader.close()

    expect(result.checkpointed).toBe(false)
    expect(elapsed).toBeLessThan(2000)
    expect(pragma(db, 'busy_timeout')).toBe(5000)
  })
})

describe('rebuildSearchIfRowidsMoved', () => {
  const searchUpdatedAt = () =>
    (
      db
        .query(
          "SELECT updated_at FROM search_meta WHERE key = 'search_index_version'",
        )
        .get() as { updated_at: number }
    ).updated_at

  it('rebuilds the search index when the rowids changed', () => {
    seedMessages(10)
    const before = snapshotMessageRowids(db)
    db.run('UPDATE search_meta SET updated_at = 0')

    const rebuilt = rebuildSearchIfRowidsMoved(db, {
      ...before,
      max: (before.max ?? 0) + 1,
    })

    expect(rebuilt).toBe(true)
    expect(searchUpdatedAt()).toBeGreaterThan(0)
    expect(createMessagesSearch(db).search('weekly')).toHaveLength(10)
  })

  it('leaves the index alone when they did not', () => {
    seedMessages(10)
    db.run('UPDATE search_meta SET updated_at = 0')

    expect(rebuildSearchIfRowidsMoved(db, snapshotMessageRowids(db))).toBe(
      false,
    )
    expect(searchUpdatedAt()).toBe(0)
  })
})
