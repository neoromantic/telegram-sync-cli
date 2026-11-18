import { SyncJobStatus } from "../db/sync-schema";
import { attemptReconnect, scheduleReconnect } from "./daemon-accounts";
import { detectWake, runDueCatchUps } from "./daemon-catch-up";
import { maybeSyncContacts } from "./daemon-contacts";
import type { AccountRuntime, DaemonContext } from "./daemon-context";
import { accountLabel } from "./daemon-logger";
import { runMigrationsTick } from "./daemon-migrations";
import { cleanupOldJobs, nextJobDueAt, refreshAllQueues, startDueJobs } from "./daemon-scheduler";
import { formatError, getErrorMessage } from "./daemon-utils";

const HEALTH_CHECK_INTERVAL_TICKS = 60;
const HEALTH_CHECK_COOLDOWN_MS = 60_000;
const SCHEDULER_REFRESH_INTERVAL_TICKS = 30;

function jobCounts(rt: AccountRuntime) {
  const row = rt.db
    .query(
      `SELECT COALESCE(SUM(status = $pending), 0) AS pending,
              COALESCE(SUM(status = $running), 0) AS running
       FROM sync_jobs`,
    )
    .get({
      $pending: SyncJobStatus.Pending,
      $running: SyncJobStatus.Running,
    }) as { pending: number; running: number } | null;
  return { pending: row?.pending ?? 0, running: row?.running ?? 0 };
}

/**
 * Write each account's figures to its own cache, one transaction each. The
 * main loop does it every tick; the start does it after the connections and
 * after the schedulers start, so tg status is current during a long dialog
 * pass.
 */
export async function updateDaemonStatus(ctx: DaemonContext) {
  for (const rt of ctx.runtime.accounts.values()) {
    const accountState = ctx.state.accounts.get(rt.accountId);
    try {
      const { pending, running } = jobCounts(rt);
      rt.statusService.writeTick({
        connectionStatus: accountState?.status ?? "disconnected",
        lastError: accountState?.lastError ?? null,
        messagesSynced: rt.messagesSynced,
        pendingJobs: pending,
        runningJobs: running,
        pacing: rt.pacer.snapshot(),
      });
    } catch (err) {
      ctx.logger.warn(
        `[Account ${rt.accountId}] Failed to update daemon status: ${formatError(err)}`,
      );
    }
  }
}

function sleepUnlessStopped(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    timer = setTimeout(done, ms);
  });
}

type TickClock = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

const realClock: TickClock = { now: () => Date.now(), sleep: sleepUnlessStopped };

/**
 * Wait out the rest of a tick, starting each account's job when its pace
 * makes it due, not at the next tick (#133). A stop ends the wait at once.
 * Exported for tests, which pass a clock and a sleep of their own.
 */
export async function waitForNextTick(ctx: DaemonContext, tickMs: number, clock = realClock) {
  const signal = ctx.runtime.shutdown.signal;
  let now = clock.now();
  const end = now + tickMs;
  for (;;) {
    const due = nextJobDueAt(ctx, now);
    if (due === null || due >= end) break;
    await clock.sleep(due - now, signal);
    if (ctx.state.shutdownRequested) return;
    startDueJobs(ctx);
    const after = clock.now();
    if (after <= now) break;
    now = after;
  }
  await clock.sleep(Math.max(0, end - now), signal);
}

async function runHealthChecks(ctx: DaemonContext, now: number) {
  for (const accountState of ctx.state.accounts.values()) {
    if (accountState.status === "connected" && accountState.client) {
      const lastActivity = accountState.lastActivity ?? 0;
      if (now - lastActivity < HEALTH_CHECK_COOLDOWN_MS) {
        continue;
      }
      try {
        await accountState.client.getMe();
        accountState.lastActivity = Date.now();
      } catch (err) {
        ctx.logger.warn(
          `Connection health check failed for ${accountLabel(accountState)}: ${getErrorMessage(err)}`,
        );
        accountState.status = "error";
        accountState.lastError = getErrorMessage(err);
        if (accountState.watch) accountState.watch.offlineSince ??= now;
        scheduleReconnect(ctx, accountState);
      }
    }

    if (
      accountState.status === "error" &&
      accountState.nextReconnectAt &&
      now >= accountState.nextReconnectAt &&
      !ctx.runtime.jobsInFlight.has(accountState.accountId)
    ) {
      attemptReconnect(ctx, accountState).catch((err) => {
        ctx.logger.error(`Unexpected error during reconnection: ${formatError(err)}`);
      });
    }
  }
}

export async function mainLoop(ctx: DaemonContext, clock = realClock) {
  ctx.logger.debug("Starting main event loop...");

  let loopIteration = 0;
  const cleanupInterval = 300;

  while (!ctx.state.shutdownRequested) {
    loopIteration++;
    const now = Date.now();

    try {
      startDueJobs(ctx);
    } catch (err) {
      ctx.logger.warn(`Error processing jobs: ${formatError(err)}`);
    }

    if (ctx.state.shutdownRequested) break;

    detectWake(ctx, now);
    void runDueCatchUps(ctx, now);

    if (loopIteration === 1 || loopIteration % SCHEDULER_REFRESH_INTERVAL_TICKS === 0) {
      void maybeSyncContacts(ctx, now);
    }

    if (loopIteration % HEALTH_CHECK_INTERVAL_TICKS === 0) {
      await runHealthChecks(ctx, now);
    }

    if (loopIteration % SCHEDULER_REFRESH_INTERVAL_TICKS === 0) {
      refreshAllQueues(ctx);
    }

    try {
      await updateDaemonStatus(ctx);
    } catch (err) {
      ctx.logger.warn(`Failed to update daemon status: ${formatError(err)}`);
    }

    if (loopIteration % cleanupInterval === 0) {
      cleanupOldJobs(ctx);
    }

    await runMigrationsTick(ctx);

    await waitForNextTick(ctx, 1000, clock);
  }

  ctx.logger.debug("Main loop exiting...");
}
