/**
 * The daemon's background migrations (#89): a budget per tick, a clean
 * stop, a wait after a failure. Made-up data only.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, it, mock } from 'bun:test'

import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import {
  MIGRATION_RETRY_DELAY_MS,
  runMigrationsTick,
} from '../daemon/daemon-migrations'
import { readMigrationStatus } from '../db/background-migrations'
import { addAccountRuntime } from './helpers/daemon-runtime'
import { seedOldFormCache } from './helpers/old-form-cache'

const LIMITS = { maxRows: 4, maxMs: 1_000 }

function createContext(): DaemonContext {
  return {
    logger: {
      info: mock(() => {}),
      debug: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
    state: { running: true, accounts: new Map(), shutdownRequested: false },
    runtime: createDaemonRuntime(),
  } as unknown as DaemonContext
}

function oldCache(): Database {
  const db = new Database(':memory:')
  seedOldFormCache(db, { messages: 10 })
  return db
}

function states(db: Database) {
  return readMigrationStatus(db).map((status) => status.state)
}

describe('runMigrationsTick', () => {
  it("finishes each account's migrations and then leaves them alone", async () => {
    const ctx = createContext()
    const first = addAccountRuntime(ctx, 1, oldCache())
    const second = addAccountRuntime(ctx, 2, oldCache())

    await runMigrationsTick(ctx, { budgetMs: 60_000, limits: LIMITS })

    expect(states(first.db)).toEqual(['done', 'done', 'done', 'done'])
    expect(states(second.db)).toEqual(['done', 'done', 'done', 'done'])
    expect([...ctx.runtime.migrations.finished]).toEqual([1, 2])
    expect(ctx.logger.info).toHaveBeenCalledWith(
      '[Account 1] Migration messages_raw_json_v2 done: 10 rows',
    )
  })

  it('stops when the tick budget is spent and goes on next tick', async () => {
    const ctx = createContext()
    const rt = addAccountRuntime(ctx, 1, oldCache())
    let clock = 0
    // Every reading of the clock is 1 ms later; the budget is 10
    const now = () => clock++

    await runMigrationsTick(ctx, { budgetMs: 10, limits: LIMITS, now })
    const [messages] = readMigrationStatus(rt.db)
    expect(messages).toMatchObject({ state: 'running' })
    expect(messages!.done).toBeLessThan(10)

    await runMigrationsTick(ctx, { budgetMs: 60_000, limits: LIMITS })
    expect(states(rt.db)).toEqual(['done', 'done', 'done', 'done'])
  })

  it('runs no batch once the daemon is stopping', async () => {
    const ctx = createContext()
    const rt = addAccountRuntime(ctx, 1, oldCache())
    ctx.state.shutdownRequested = true

    await runMigrationsTick(ctx, { budgetMs: 60_000, limits: LIMITS })

    expect(states(rt.db)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('waits before trying an account whose batch failed again', async () => {
    const ctx = createContext()
    const db = oldCache()
    addAccountRuntime(ctx, 1, db)
    db.run('DROP TABLE message_attachments')

    await runMigrationsTick(ctx, {
      budgetMs: 60_000,
      limits: LIMITS,
      now: () => 0,
    })

    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(ctx.runtime.migrations.retryAt.get(1)).toBe(MIGRATION_RETRY_DELAY_MS)
    expect(readMigrationStatus(db)[0]!.last_error).toContain(
      'message_attachments',
    )

    await runMigrationsTick(ctx, {
      budgetMs: 60_000,
      limits: LIMITS,
      now: () => 1,
    })
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })
})
