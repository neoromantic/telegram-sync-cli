/**
 * Tests for daemon main loop control flow (no module mocks)
 */
import { describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import type { DaemonContext } from '../daemon/daemon-context'
import { createDaemonRuntime } from '../daemon/daemon-context'
import { mainLoop } from '../daemon/daemon-loop'
import type { SyncScheduler } from '../daemon/scheduler'
import type { AccountConnectionState } from '../daemon/types'
import type { DaemonStatusService, DaemonTick } from '../db/daemon-status'
import { SyncJobType, SyncPriority } from '../db/sync-schema'
import {
  addAccountRuntime,
  createAccountCacheDb,
} from './helpers/daemon-runtime'

function createMockStatusService(
  overrides: Partial<DaemonStatusService> = {},
): DaemonStatusService {
  const base: DaemonStatusService = {
    get: () => null,
    set: () => {},
    delete: () => {},
    getAll: () => ({}),
    clear: () => {},
    setDaemonRunning: () => {},
    setDaemonStopped: () => {},
    isDaemonRunning: () => false,
    updateLastUpdate: () => {},
    setMessagesSynced: () => {},
    writeTick: () => {},
    getDaemonInfo: () => ({
      status: 'running',
      pid: null,
      version: null,
      startedAt: null,
      lastUpdate: null,
      connectionStatus: null,
      lastError: null,
      messagesSynced: 0,
      pendingJobs: 0,
      runningJobs: 0,
    }),
  }
  return { ...base, ...overrides }
}

function createMockScheduler(
  overrides: Partial<SyncScheduler> = {},
): SyncScheduler {
  const base: SyncScheduler = {
    queueForwardCatchup: () => {},
    queueBackwardHistory: () => {},
    queueInitialLoad: () => {},
    initializeForStartup: async () => {},
    refreshQueues: () => {},
    getNextJob: () => null,
    recordJobRun: () => {},
    claimNextJob: () => null,
    startJob: () => false,
    completeJob: () => false,
    failJob: () => false,
    updateProgress: () => {},
    getStatus: () => ({
      pendingJobs: 0,
      runningJobs: 0,
      jobsByType: {},
      jobsByPriority: {},
    }),
    cleanup: () => 0,
    cancelJobsForChat: () => 0,
    recoverCrashedJobs: () => 0,
  }
  return { ...base, ...overrides }
}

function createLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

function createContext(): DaemonContext {
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli/daemon.pid',
    verbosity: 'quiet',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 2,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: createLogger(),
    pidFile: {
      acquire: () => {},
      release: () => {},
      read: () => null,
      isRunning: () => false,
      sendSignal: () => false,
      getPath: () => '/tmp/tgcli/daemon.pid',
    },
    state: {
      running: false,
      accounts: new Map(),
      shutdownRequested: false,
    },
    accountsDb: {
      getAll: () => [],
      getById: () => null,
      getByPhone: () => null,
      getByUserId: () => null,
      getByUsername: () => null,
      getAllByLabel: () => [],
      getActive: () => null,
      create: () => {
        throw new Error('not used')
      },
      update: () => null,
      updateSession: () => {},
      setActive: () => {},
      delete: () => false,
      count: () => 0,
    },
    runtime: createDaemonRuntime(),
  }
}

async function runWithImmediateTimeouts(run: () => Promise<void>) {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    callback()
    return 0 as unknown as NodeJS.Timeout
  }) as typeof setTimeout

  try {
    await run()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
}

/** Stop the loop after `ticks` status writes of account 1 */
function stopAfterTicks(ctx: DaemonContext, ticks: number) {
  let count = 0
  return createMockStatusService({
    writeTick: () => {
      count += 1
      if (count >= ticks) ctx.state.shutdownRequested = true
    },
  })
}

