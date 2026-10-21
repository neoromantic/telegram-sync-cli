import type { SyncJobsService } from '../db/sync-jobs'
import type { SyncJobRow, SyncJobType } from '../db/sync-schema'
import {
  isPermanentSyncError,
  retryDelayMs,
  SYNC_RETRY_CONFIG,
} from './sync-retry'

/**
 * What happened to a job after it ran:
 * - completed: it succeeded
 * - deferred: it hit a FLOOD_WAIT and is pending until the wait ends; the
 *   try doesn't count as an attempt
 * - retrying: it failed and is pending until its backoff ends
 * - failed: it failed for good (a permanent error or the last attempt)
 * - cancelled: its chat was turned off while it ran, so it was deleted
 *   instead of being retried, deferred or failed
 * - not_running: it wasn't pending when it should start or running when it
 *   ended, so nothing changed
 */
export interface JobOutcome {
  state:
    | 'completed'
    | 'deferred'
    | 'retrying'
    | 'failed'
    | 'cancelled'
    | 'not_running'
  /** Failed tries so far */
  attempts: number
  /** When a pending job runs again, in ms since the epoch */
  nextRunAt: number | null
}

export interface JobResultLike {
  success: boolean
  messagesFetched: number
  error?: string
  rateLimited?: boolean
  waitSeconds?: number
  /** The error won't go away on a retry */
  permanent?: boolean
  /** Set by processJobWithHandlers once the job row is updated */
  outcome?: JobOutcome
}

export async function runOnceBase<
  TJobResult extends { success: boolean; messagesFetched: number },
>(options: {
  canMakeApiCall: () => boolean
  getWaitTime: () => number
  getNextJob: () => SyncJobRow | null
  processJob: (job: SyncJobRow) => Promise<TJobResult>
}): Promise<TJobResult | null> {
  if (!options.canMakeApiCall()) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: options.getWaitTime(),
    } as unknown as TJobResult
  }

  const job = options.getNextJob()
  if (!job) {
    return null
  }

  return options.processJob(job)
}

/** The outcome of a job that was deleted, or that wasn't running when it ended */
function droppedOutcome(
  state: 'cancelled' | 'not_running',
  job: SyncJobRow,
): JobOutcome {
  if (state === 'not_running') {
    console.warn(`[sync-worker] Job ${job.id} was not running when it ended`)
  }
  return { state, attempts: job.attempts, nextRunAt: null }
}

/**
 * Store how a job ended. `job` is the row read before the job started, so
 * its attempts are the failures before this try. No path leaves the job
 * running.
 */
export function finalizeJobResult(
  jobsService: SyncJobsService,
  job: SyncJobRow,
  result: JobResultLike,
): JobOutcome {
  if (result.success) {
    if (!jobsService.markCompleted(job.id)) {
      console.warn(`[sync-worker] Failed to mark job ${job.id} completed`)
      return { state: 'not_running', attempts: job.attempts, nextRunAt: null }
    }
    return { state: 'completed', attempts: job.attempts, nextRunAt: null }
  }

  const now = Date.now()

  // A FLOOD_WAIT is a delay, not a failure: the job waits and keeps its
  // attempts.
  if (result.rateLimited) {
    const seconds = Math.max(1, result.waitSeconds ?? 0)
    const runAt = now + seconds * 1000
    const retried = jobsService.retryLater(job.id, {
      error: `Rate limited: wait ${seconds}s`,
      runAt,
      countAttempt: false,
    })
    return retried === 'retrying'
      ? { state: 'deferred', attempts: job.attempts, nextRunAt: runAt }
      : droppedOutcome(retried, job)
  }

  const error = result.error ?? 'Job ended without a result'
  const failures = job.attempts + 1

  // Every path drops the job of a chat that was turned off while it ran.
  if (result.permanent || failures >= SYNC_RETRY_CONFIG.maxAttempts) {
    const failed = jobsService.failOrDrop(job.id, error)
    return failed === 'failed'
      ? { state: 'failed', attempts: failures, nextRunAt: null }
      : droppedOutcome(failed, job)
  }

  const runAt = now + retryDelayMs(failures)
  const retried = jobsService.retryLater(job.id, {
    error,
    runAt,
    countAttempt: true,
  })
  return retried === 'retrying'
    ? { state: 'retrying', attempts: failures, nextRunAt: runAt }
    : droppedOutcome(retried, job)
}

/** End a job whose handler threw */
export function failJobResult(
  jobsService: SyncJobsService,
  job: SyncJobRow,
  err: unknown,
): JobResultLike {
  const result: JobResultLike = {
    success: false,
    messagesFetched: 0,
    error: err instanceof Error ? err.message : 'Unknown error',
    permanent: isPermanentSyncError(err),
  }
  return { ...result, outcome: finalizeJobResult(jobsService, job, result) }
}

export async function processJobWithHandlers<
  TContext extends { jobsService: SyncJobsService },
  TResult extends JobResultLike,
>(
  ctx: TContext,
  job: SyncJobRow,
  handlers: Partial<
    Record<SyncJobType, (ctx: TContext, job: SyncJobRow) => Promise<TResult>>
  >,
  unknownResult: (jobType: SyncJobType) => TResult,
): Promise<TResult> {
  const started = ctx.jobsService.markRunning(job.id)
  if (!started) {
    return {
      success: false,
      messagesFetched: 0,
      error: `Job ${job.id} is not pending`,
      outcome: {
        state: 'not_running',
        attempts: job.attempts,
        nextRunAt: null,
      },
    } as TResult
  }

  try {
    const jobType = job.job_type as SyncJobType
    const handler = handlers[jobType]
    const result = handler ? await handler(ctx, job) : unknownResult(jobType)
    return {
      ...result,
      outcome: finalizeJobResult(ctx.jobsService, job, result),
    }
  } catch (err) {
    return failJobResult(ctx.jobsService, job, err) as TResult
  }
}
