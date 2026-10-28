/**
 * The daemon's share of the background migrations (#89): a few batches per
 * tick, after the tick's sync work, with the event loop free between
 * batches, so live updates and sync jobs never wait for more than one.
 */
import {
  type BatchLimits,
  DEFAULT_BATCH_LIMITS,
  hasPendingMigrations,
  runPendingMigrations,
} from '../db/background-migrations'
import type { DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'

/** The most each tick spends on migrations, over every account */
export const MIGRATION_TICK_BUDGET_MS = 250
/** After a batch fails, the account's migrations wait this long */
export const MIGRATION_RETRY_DELAY_MS = 60_000

export interface MigrationsState {
  /** Accounts with nothing left to migrate: never checked again */
  finished: Set<number>
  /** Per account: no batch before this time, after a failed one */
  retryAt: Map<number, number>
}

export function createMigrationsState(): MigrationsState {
  return { finished: new Set(), retryAt: new Map() }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export interface MigrationTickOptions {
  budgetMs?: number
  limits?: BatchLimits
  now?: () => number
}

/** Run pending migrations of each account until the tick's budget is spent */
export async function runMigrationsTick(
  ctx: DaemonContext,
  options: MigrationTickOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now
  const state = ctx.runtime.migrations
  const deadline = now() + (options.budgetMs ?? MIGRATION_TICK_BUDGET_MS)
  const outOfTime = () => ctx.state.shutdownRequested || now() >= deadline
  const limits = { ...(options.limits ?? DEFAULT_BATCH_LIMITS), now }

  for (const rt of ctx.runtime.accounts.values()) {
    if (outOfTime()) return
    if (state.finished.has(rt.accountId)) continue
    if ((state.retryAt.get(rt.accountId) ?? 0) > now()) continue

    try {
      await runPendingMigrations(rt.db, {
        limits,
        shouldStop: outOfTime,
        yieldBetweenBatches: yieldToEventLoop,
        onBatch: (migration, status) => {
          if (status.state === 'done') {
            ctx.logger.info(
              `[Account ${rt.accountId}] Migration ${migration.name} done: ${status.done} rows`,
            )
          }
        },
      })
      if (!hasPendingMigrations(rt.db)) state.finished.add(rt.accountId)
    } catch (err) {
      ctx.logger.warn(
        `[Account ${rt.accountId}] Background migration failed, retrying in ${MIGRATION_RETRY_DELAY_MS / 1000}s: ${formatError(err)}`,
      )
      state.retryAt.set(rt.accountId, now() + MIGRATION_RETRY_DELAY_MS)
    }
  }
}
