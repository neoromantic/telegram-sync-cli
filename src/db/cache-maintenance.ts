/**
 * Keeping an account's cache small: pruning the bookkeeping tables.
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
