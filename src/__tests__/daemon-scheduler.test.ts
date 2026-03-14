/**
 * Tests for daemon scheduler logic (no module mocks)
 */
import { describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import type { DaemonContext } from '../daemon/daemon-context'
import { createDaemonRuntime } from '../daemon/daemon-context'
import {
  cleanupScheduler,
  initializeScheduler,
  processJobs,
} from '../daemon/daemon-scheduler'
import type { SyncScheduler } from '../daemon/scheduler'
import type { RealSyncWorker } from '../daemon/sync-worker'
import { getCacheDb } from '../db'
import { createTestDatabase } from '../db/index.ts'
import { initCacheSchema } from '../db/schema'
import {
  initSyncSchema,
  type SyncJobRow,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'

function createLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

const asTelegramClient = (client: Partial<TelegramClient>): TelegramClient =>
  client as TelegramClient

const createSchedulerStub = (
  overrides: Partial<SyncScheduler> = {},
): SyncScheduler => {
  const scheduler = {
    queueForwardCatchup: mock(() => {}),
    queueBackwardHistory: mock(() => {}),
    queueInitialLoad: mock(() => {}),
    initializeForStartup: mock(async () => {}),
    refreshQueues: mock(() => {}),
    getNextJob: () => null,
    claimNextJob: () => null,
    startJob: () => true,
    completeJob: () => true,
    failJob: () => true,
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
    ...overrides,
  } satisfies SyncScheduler

  return scheduler
}

const createWorkerStub = (
  overrides: Partial<RealSyncWorker> = {},
): RealSyncWorker => {
  const worker = {
    processJobReal: mock(async () => ({
      success: true,
      messagesFetched: 0,
    })),
    processForwardCatchupReal: mock(async () => ({
      success: true,
      messagesFetched: 0,
    })),
    processBackwardHistoryReal: mock(async () => ({
      success: true,
      messagesFetched: 0,
    })),
    processInitialLoadReal: mock(async () => ({
      success: true,
      messagesFetched: 0,
    })),
    runOnceReal: mock(async () => null),
    canMakeApiCall: () => true,
    getWaitTime: () => 0,
    buildInputPeer: mock((_chatId: number) => null),
    parseRawMessage: mock((_msg: unknown, _chatId: number) => null),
    ...overrides,
  } satisfies RealSyncWorker

  return worker
}

function createContext(): DaemonContext {
  const { accountsDb } = createTestDatabase()
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli/daemon.pid',
    verbosity: 'normal',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 3,
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
      running: true,
      accounts: new Map(),
      shutdownRequested: false,
    },
    accountsDb,
    runtime: createDaemonRuntime(),
  }
}

describe('initializeScheduler', () => {
  it('creates scheduler and workers for connected accounts', async () => {
    const ctx = createContext()
    const cacheDb = getCacheDb()
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)

    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: asTelegramClient({ call: async () => ({}) }),
    })

    await initializeScheduler(ctx)

    expect(ctx.runtime.scheduler).not.toBeNull()
    expect(ctx.runtime.syncWorkers.size).toBe(1)
  })
})

describe('processJobs', () => {
  it('queues follow-up jobs on success with hasMore', async () => {
    const ctx = createContext()

    const job: SyncJobRow = {
      id: 1,
      chat_id: 10,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
      status: 'pending',
      cursor_start: null,
      cursor_end: null,
      messages_fetched: 0,
      error_message: null,
      created_at: Date.now(),
      started_at: null,
      completed_at: null,
    }

    const scheduler = createSchedulerStub({
      getNextJob: () => job,
      queueBackwardHistory: mock(() => {}),
      queueForwardCatchup: mock(() => {}),
    })

    const worker = createWorkerStub({
      processJobReal: mock(async () => ({
        success: true,
        messagesFetched: 4,
        hasMore: true,
      })),
    })

    ctx.runtime.scheduler = scheduler
    ctx.runtime.syncWorkers.set(1, worker)
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: asTelegramClient({}),
    })

    await processJobs(ctx)

    expect(worker.processJobReal).toHaveBeenCalledWith(job)
    expect(scheduler.queueBackwardHistory).toHaveBeenCalledWith(10)
    expect(ctx.runtime.totalMessagesSynced).toBe(4)
  })

  it('records last job time when rate limited', async () => {
    const ctx = createContext()

    const job: SyncJobRow = {
      id: 2,
      chat_id: 44,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
      status: 'pending',
      cursor_start: null,
      cursor_end: null,
      messages_fetched: 0,
      error_message: null,
      created_at: Date.now(),
      started_at: null,
      completed_at: null,
    }

    const scheduler = createSchedulerStub({
      getNextJob: () => job,
      queueBackwardHistory: mock(() => {}),
      queueForwardCatchup: mock(() => {}),
    })

    const worker = createWorkerStub({
      processJobReal: mock(async () => ({
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: 3,
      })),
    })

    ctx.runtime.scheduler = scheduler
    ctx.runtime.syncWorkers.set(1, worker)
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: asTelegramClient({}),
    })

    await processJobs(ctx)

    expect(ctx.runtime.lastJobProcessTime).toBeGreaterThan(0)
    expect(scheduler.queueForwardCatchup).not.toHaveBeenCalled()
  })

  it('skips processing when inter-job delay not elapsed', async () => {
    const ctx = createContext()
    const now = Date.now()
    const originalNow = Date.now

    Date.now = () => now
    ctx.runtime.lastJobProcessTime = now
    ctx.runtime.scheduler = createSchedulerStub({
      getNextJob: mock(() => null),
    })

    const scheduler = ctx.runtime.scheduler!
    try {
      await processJobs(ctx)
    } finally {
      Date.now = originalNow
    }

    expect(scheduler.getNextJob).not.toHaveBeenCalled()
  })
})

describe('cleanupScheduler', () => {
  it('clears scheduler and workers after cleanup', () => {
    const ctx = createContext()

    const scheduler = createSchedulerStub({
      cleanup: mock(() => 2),
    })

    ctx.runtime.scheduler = scheduler
    ctx.runtime.syncWorkers.set(1, createWorkerStub())

    cleanupScheduler(ctx)

    expect(scheduler.cleanup).toHaveBeenCalled()
    expect(ctx.runtime.syncWorkers.size).toBe(0)
    expect(ctx.runtime.scheduler).toBeNull()
  })
})
