import type { Database } from 'bun:sqlite'
import type { TelegramClient } from '@mtcute/bun'
import { pruneCache } from '../db/cache-maintenance'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType } from '../db/sync-schema'
import { getDefaultRetentionConfig } from '../db/types'
import {
  type CatchUpTrigger,
  refreshDialogsAfterReconnect,
} from './daemon-bootstrap'
import type { AccountRuntime, DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'
import { DEFAULT_JOB_EXECUTOR_CONFIG } from './job-executor'
import { createSyncScheduler } from './scheduler'
import { retryDelayMs, SYNC_RETRY_CONFIG } from './sync-retry'
import {
  createRealSyncWorker,
  type RealJobResult,
  type RealSyncWorker,
} from './sync-worker'

/**
 * A sync worker on the account's own cache, rate limits and client. The
 * daemon's stop signal ends the request its job waits on.
 */
function createAccountSyncWorker(
  cacheDb: Database,
  client: TelegramClient,
  signal: AbortSignal,
): RealSyncWorker {
  return createRealSyncWorker({
    client,
    signal,
    messagesCache: createMessagesCache(cacheDb),
    historyRanges: createHistoryRanges(cacheDb),
    chatSyncState: createChatSyncStateService(cacheDb),
    jobsService: createSyncJobsService(cacheDb),
    rateLimits: createRateLimitsService(cacheDb),
    chatsCache: createChatsCache(cacheDb),
  })
}

/** Accounts in ID order, so job starts and logs are stable */
function runtimesInOrder(ctx: DaemonContext): AccountRuntime[] {
  return [...ctx.runtime.accounts.values()].sort(
    (a, b) => a.accountId - b.accountId,
  )
}

/**
 * Give every account that connected a scheduler and a sync worker on its
 * own cache, and queue its startup jobs. One account's failure never stops
 * the others: an account whose scheduler can't be created is left out, and
 * one whose startup pass fails keeps its scheduler and worker, so it runs
 * the jobs it has and the next refresh queues the rest.
 */
export async function initializeScheduler(ctx: DaemonContext): Promise<void> {
  ctx.logger.info('Initializing sync scheduler...')

  for (const rt of runtimesInOrder(ctx)) {
    const tag = `[Account ${rt.accountId}]`
    const accountState = ctx.state.accounts.get(rt.accountId)
    if (accountState?.status !== 'connected' || !accountState.client) {
      ctx.logger.debug(`${tag} Not connected; no sync scheduler`)
      continue
    }

    let scheduler: ReturnType<typeof createSyncScheduler>
    try {
      scheduler = createSyncScheduler({
        db: rt.db,
        jobsService: createSyncJobsService(rt.db),
        chatSyncState: createChatSyncStateService(rt.db),
        messagesCache: createMessagesCache(rt.db),
      })
      rt.worker = createAccountSyncWorker(
        rt.db,
        accountState.client,
        ctx.runtime.shutdown.signal,
      )
      rt.scheduler = scheduler
    } catch (err) {
      rt.scheduler = null
      rt.worker = null
      ctx.logger.error(
        `${tag} Failed to create its scheduler, not syncing it: ${formatError(err)}`,
      )
      continue
    }
    ctx.logger.debug(`${tag} Created sync worker`)

    try {
      await scheduler.initializeForStartup()
      const status = scheduler.getStatus()
      ctx.logger.info(
        `${tag} Scheduler initialized with ${status.pendingJobs} pending jobs`,
      )
    } catch (err) {
      ctx.logger.error(
        `${tag} Failed to initialize scheduler: ${formatError(err)}; its pending jobs still run and the next refresh queues the rest`,
      )
    }
  }
}

/**
 * Give the account a sync worker bound to its new client after a reconnect,
 * and start a dialog pass on it in the background, so the chats that got
 * messages while the connection was down are caught up. Does nothing for an
 * account without a scheduler: before the scheduler starts, after it shuts
 * down, or for an account that didn't connect at startup.
 *
 * Returns the background pass, for tests; callers don't wait for it.
 */
export function rebuildSyncWorker(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
  trigger?: CatchUpTrigger,
): Promise<boolean> | undefined {
  const rt = ctx.runtime.accounts.get(accountId)
  if (!rt?.scheduler) return

  rt.worker = createAccountSyncWorker(
    rt.db,
    client,
    ctx.runtime.shutdown.signal,
  )
  ctx.logger.debug(`[Account ${accountId}] Rebuilt sync worker`)

  return refreshDialogsAfterReconnect(ctx, accountId, client, trigger)
}

/**
 * The account's next job, or null when it can't run one now: while it is
 * not connected, while its worker can't call Telegram (a FLOOD_WAIT), or
 * while its own inter-job delay runs. Each account runs only the jobs in its
 * own cache. An account whose cache fails to answer (a corrupt page, a lock
 * held past busy_timeout) is logged and waits out its delay; the other
 * accounts pick their own jobs.
 */
function pickJob(
  ctx: DaemonContext,
  rt: AccountRuntime,
  now: number,
): { worker: RealSyncWorker; job: SyncJobRow } | null {
  const { scheduler, worker } = rt
  if (!scheduler || !worker) return null

  const accountState = ctx.state.accounts.get(rt.accountId)
  if (accountState?.status !== 'connected' || !accountState.client) return null
  if (
    rt.lastJobProcessTime !== 0 &&
    now - rt.lastJobProcessTime < DEFAULT_JOB_EXECUTOR_CONFIG.interJobDelayMs
  ) {
    return null
  }

  try {
    // Both read the account's cache: rate_limits, then sync_jobs
    if (!worker.canMakeApiCall()) return null
    const job = scheduler.getNextJob()
    return job ? { worker, job } : null
  } catch (err) {
    rt.lastJobProcessTime = now
    ctx.logger.warn(
      `[Account ${rt.accountId}] Failed to pick a job: ${formatError(err)}`,
    )
    return null
  }
}

/** Log a job that didn't succeed, by what happened to its row */
function logJobOutcome(
  ctx: DaemonContext,
  accountId: number,
  job: SyncJobRow,
  result: RealJobResult,
): void {
  const outcome = result.outcome
  const tag = `[Account ${accountId}]`
  const label = `${tag} Job ${job.id} (${job.job_type}, chat ${job.chat_id})`
  switch (outcome?.state) {
    case 'deferred':
      ctx.logger.debug(
        `${tag} Job ${job.id} waits out a FLOOD_WAIT of ${Math.max(1, result.waitSeconds ?? 0)}s`,
      )
      return
    case 'retrying': {
      const minutes = retryDelayMs(outcome.attempts) / 60_000
      ctx.logger.warn(
        `${label} failed, attempt ${outcome.attempts} of ${SYNC_RETRY_CONFIG.maxAttempts}, retry in ${minutes}m: ${result.error}`,
      )
      return
    }
    case 'failed': {
      const why = result.permanent
        ? 'permanent error'
        : `after ${outcome.attempts} attempts`
      ctx.logger.warn(
        `${label} failed for good (${why}): ${result.error}; retried after 24 h or on daemon restart, and tg status shows the tg chats sync command that retries it sooner`,
      )
      return
    }
    case 'stopped':
      // The stop cut its request short; no fault of the job
      ctx.logger.debug(
        `${tag} Job ${job.id} left pending: the daemon is stopping`,
      )
      return
    case 'cancelled':
      ctx.logger.debug(
        `${tag} Job ${job.id} dropped: chat ${job.chat_id} was turned off while it ran`,
      )
      return
    case 'not_running':
      ctx.logger.debug(`${tag} Job ${job.id} did not run: ${result.error}`)
      return
  }

  if (result.rateLimited) {
    ctx.logger.debug(
      `${tag} Job ${job.id} rate limited: wait ${result.waitSeconds}s`,
    )
  } else {
    ctx.logger.warn(`${tag} Job ${job.id} failed: ${result.error}`)
  }
}

async function runJob(
  ctx: DaemonContext,
  rt: AccountRuntime,
  worker: RealSyncWorker,
  job: SyncJobRow,
): Promise<void> {
  const scheduler = rt.scheduler!
  const tag = `[Account ${rt.accountId}]`

  ctx.logger.debug(
    `${tag} Processing job ${job.id}: ${job.job_type} for chat ${job.chat_id}`,
  )

  try {
    const result = await worker.processJobReal(job)

    if (result.success) {
      rt.messagesSynced += result.messagesFetched

      ctx.logger.debug(
        `${tag} Job ${job.id} completed: ${result.messagesFetched} messages fetched`,
      )

      if (result.hasMore) {
        if (job.job_type === SyncJobType.BackwardHistory) {
          scheduler.queueBackwardHistory(job.chat_id)
        } else if (job.job_type === SyncJobType.ForwardCatchup) {
          scheduler.queueForwardCatchup(job.chat_id)
        }
      }

      // History starts right after the first page instead of waiting for
      // the next refresh.
      if (
        job.job_type === SyncJobType.InitialLoad &&
        result.historyComplete === false
      ) {
        scheduler.queueBackwardHistory(job.chat_id)
      }
    } else {
      logJobOutcome(ctx, rt.accountId, job, result)
    }
  } catch (err) {
    ctx.logger.error(`${tag} Job ${job.id} error: ${formatError(err)}`)
  } finally {
    // The job used its lane's slot, whatever the outcome; the account's
    // delay counts from its end.
    scheduler.recordJobRun(job)
    rt.lastJobProcessTime = Date.now()
  }
}

/**
 * Start the next job of every account that has none running and can run
 * one now (#60). Each account runs one job at a time, 3 s after its last
 * one ended, and never waits for another account's job: a FLOOD_WAIT or a
 * slow page holds only its own account. Returns the started jobs, which
 * never reject; each leaves `jobsInFlight` when it ends.
 */
export function startDueJobs(ctx: DaemonContext): Promise<void>[] {
  if (ctx.state.shutdownRequested) return []

  const now = Date.now()
  const started: Promise<void>[] = []
  for (const rt of runtimesInOrder(ctx)) {
    const id = rt.accountId
    if (ctx.runtime.jobsInFlight.has(id)) continue
    const picked = pickJob(ctx, rt, now)
    if (!picked) continue

    const { worker, job } = picked
    const p = runJob(ctx, rt, worker, job)
      .catch((err) => {
        ctx.logger.error(
          `[Account ${id}] Job ${job.id} error: ${formatError(err)}`,
        )
      })
      .finally(() => {
        ctx.runtime.jobsInFlight.delete(id)
      })
    ctx.runtime.jobsInFlight.set(id, p)
    started.push(p)
  }
  return started
}

/** Run every due account's next job and wait for them: tests, one-shot use */
export async function processJobs(ctx: DaemonContext): Promise<void> {
  await Promise.all(startDueJobs(ctx))
}

/** Wait for every account's running sync job to end */
export async function waitForJobsInFlight(ctx: DaemonContext): Promise<void> {
  await Promise.allSettled([...ctx.runtime.jobsInFlight.values()])
}

/**
 * Prune every account's cache: old API activity, rate limit windows and
 * finished sync jobs, by the retention read at start. Every account whose
 * cache is open is pruned, with a scheduler or not, and one whose cache
 * fails is logged and doesn't stop the others.
 */
export function cleanupOldJobs(ctx: DaemonContext): void {
  const retention = ctx.retention ?? getDefaultRetentionConfig()
  for (const rt of runtimesInOrder(ctx)) {
    try {
      const pruned = pruneCache(rt.db, retention)
      const total =
        pruned.api_activity +
        pruned.rate_limits +
        pruned.completed_jobs +
        pruned.failed_jobs
      if (total > 0) {
        ctx.logger.debug(
          `[Account ${rt.accountId}] Pruned ${pruned.api_activity} API activity rows, ${pruned.rate_limits} rate limit windows, ${pruned.completed_jobs} completed and ${pruned.failed_jobs} failed jobs`,
        )
      }
    } catch (err) {
      ctx.logger.warn(
        `[Account ${rt.accountId}] Failed to prune its cache: ${formatError(err)}`,
      )
    }
  }
}

/** Queue the work that is due, in every account's cache */
export function refreshAllQueues(ctx: DaemonContext): void {
  for (const rt of runtimesInOrder(ctx)) {
    if (!rt.scheduler) continue
    try {
      rt.scheduler.refreshQueues()
    } catch (err) {
      ctx.logger.warn(
        `[Account ${rt.accountId}] Failed to refresh sync queues: ${formatError(err)}`,
      )
    }
  }
}

/**
 * Wait for the running jobs, then drop every account's scheduler and
 * worker, so a cache or client is never closed under a job. Call it after
 * `requestShutdown`: the stop ends the request each job waits on.
 */
export async function cleanupScheduler(ctx: DaemonContext): Promise<void> {
  await waitForJobsInFlight(ctx)
  cleanupOldJobs(ctx)
  for (const rt of ctx.runtime.accounts.values()) {
    rt.worker = null
    rt.scheduler = null
  }
}
