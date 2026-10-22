/**
 * Keeping an account's cache small: measuring it, pruning the bookkeeping
 * tables and giving free pages back to the disk.
 *
 * Messages, chats and users are never pruned here (messages are eternal);
 * only the rows that record how the cache was filled: API activity, rate
 * limit windows and finished sync jobs. Database only, no CLI or daemon.
 */
import type { Database } from 'bun:sqlite'
import { RATE_WINDOW_SECONDS } from './rate-limits'
import {
  INDEX_BUILD_BUSY_TIMEOUT_MS,
  rebuildMessageSearchIndex,
  SyncJobStatus,
  withBusyTimeout,
} from './sync-schema'
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

/**
 * A full VACUUM rewrites the file, which the daemon can't share: it would
 * wait for the write lock for the whole rewrite. On a cache without
 * auto_vacuum that is the only way, so it needs the daemon stopped.
 */
export class VacuumNeedsStoppedDaemonError extends Error {
  readonly autoVacuum: AutoVacuumMode = 'none'

  constructor() {
    super(
      'This cache has no incremental auto_vacuum yet, so only a full VACUUM can compact it, and that needs the daemon stopped',
    )
    this.name = 'VacuumNeedsStoppedDaemonError'
  }
}

export interface VacuumResult {
  /** `full` rewrote the file; `incremental` released free pages in steps */
  mode: 'full' | 'incremental'
  /** The file plus its WAL, before and after */
  bytes_before: number
  bytes_after: number
  freed_bytes: number
  free_pages_after: number
  auto_vacuum: AutoVacuumMode
  /** Whether the closing checkpoint emptied the WAL; false when a reader held it */
  checkpointed: boolean
  /** Whether the VACUUM moved message rowids, so the search index was rebuilt */
  rebuilt_search: boolean
}

/** Pages released per incremental_vacuum step, each its own short write */
const INCREMENTAL_VACUUM_STEP_PAGES = 1024
/** Enough steps for a 4 TB file of 4 KB pages; stops a loop that never ends */
const INCREMENTAL_VACUUM_MAX_STEPS = 1_000_000

/** What tells whether a VACUUM moved the rows of messages_cache */
export interface MessageRowidSnapshot {
  count: number
  min: number | null
  max: number | null
}

export function snapshotMessageRowids(db: Database): MessageRowidSnapshot {
  return db
    .query(
      'SELECT COUNT(*) AS count, MIN(rowid) AS min, MAX(rowid) AS max FROM messages_cache',
    )
    .get() as MessageRowidSnapshot
}

/**
 * Rebuild the search index if messages_cache's rowids changed. Its primary
 * key is (chat_id, message_id), so SQLite doesn't promise that a VACUUM
 * keeps its rowids, and message_search is keyed on them. Returns whether
 * it rebuilt.
 */
export function rebuildSearchIfRowidsMoved(
  db: Database,
  before: MessageRowidSnapshot,
): boolean {
  const after = snapshotMessageRowids(db)
  if (
    after.count === before.count &&
    after.min === before.min &&
    after.max === before.max
  ) {
    return false
  }
  rebuildMessageSearchIndex(db)
  return true
}

function totalBytes(path: string): number {
  return fileSize(path) + fileSize(`${path}-wal`)
}

/**
 * Empty the WAL into the file; false when a reader or writer held it.
 * A TRUNCATE checkpoint holds the write lock while it waits for readers on
 * an older snapshot, so with the daemon running it doesn't wait at all:
 * a busy cache reports false at once instead of holding the daemon's writes.
 */
function checkpoint(db: Database, options: { wait: boolean }): boolean {
  const run = () =>
    db.query('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number
    } | null
  try {
    const row = options.wait ? run() : withBusyTimeout(db, 0, run)
    return (row?.busy ?? 0) === 0
  } catch {
    return false
  }
}

/**
 * Give the cache's free pages back to the disk.
 *
 * - With the daemon running, a cache with auto_vacuum releases them in
 *   steps of 1,024 pages, each its own short write transaction, so the
 *   daemon's writes fit in between. A cache without it throws
 *   VacuumNeedsStoppedDaemonError and nothing is written.
 * - With the daemon stopped, a full VACUUM rewrites the file and switches
 *   it to incremental auto_vacuum. It waits up to a minute for the write
 *   lock, and rebuilds the search index if the rewrite moved rowids.
 *
 * Both end with a checkpoint that empties the WAL. With the daemon running
 * it gives up at once when a reader holds the WAL, so the daemon's writes
 * never wait for it.
 */
export function vacuumCache(
  db: Database,
  path: string,
  options: { daemonRunning: boolean },
): VacuumResult {
  const autoVacuum = readAutoVacuum(db)
  if (options.daemonRunning && autoVacuum === 'none') {
    throw new VacuumNeedsStoppedDaemonError()
  }

  const bytes_before = totalBytes(path)
  let mode: VacuumResult['mode']
  let rebuilt_search = false

  if (options.daemonRunning) {
    mode = 'incremental'
    for (
      let step = 0;
      step < INCREMENTAL_VACUUM_MAX_STEPS &&
      pragmaNumber(db, 'freelist_count') > 0;
      step++
    ) {
      db.run(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_STEP_PAGES})`)
    }
  } else {
    mode = 'full'
    const before = snapshotMessageRowids(db)
    db.run('PRAGMA auto_vacuum = INCREMENTAL')
    withBusyTimeout(db, INDEX_BUILD_BUSY_TIMEOUT_MS, () => db.run('VACUUM'))
    rebuilt_search = rebuildSearchIfRowidsMoved(db, before)
  }

  const checkpointed = checkpoint(db, { wait: !options.daemonRunning })
  const bytes_after = totalBytes(path)
  return {
    mode,
    bytes_before,
    bytes_after,
    freed_bytes: Math.max(0, bytes_before - bytes_after),
    free_pages_after: pragmaNumber(db, 'freelist_count'),
    auto_vacuum: readAutoVacuum(db),
    checkpointed,
    rebuilt_search,
  }
}
