/**
 * Keeping an account's cache small: measuring it and pruning the
 * bookkeeping tables.
 *
 * Messages, chats and users are never pruned here (messages are eternal);
 * only the rows that record how the cache was filled: API activity, rate
 * limit windows and finished sync jobs. Database only, no CLI or daemon.
 */
import type { Database } from 'bun:sqlite'
import { RATE_WINDOW_SECONDS } from './rate-limits'
import { SyncJobStatus } from './sync-schema'
import type { CacheRetentionConfig } from './types'

/** Rows a prune pass deleted, by what they were */
export interface PruneResult {
  api_activity: number
  rate_limits: number
  completed_jobs: number
  failed_jobs: number
}

export interface PruneOptions {
  /** The current time in ms; tests inject it */
  now?: number
  /** Rows deleted per statement */
  batchSize?: number
}

const DEFAULT_PRUNE_BATCH_SIZE = 5000

/**
 * Delete the rows matching `where` in short batches, each its own
 * autocommit statement, so a first prune of a large table never holds the
 * write lock for seconds while the daemon and a command want it.
 */
function deleteInBatches(
  db: Database,
  table: string,
  where: string,
  params: Record<string, number>,
  batchSize: number,
): number {
  const stmt = db.query(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT $limit)`,
  )
  let total = 0
  for (;;) {
    const { changes } = stmt.run({ ...params, $limit: batchSize })
    total += changes
    if (changes < batchSize) return total
  }
}

/**
 * Delete the bookkeeping rows older than their retention:
 * - api_activity by its timestamp, in seconds as the writer stores it;
 * - rate_limits windows, but never the current 60 s window nor a row whose
 *   FLOOD_WAIT still runs;
 * - completed and failed sync jobs by when they finished, each with its own
 *   retention. Pending and running jobs are never touched.
 */
export function pruneCache(
  db: Database,
  retention: CacheRetentionConfig,
  options: PruneOptions = {},
): PruneResult {
  const now = options.now ?? Date.now()
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE
  const nowSec = Math.floor(now / 1000)
  const currentWindowStart =
    Math.floor(nowSec / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS

  const api_activity = deleteInBatches(
    db,
    'api_activity',
    'timestamp < $cutoff',
    { $cutoff: nowSec - Math.floor(retention.apiActivity / 1000) },
    batchSize,
  )

  const rate_limits = deleteInBatches(
    db,
    'rate_limits',
    'window_start < $cutoff AND (flood_wait_until IS NULL OR flood_wait_until <= $now)',
    {
      $cutoff: Math.min(
        nowSec - Math.floor(retention.rateLimits / 1000),
        currentWindowStart,
      ),
      $now: nowSec,
    },
    batchSize,
  )

  const finishedJobs = (status: SyncJobStatus, retentionMs: number) =>
    deleteInBatches(
      db,
      'sync_jobs',
      `status = '${status}' AND completed_at IS NOT NULL AND completed_at < $cutoff`,
      { $cutoff: now - retentionMs },
      batchSize,
    )

  return {
    api_activity,
    rate_limits,
    completed_jobs: finishedJobs(
      SyncJobStatus.Completed,
      retention.completedJobs,
    ),
    failed_jobs: finishedJobs(SyncJobStatus.Failed, retention.failedJobs),
  }
}

export type AutoVacuumMode = 'none' | 'full' | 'incremental'

/** How big a cache is, and how much of it is free pages */
export interface CacheSize {
  /** The database file */
  file_bytes: number
  /** Its write-ahead log, `<file>-wal`; 0 when there is none */
  wal_bytes: number
  page_size: number
  page_count: number
  /** Pages inside the file that hold no data; `tg db vacuum` releases them */
  free_pages: number
  free_bytes: number
  auto_vacuum: AutoVacuumMode
  /**
   * Bytes per table, indexes and FTS5 shadow tables folded into their
   * table; null when this SQLite has no dbstat. Only with `tables: true`.
   */
  tables?: Record<string, number> | null
}

const AUTO_VACUUM_MODES: AutoVacuumMode[] = ['none', 'full', 'incremental']

function pragmaNumber(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number> | null
  return row ? Number(Object.values(row)[0] ?? 0) : 0
}

/** The cache's auto_vacuum mode */
export function readAutoVacuum(db: Database): AutoVacuumMode {
  return AUTO_VACUUM_MODES[pragmaNumber(db, 'auto_vacuum')] ?? 'none'
}

/** A file's size in bytes, 0 when it doesn't exist */
function fileSize(path: string): number {
  try {
    return Bun.file(path).size
  } catch {
    return 0
  }
}

/** Every table's bytes from dbstat; null when this SQLite lacks it */
function readTableSizes(db: Database): Record<string, number> | null {
  let rows: Array<{ name: string; pgsize: number }>
  try {
    rows = db
      .query('SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE')
      .all() as Array<{ name: string; pgsize: number }>
  } catch {
    return null
  }

  const schema = db
    .query('SELECT name, tbl_name, sql FROM sqlite_master')
    .all() as Array<{ name: string; tbl_name: string; sql: string | null }>
  const tableOf = new Map(schema.map((row) => [row.name, row.tbl_name]))
  // An FTS5 table keeps its data in shadow tables named <table>_data, …
  const virtualTables = schema
    .filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? ''))
    .map((row) => row.name)

  const sizes: Record<string, number> = {}
  for (const row of rows) {
    let table = tableOf.get(row.name) ?? row.name
    const owner = virtualTables.find((name) => table.startsWith(`${name}_`))
    if (owner) table = owner
    sizes[table] = (sizes[table] ?? 0) + row.pgsize
  }
  return sizes
}

/**
 * The cache's size: its file and WAL, pages, free pages and auto_vacuum
 * mode. With `tables`, also each table's bytes from dbstat, which reads
 * every page of the file, so only on request.
 */
export function readCacheSize(
  db: Database,
  path: string,
  options: { tables: boolean },
): CacheSize {
  const page_size = pragmaNumber(db, 'page_size')
  const free_pages = pragmaNumber(db, 'freelist_count')
  const size: CacheSize = {
    file_bytes: fileSize(path),
    wal_bytes: fileSize(`${path}-wal`),
    page_size,
    page_count: pragmaNumber(db, 'page_count'),
    free_pages,
    free_bytes: free_pages * page_size,
    auto_vacuum: readAutoVacuum(db),
  }
  if (options.tables) size.tables = readTableSizes(db)
  return size
}
