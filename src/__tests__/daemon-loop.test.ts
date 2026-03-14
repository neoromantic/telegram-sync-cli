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
import { getCacheDb } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import type { DaemonStatusService } from '../db/daemon-status'
import { createMessagesCache } from '../db/messages-cache'

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
    setConnectedAccounts: () => {},
    updateLastUpdate: () => {},
    setMessagesSynced: () => {},
    getDaemonInfo: () => ({
      status: 'running',
      pid: null,
      startedAt: null,
      lastUpdate: null,
      connectedAccounts: 0,
      totalAccounts: 0,
      messagesSynced: 0,
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

describe('mainLoop', () => {
  it('logs status update failures without crashing', async () => {
    const ctx = createContext()

    ctx.runtime.statusService = createMockStatusService({
      setMessagesSynced: () => {
        ctx.state.shutdownRequested = true
      },
      updateLastUpdate: () => {
        throw new Error('status fail')
      },
    })

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('runs health checks and schedules reconnects when idle', async () => {
    const ctx = createContext()

    let loopCount = 0
    ctx.runtime.statusService = createMockStatusService({
      updateLastUpdate: () => {
        loopCount += 1
        if (loopCount >= 60) {
          ctx.state.shutdownRequested = true
        }
      },
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

  it('cleans up old jobs on cleanup interval', async () => {
    const ctx = createContext()
    const cacheDb = getCacheDb()

    ctx.runtime.scheduler = createMockScheduler({
      cleanup: () => 2,
      getStatus: () => ({
        pendingJobs: 0,
        runningJobs: 0,
        jobsByType: {},
        jobsByPriority: {},
      }),
      getNextJob: () => null,
    })

    ctx.runtime.statusService = createMockStatusService()

    const statusService = ctx.runtime.statusService!
    let loopCount = 0
    statusService.updateLastUpdate = () => {
      loopCount += 1
      if (loopCount >= 300) {
        ctx.state.shutdownRequested = true
      }
    }

    const messagesCache = createMessagesCache(cacheDb)
    const chatSyncState = createChatSyncStateService(cacheDb)
    messagesCache.countByChatId(0)
    chatSyncState.get(0)

    await runWithImmediateTimeouts(() => mainLoop(ctx))

    expect(ctx.logger.debug).toHaveBeenCalled()
  })
})
