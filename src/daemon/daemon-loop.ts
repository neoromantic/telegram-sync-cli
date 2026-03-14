import { attemptReconnect, scheduleReconnect } from './daemon-accounts'
import type { DaemonContext } from './daemon-context'
import { processJobs } from './daemon-scheduler'
import { formatError, getErrorMessage } from './daemon-utils'

const HEALTH_CHECK_INTERVAL_TICKS = 60
const HEALTH_CHECK_COOLDOWN_MS = 60_000
const SCHEDULER_REFRESH_INTERVAL_TICKS = 30

async function updateDaemonStatus(ctx: DaemonContext): Promise<void> {
  const statusService = ctx.runtime.statusService
  if (!statusService) {
    return
  }

  const connectedCount = Array.from(ctx.state.accounts.values()).filter(
    (a) => a.status === 'connected',
  ).length

  statusService.setConnectedAccounts(connectedCount, ctx.state.accounts.size)
  statusService.setMessagesSynced(ctx.runtime.totalMessagesSynced)
  statusService.updateLastUpdate()

  if (ctx.runtime.scheduler) {
    const schedulerStatus = ctx.runtime.scheduler.getStatus()
    statusService.set('pending_jobs', String(schedulerStatus.pendingJobs))
    statusService.set('running_jobs', String(schedulerStatus.runningJobs))
  }
}

async function runHealthChecks(ctx: DaemonContext, now: number): Promise<void> {
  for (const accountState of ctx.state.accounts.values()) {
    if (accountState.status === 'connected' && accountState.client) {
      const lastActivity = accountState.lastActivity ?? 0
      if (now - lastActivity < HEALTH_CHECK_COOLDOWN_MS) {
        continue
      }
      try {
        await accountState.client.getMe()
        accountState.lastActivity = Date.now()
      } catch (err) {
        ctx.logger.warn(
          `Connection health check failed for ${accountState.phone}: ${formatError(err)}`,
        )
        accountState.status = 'error'
        accountState.lastError = getErrorMessage(err)
        scheduleReconnect(ctx, accountState)
      }
    }

    if (
      accountState.status === 'error' &&
      accountState.nextReconnectAt &&
      now >= accountState.nextReconnectAt
    ) {
      attemptReconnect(ctx, accountState).catch((err) => {
        ctx.logger.error(
          `Unexpected error during reconnection: ${formatError(err)}`,
        )
      })
    }
  }
}

async function cleanupOldJobs(ctx: DaemonContext): Promise<void> {
  if (!ctx.runtime.scheduler) return

  const cleaned = ctx.runtime.scheduler.cleanup(24 * 60 * 60 * 1000)
  if (cleaned > 0) {
    ctx.logger.debug(`Cleaned up ${cleaned} old completed jobs`)
  }
}

export async function mainLoop(ctx: DaemonContext): Promise<void> {
  ctx.logger.debug('Starting main event loop...')

  let loopIteration = 0
  const cleanupInterval = 300

  while (!ctx.state.shutdownRequested) {
    loopIteration++
    const now = Date.now()

    try {
      await processJobs(ctx)
    } catch (err) {
      ctx.logger.warn(`Error processing jobs: ${formatError(err)}`)
    }

    if (loopIteration % HEALTH_CHECK_INTERVAL_TICKS === 0) {
      await runHealthChecks(ctx, now)
    }

    if (loopIteration % SCHEDULER_REFRESH_INTERVAL_TICKS === 0) {
      try {
        ctx.runtime.scheduler?.refreshQueues()
      } catch (err) {
        ctx.logger.warn(`Failed to refresh sync queues: ${formatError(err)}`)
      }
    }

    try {
      await updateDaemonStatus(ctx)
    } catch (err) {
      ctx.logger.warn(`Failed to update daemon status: ${formatError(err)}`)
    }

    if (loopIteration % cleanupInterval === 0) {
      try {
        await cleanupOldJobs(ctx)
      } catch (err) {
        ctx.logger.warn(`Failed to cleanup old jobs: ${formatError(err)}`)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  ctx.logger.debug('Main loop exiting...')
}
