import { getCacheDb } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { SyncJobType } from '../db/sync-schema'
import type { DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'
import { DEFAULT_JOB_EXECUTOR_CONFIG } from './job-executor'
import { createSyncScheduler } from './scheduler'
import { createRealSyncWorker, type RealSyncWorker } from './sync-worker'

export async function initializeScheduler(ctx: DaemonContext): Promise<void> {
  const cacheDb = getCacheDb()
  const messagesCache = createMessagesCache(cacheDb)
  const chatSyncState = createChatSyncStateService(cacheDb)
  const jobsService = createSyncJobsService(cacheDb)
  const rateLimits = createRateLimitsService(cacheDb)
  const chatsCache = createChatsCache(cacheDb)

  ctx.runtime.scheduler = createSyncScheduler({
    db: cacheDb,
    jobsService,
    chatSyncState,
    messagesCache,
  })

  for (const [accountId, accountState] of ctx.state.accounts) {
    if (accountState.status === 'connected' && accountState.client) {
      const worker = createRealSyncWorker({
        client: accountState.client,
        messagesCache,
        chatSyncState,
        jobsService,
        rateLimits,
        chatsCache,
      })

      ctx.runtime.syncWorkers.set(accountId, worker)
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
    } else if (result.rateLimited) {
      ctx.logger.debug(
        `Job ${job.id} rate limited: wait ${result.waitSeconds}s`,
      )
    } else {
      ctx.logger.warn(`Job ${job.id} failed: ${result.error}`)
    }
  } catch (err) {
    ctx.logger.error(`Job ${job.id} error: ${formatError(err)}`)
  } finally {
    ctx.runtime.lastJobProcessTime = Date.now()
  }
}

export function cleanupScheduler(ctx: DaemonContext): void {
  if (ctx.runtime.scheduler) {
    const cleaned = ctx.runtime.scheduler.cleanup(24 * 60 * 60 * 1000)
    if (cleaned > 0) {
      ctx.logger.debug(`Cleaned up ${cleaned} old completed jobs`)
    }
  }

  ctx.runtime.syncWorkers.clear()
  ctx.runtime.scheduler = null
}
