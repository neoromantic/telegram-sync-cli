import type { TelegramClient } from '@mtcute/bun'
import { getCacheDb } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType } from '../db/sync-schema'
import { refreshDialogsAfterReconnect } from './daemon-bootstrap'
import type { DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'
import { DEFAULT_JOB_EXECUTOR_CONFIG } from './job-executor'
import { createSyncScheduler } from './scheduler'
import { retryDelayMs, SYNC_RETRY_CONFIG } from './sync-retry'
import {
  createRealSyncWorker,
  type RealJobResult,
  type RealSyncWorker,
} from './sync-worker'

function createAccountSyncWorker(client: TelegramClient): RealSyncWorker {
  const cacheDb = getCacheDb()
  return createRealSyncWorker({
    client,
    messagesCache: createMessagesCache(cacheDb),
    historyRanges: createHistoryRanges(cacheDb),
    chatSyncState: createChatSyncStateService(cacheDb),
    jobsService: createSyncJobsService(cacheDb),
    rateLimits: createRateLimitsService(cacheDb),
    chatsCache: createChatsCache(cacheDb),
  })
}

export async function initializeScheduler(ctx: DaemonContext): Promise<void> {
  const cacheDb = getCacheDb()

  ctx.runtime.scheduler = createSyncScheduler({
    db: cacheDb,
    jobsService: createSyncJobsService(cacheDb),
    chatSyncState: createChatSyncStateService(cacheDb),
    messagesCache: createMessagesCache(cacheDb),
  })

  for (const [accountId, accountState] of ctx.state.accounts) {
    if (accountState.status === 'connected' && accountState.client) {
      ctx.runtime.syncWorkers.set(
        accountId,
        createAccountSyncWorker(accountState.client),
      )
      ctx.logger.debug(`Created sync worker for account ${accountId}`)
    }
  }

  ctx.logger.info('Initializing sync scheduler...')
  await ctx.runtime.scheduler.initializeForStartup()

  const status = ctx.runtime.scheduler.getStatus()
  ctx.logger.info(
    `Scheduler initialized with ${status.pendingJobs} pending jobs`,
  )
}

/**
 * Give the account a sync worker bound to its new client after a reconnect,
 * and start a dialog pass on it in the background, so the chats that got
 * messages while the connection was down are caught up. Does nothing before
 * the scheduler starts or after it shuts down.
 *
 * Returns the background pass, for tests; callers don't wait for it.
 */
export function rebuildSyncWorker(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
): Promise<void> | undefined {
  if (!ctx.runtime.scheduler) return

  ctx.runtime.syncWorkers.set(accountId, createAccountSyncWorker(client))
  ctx.logger.debug(`Rebuilt sync worker for account ${accountId}`)

  return refreshDialogsAfterReconnect(ctx, accountId, client)
}

function selectAvailableWorker(ctx: DaemonContext): {
  worker: RealSyncWorker | null
  accountId: number | null
} {
  for (const [accountId, worker] of ctx.runtime.syncWorkers) {
    const accountState = ctx.state.accounts.get(accountId)
    if (
      accountState?.status === 'connected' &&
      accountState.client &&
      worker.canMakeApiCall()
    ) {
      return { worker, accountId }
    }
  }

  return { worker: null, accountId: null }
}

function canProcessJob(ctx: DaemonContext, now: number): boolean {
  if (!ctx.runtime.scheduler) return false

  return (
    ctx.runtime.lastJobProcessTime === 0 ||
    now - ctx.runtime.lastJobProcessTime >=
      DEFAULT_JOB_EXECUTOR_CONFIG.interJobDelayMs
  )
}

function getJobContext(ctx: DaemonContext, now: number) {
  if (!canProcessJob(ctx, now)) return null

  const scheduler = ctx.runtime.scheduler!
  const job = scheduler.getNextJob()
  if (!job) return null

  const { worker } = selectAvailableWorker(ctx)
  if (!worker) {
    ctx.logger.debug('No available sync worker for pending job')
    return null
  }

  return { scheduler, job, worker }
}

/** Log a job that didn't succeed, by what happened to its row */
function logJobOutcome(
  ctx: DaemonContext,
  job: SyncJobRow,
  result: RealJobResult,
): void {
  const outcome = result.outcome
  const label = `Job ${job.id} (${job.job_type}, chat ${job.chat_id})`
  switch (outcome?.state) {
    case 'deferred':
      ctx.logger.debug(
        `Job ${job.id} waits out a FLOOD_WAIT of ${Math.max(1, result.waitSeconds ?? 0)}s`,
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
        `${label} failed for good (${why}): ${result.error}; retried after 24 h, on daemon restart or with tg chats sync`,
      )
      return
    }
    case 'cancelled':
      ctx.logger.debug(
        `Job ${job.id} dropped: chat ${job.chat_id} was turned off while it ran`,
      )
      return
    case 'not_running':
      ctx.logger.debug(`Job ${job.id} did not run: ${result.error}`)
      return
  }

  if (result.rateLimited) {
    ctx.logger.debug(`Job ${job.id} rate limited: wait ${result.waitSeconds}s`)
  } else {
    ctx.logger.warn(`Job ${job.id} failed: ${result.error}`)
  }
}

export async function processJobs(ctx: DaemonContext): Promise<void> {
  const now = Date.now()
  const context = getJobContext(ctx, now)
  if (!context) return

  const { scheduler, job, worker } = context

  ctx.logger.debug(
    `Processing job ${job.id}: ${job.job_type} for chat ${job.chat_id}`,
  )

  try {
    const result = await worker.processJobReal(job)

    if (result.success) {
      ctx.runtime.totalMessagesSynced += result.messagesFetched

      ctx.logger.debug(
        `Job ${job.id} completed: ${result.messagesFetched} messages fetched`,
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
      logJobOutcome(ctx, job, result)
    }
  } catch (err) {
    ctx.logger.error(`Job ${job.id} error: ${formatError(err)}`)
  } finally {
    // The job used its lane's slot, whatever the outcome.
    scheduler.recordJobRun(job)
    ctx.runtime.lastJobProcessTime = Date.now()
  }
}

export function cleanupScheduler(ctx: DaemonContext): void {
  if (ctx.runtime.scheduler) {
    const cleaned = ctx.runtime.scheduler.cleanup(24 * 60 * 60 * 1000)
    if (cleaned > 0) {
      ctx.logger.debug(`Cleaned up ${cleaned} old jobs`)
    }
  }

  ctx.runtime.syncWorkers.clear()
  ctx.runtime.scheduler = null
}
