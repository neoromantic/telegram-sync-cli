/**
 * Cache maintenance: pruning the bookkeeping tables. Each test runs on its
 * own temporary cache file with an injected clock. Made-up data only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pruneCache } from '../db/cache-maintenance'
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

function addActivity(timestampSec: number, method = 'messages.getHistory') {
  db.query(
    'INSERT INTO api_activity (timestamp, method, success) VALUES (?, ?, 1)',
  ).run(timestampSec, method)
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

const count = (table: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('pruneCache', () => {
  it('deletes api_activity rows older than the retention, in seconds', () => {
    addActivity(NOW_SEC - 8 * 24 * 3600)
    addActivity(NOW_SEC - 7 * 24 * 3600 - 1)
    addActivity(NOW_SEC - 6 * 24 * 3600)
    addActivity(NOW_SEC)

    const result = pruneCache(db, getDefaultRetentionConfig(), { now: NOW })

    expect(result.api_activity).toBe(2)
    const left = db
      .query('SELECT timestamp FROM api_activity ORDER BY timestamp')
      .all() as Array<{ timestamp: number }>
    expect(left.map((row) => row.timestamp)).toEqual([
      NOW_SEC - 6 * 24 * 3600,
      NOW_SEC,
    ])
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

  it('keeps a rate limit window whose FLOOD_WAIT still runs', () => {
    const oldWindow = NOW_SEC - 2 * 3600
    addWindow(oldWindow, NOW_SEC + 3 * 3600)
    addWindow(oldWindow - 60)

    const result = pruneCache(db, getDefaultRetentionConfig(), { now: NOW })

    expect(result.rate_limits).toBe(1)
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
    for (let i = 0; i < 5; i++) addActivity(NOW_SEC - 30 * 24 * 3600 - i)
    addActivity(NOW_SEC)

    const result = pruneCache(db, getDefaultRetentionConfig(), {
      now: NOW,
      batchSize: 2,
    })

    expect(result.api_activity).toBe(5)
    expect(count('api_activity')).toBe(1)
  })
})