describe('mainLoop', () => {
  it('logs status update failures without crashing', async () => {
    const ctx = createContext()
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: createMockStatusService({
        writeTick: () => {
          ctx.state.shutdownRequested = true
          throw new Error('status fail')
        },
      }),
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Account 1] Failed to update daemon status'),
    )
  })

  it("writes each account's tick to its own cache", async () => {
    const ctx = createContext()
    // Account 1 has no scheduler: its queue is counted from its own cache
    const firstDb = createAccountCacheDb()
    for (const [chatId, status] of [
      [101, 'pending'],
      [102, 'running'],
      [103, 'failed'],
      [104, 'completed'],
    ] as const) {
      firstDb.run(
        'INSERT INTO sync_jobs (chat_id, job_type, priority, status) VALUES (?, ?, ?, ?)',
        [chatId, SyncJobType.BackwardHistory, SyncPriority.Low, status],
      )
    }
    const first = addAccountRuntime(ctx, 1, firstDb, {
      messagesSynced: 40,
    })
    const second = addAccountRuntime(ctx, 2, createAccountCacheDb(), {
      messagesSynced: 2,
      scheduler: createMockScheduler({
        getStatus: () => ({
          pendingJobs: 3,
          runningJobs: 1,
          jobsByType: {},
          jobsByPriority: {},
        }),
      }),
    })
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'connected',
    })
    ctx.state.accounts.set(2, {
      accountId: 2,
      phone: '+15550000002',
      name: null,
      status: 'error',
      lastError: 'AUTH_KEY_UNREGISTERED',
    })
    const ticks: Array<[number, DaemonTick]> = []
    for (const rt of [first, second]) {
      const writeTick = rt.statusService.writeTick.bind(rt.statusService)
      rt.statusService.writeTick = (tick) => {
        ticks.push([rt.accountId, tick])
        writeTick(tick)
        ctx.state.shutdownRequested = true
      }
    }

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ticks).toHaveLength(2)
    expect(first.statusService.getDaemonInfo()).toMatchObject({
      connectionStatus: 'connected',
      lastError: null,
      messagesSynced: 40,
      pendingJobs: 1,
      runningJobs: 1,
    })
    expect(second.statusService.getDaemonInfo()).toMatchObject({
      connectionStatus: 'error',
      lastError: 'AUTH_KEY_UNREGISTERED',
      messagesSynced: 2,
      pendingJobs: 3,
      runningJobs: 1,
    })
  })

  it('runs health checks and schedules reconnects when idle', async () => {
    const ctx = createContext()
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: stopAfterTicks(ctx, 60),
    })

    const client = {
      getMe: () => {
        throw new Error('offline')
      },
    } as unknown as TelegramClient

    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client,
      lastActivity: 0,
    }

    ctx.state.accounts.set(1, accountState)

    const originalNow = Date.now
    Date.now = () => 120000

    try {
      await runWithImmediateTimeouts(() => mainLoop(ctx))
    } finally {
      Date.now = originalNow
    }

    expect(ctx.state.accounts.get(1)?.status).toBe('error')
    expect(ctx.state.accounts.get(1)?.nextReconnectAt).toBeDefined()
  })

  it("refreshes every account's queues, even when one fails", async () => {
    const ctx = createContext()
    const refreshed: number[] = []
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: stopAfterTicks(ctx, 30),
      scheduler: createMockScheduler({
        refreshQueues: () => {
          throw new Error('disk I/O error')
        },
      }),
    })
    addAccountRuntime(ctx, 2, createAccountCacheDb(), {
      scheduler: createMockScheduler({
        refreshQueues: () => {
          refreshed.push(2)
        },
      }),
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(refreshed).toEqual([2])
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Account 1] Failed to refresh sync queues: Error: disk I/O error',
      ),
    )
  })

  it('cleans up old jobs on cleanup interval', async () => {
    const ctx = createContext()
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: stopAfterTicks(ctx, 300),
      scheduler: createMockScheduler({ cleanup: () => 2 }),
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      '[Account 1] Cleaned up 2 old jobs',
    )
  })
})
