import { SyncJobStatus } from '../db/sync-schema'
import { attemptReconnect, scheduleReconnect } from './daemon-accounts'
import type { AccountRuntime, DaemonContext } from './daemon-context'
import {
  cleanupOldJobs,
  refreshAllQueues,
  startDueJobs,
} from './daemon-scheduler'
import { formatError, getErrorMessage } from './daemon-utils'

const HEALTH_CHECK_INTERVAL_TICKS = 60
const HEALTH_CHECK_COOLDOWN_MS = 60_000
const SCHEDULER_REFRESH_INTERVAL_TICKS = 30

function jobCounts(rt: AccountRuntime): { pending: number; running: number } {
  if (rt.scheduler) {
    const status = rt.scheduler.getStatus()
    return { pending: status.pendingJobs, running: status.runningJobs }
  }
  // An account that didn't connect keeps its queue; db.query caches the
  // statement
  const row = rt.db
    .query(
      `SELECT COALESCE(SUM(status = $pending), 0) AS pending,
              COALESCE(SUM(status = $running), 0) AS running
       FROM sync_jobs`,
    )
    .get({
      $pending: SyncJobStatus.Pending,
      $running: SyncJobStatus.Running,
    }) as { pending: number; running: number } | null
  return { pending: row?.pending ?? 0, running: row?.running ?? 0 }
}

/**
 * Write each account's figures to its own cache, one transaction each. The
 * main loop does it every tick; the start does it after the connections and
 * after the schedulers start, so tg status is current during a long dialog
 * pass.
 */
export async function updateDaemonStatus(ctx: DaemonContext): Promise<void> {
  for (const rt of ctx.runtime.accounts.values()) {
    const accountState = ctx.state.accounts.get(rt.accountId)
    try {
      const { pending, running } = jobCounts(rt)
      rt.statusService.writeTick({
        connectionStatus: accountState?.status ?? 'disconnected',
        lastError: accountState?.lastError ?? null,
        messagesSynced: rt.messagesSynced,
        pendingJobs: pending,
        runningJobs: running,
      })
    } catch (err) {
      ctx.logger.warn(
        `[Account ${rt.accountId}] Failed to update daemon status: ${formatError(err)}`,
      )
    }
  }
}

/**
 * Sleep `ms`, or less if the daemon stops meanwhile. The timer is set last:
 * a test's setTimeout may call `done` at once.
 */
function sleepUnlessStopped(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    timer = setTimeout(done, ms)
  })
}

async function runHealthChecks(ctx: DaemonContext, now: number): Promise<void> {
  for (const accountState of ctx.state.accounts.values()) {
    // A running job uses the connection; a reconnect would close its client
    if (ctx.runtime.jobsInFlight.has(accountState.accountId)) continue

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

export async function mainLoop(ctx: DaemonContext): Promise<void> {
  ctx.logger.debug('Starting main event loop...')

  let loopIteration = 0
  const cleanupInterval = 300

  while (!ctx.state.shutdownRequested) {
    loopIteration++
    const now = Date.now()

    try {
      // Each account's job runs on its own; the loop doesn't wait for it
      startDueJobs(ctx)
    } catch (err) {
      ctx.logger.warn(`Error processing jobs: ${formatError(err)}`)
    }

    // A stop as a job starts: no health check, refresh, tick or wait. The
    // shutdown waits for the jobs and marks every account stopped.
    if (ctx.state.shutdownRequested) break

    if (loopIteration % HEALTH_CHECK_INTERVAL_TICKS === 0) {
      await runHealthChecks(ctx, now)
    }

    if (loopIteration % SCHEDULER_REFRESH_INTERVAL_TICKS === 0) {
      refreshAllQueues(ctx)
    }

    try {
      await updateDaemonStatus(ctx)
    } catch (err) {
      ctx.logger.warn(`Failed to update daemon status: ${formatError(err)}`)
    }

    if (loopIteration % cleanupInterval === 0) {
      cleanupOldJobs(ctx)
    }

    await sleepUnlessStopped(1000, ctx.runtime.shutdown.signal)
  }

  ctx.logger.debug('Main loop exiting...')
}
