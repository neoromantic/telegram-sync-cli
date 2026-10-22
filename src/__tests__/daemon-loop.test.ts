/**
 * Tests for daemon main loop control flow (no module mocks)
 */
import { describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import type { DaemonContext } from '../daemon/daemon-context'
import { createDaemonRuntime, requestShutdown } from '../daemon/daemon-context'
import { mainLoop } from '../daemon/daemon-loop'
import { startDueJobs, waitForJobsInFlight } from '../daemon/daemon-scheduler'
import type { SyncScheduler } from '../daemon/scheduler'
import type { RealSyncWorker } from '../daemon/sync-worker'
import type { AccountConnectionState } from '../daemon/types'
import type { DaemonStatusService, DaemonTick } from '../db/daemon-status'
import { type SyncJobRow, SyncJobType, SyncPriority } from '../db/sync-schema'
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

async function runWithImmediateTimeouts(
  run: () => Promise<void>,
  onTimeout: () => void = () => {},
) {
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
    onTimeout()
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

function jobOf(id: number): SyncJobRow {
  return {
    id,
    chat_id: 55,
    job_type: SyncJobType.BackwardHistory,
    priority: SyncPriority.High,
    status: 'pending',
    cursor_start: null,
    cursor_end: null,
    messages_fetched: 0,
    error_message: null,
    created_at: 0,
    started_at: null,
    completed_at: null,
    attempts: 0,
    next_run_at: 0,
  }
}

function connectedState(accountId: number, client = {} as TelegramClient) {
  return {
    accountId,
    phone: `+1555000000${accountId}`,
    name: null,
    status: 'connected' as const,
    client,
    lastActivity: 0,
  }
}

const stoppedResult = {
  success: false,
  messagesFetched: 0,
  stopped: true,
  outcome: { state: 'stopped' as const, attempts: 0, nextRunAt: 0 },
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

  it('ends right after a job that a daemon stop cut short, even on a 60th tick', async () => {
    const ctx = createContext()
    let ticks = 0
    let timeouts = 0
    const job: SyncJobRow = {
      id: 7,
      chat_id: 55,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
      status: 'pending',
      cursor_start: null,
      cursor_end: null,
      messages_fetched: 0,
      error_message: null,
      created_at: 0,
      started_at: null,
      completed_at: null,
      attempts: 0,
      next_run_at: 0,
    }
    // A job is due on the 60th tick, when the health check is due too; the
    // stop arrives while it runs
    let picks = 0
    const worker = {
      client: {} as TelegramClient,
      canMakeApiCall: () => true,
      processJobReal: mock(async () => {
        requestShutdown(ctx)
        return {
          success: false,
          messagesFetched: 0,
          stopped: true,
          outcome: { state: 'stopped' as const, attempts: 0, nextRunAt: 0 },
        }
      }),
    } as unknown as RealSyncWorker
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: createMockStatusService({
        writeTick: () => {
          ticks += 1
        },
      }),
      scheduler: createMockScheduler({
        getNextJob: () => (++picks === 60 ? job : null),
      }),
      worker,
    })
    const getMe = mock(async () => ({}))
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'connected',
      client: { getMe } as unknown as TelegramClient,
      lastActivity: 0,
    })

    const originalNow = Date.now
    Date.now = () => 120000
    try {
      await runWithImmediateTimeouts(
        () => mainLoop(ctx),
        () => {
          timeouts += 1
        },
      )
    } finally {
      Date.now = originalNow
    }

    expect(worker.processJobReal).toHaveBeenCalledTimes(1)
    // Ticks 1 to 59 wrote their status and waited; the 60th did neither
    expect(picks).toBe(60)
    expect(ticks).toBe(59)
    expect(timeouts).toBe(59)
    expect(getMe).not.toHaveBeenCalled()
  })

  it('looks for due contacts on the first tick and then every 30th', async () => {
    const ctx = createContext()
    // Every look finds the list due, so each look is one request
    ctx.runtime.contacts.peersTtlMs = 0
    const requests: string[] = []
    const client = {
      withParams: () => ({
        call: async (request: { _: string }) => {
          requests.push(request._)
          return {
            _: 'contacts.contacts',
            contacts: [],
            savedCount: 0,
            users: [],
          }
        },
      }),
    } as unknown as TelegramClient
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: stopAfterTicks(ctx, 30),
    })
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'connected',
      client,
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))
    // Tick 1 and tick 30; the check of tick 1 ended long before tick 30
    expect(requests).toEqual(['contacts.getContacts', 'contacts.getContacts'])
  })

  it('does not hold the loop on a contacts check that never ends', async () => {
    const ctx = createContext()
    const requests: string[] = []
    const client = {
      withParams: () => ({
        call: (request: { _: string }) => {
          requests.push(request._)
          return new Promise(() => {})
        },
      }),
    } as unknown as TelegramClient
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      statusService: stopAfterTicks(ctx, 30),
    })
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'connected',
      client,
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))
    // All 30 ticks ran; the account still had its first check running
    expect(requests).toEqual(['contacts.getContacts'])
  })

  it('makes no contacts call after a stop during the first tick', async () => {
    const ctx = createContext()
    const call = mock(() => new Promise(() => {}))
    addAccountRuntime(ctx, 1, createAccountCacheDb(), {
      scheduler: createMockScheduler({
        getNextJob: () => {
          requestShutdown(ctx)
          return null
        },
      }),
      worker: { canMakeApiCall: () => true } as unknown as RealSyncWorker,
    })
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'connected',
      client: { withParams: () => ({ call }) } as unknown as TelegramClient,
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))
    expect(call).not.toHaveBeenCalled()
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

  it("finishes account 2's jobs while account 1's job waits, and stops both", async () => {
    const ctx = createContext()
    const events: string[] = []
    let now = 1_760_000_000_000
    const ticks: number[] = []
    let tick = 1
    const signal = ctx.runtime.shutdown.signal
    // Account 1's job waits until the stop ends it, like a FLOOD_WAIT
    const firstWorker = {
      client: {} as TelegramClient,
      canMakeApiCall: () => true,
      processJobReal: mock(
        () =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                events.push('1 stopped')
                resolve(stoppedResult)
              },
              { once: true },
            )
          }),
      ),
    } as unknown as RealSyncWorker
    let secondRuns = 0
    const secondWorker = {
      client: {} as TelegramClient,
      canMakeApiCall: () => true,
      processJobReal: mock(async () => {
        secondRuns += 1
        ticks.push(tick)
        events.push(`2 done ${secondRuns}`)
        if (secondRuns === 3) requestShutdown(ctx)
        return { success: true, messagesFetched: 1 }
      }),
    } as unknown as RealSyncWorker
    for (const [accountId, worker] of [
      [1, firstWorker],
      [2, secondWorker],
    ] as const) {
      addAccountRuntime(ctx, accountId, createAccountCacheDb(), {
        scheduler: createMockScheduler({ getNextJob: () => jobOf(accountId) }),
        worker,
      })
      ctx.state.accounts.set(accountId, connectedState(accountId))
    }

    const originalNow = Date.now
    Date.now = () => now
    try {
      await runWithImmediateTimeouts(
        () => mainLoop(ctx),
        () => {
          now += 1000
          tick += 1
        },
      )
      await waitForJobsInFlight(ctx)
    } finally {
      Date.now = originalNow
    }

    expect(firstWorker.processJobReal).toHaveBeenCalledTimes(1)
    expect(secondWorker.processJobReal).toHaveBeenCalledTimes(3)
    // 3 s from the end of each job
    expect(ticks).toEqual([1, 4, 7])
    expect(events).toEqual(['2 done 1', '2 done 2', '2 done 3', '1 stopped'])
    expect(ctx.runtime.jobsInFlight.size).toBe(0)
  })

  it('a stop ends the tick wait at once', async () => {
    const ctx = createContext()
    addAccountRuntime(ctx, 1, createAccountCacheDb())
    setTimeout(() => requestShutdown(ctx), 20)

    const started = performance.now()
    await mainLoop(ctx)

    expect(performance.now() - started).toBeLessThan(500)
  })

  it('checks a busy account but waits to reconnect one until its job ends', async () => {
    const ctx = createContext()
    const finishes: Array<(result: unknown) => void> = []
    const workerWithBlockedJob = () =>
      ({
        client: {} as TelegramClient,
        canMakeApiCall: () => true,
        processJobReal: mock(
          () =>
            new Promise((resolve) => {
              finishes.push(resolve)
            }),
        ),
      }) as unknown as RealSyncWorker
    const getMe = mock(async () => ({}))
    // Account 1 is connected; account 2 is due to reconnect. Both start a
    // job on the first tick, still running at the 60th.
    for (const accountId of [1, 2]) {
      addAccountRuntime(ctx, accountId, createAccountCacheDb(), {
        statusService:
          accountId === 1 ? stopAfterTicks(ctx, 61) : createMockStatusService(),
        scheduler: createMockScheduler({ getNextJob: () => jobOf(accountId) }),
        worker: workerWithBlockedJob(),
      })
      ctx.state.accounts.set(
        accountId,
        connectedState(accountId, { getMe } as unknown as TelegramClient),
      )
    }
    const second = ctx.state.accounts.get(2) as AccountConnectionState

    const originalNow = Date.now
    Date.now = () => 120000
    try {
      await runWithImmediateTimeouts(async () => {
        // The job starts while account 2 is connected, then its connection
        // fails
        startDueJobs(ctx)
        second.status = 'error'
        second.nextReconnectAt = 1
        await mainLoop(ctx)
      })
    } finally {
      Date.now = originalNow
    }

    // Account 1's health check ran beside its job
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(ctx.state.accounts.get(1)?.status).toBe('connected')
    // Account 2's reconnect didn't close the client under its job
    expect(second.status).toBe('error')
    expect(second.nextReconnectAt).toBe(1)

    for (const finish of finishes) finish({ success: true, messagesFetched: 0 })
    await waitForJobsInFlight(ctx)
    expect(finishes).toHaveLength(2)
    expect(ctx.runtime.jobsInFlight.size).toBe(0)
  })
})
