/**
 * Tests for daemon scheduler logic (no module mocks)
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { sep } from 'node:path'
import type { TelegramClient } from '@mtcute/bun'
import type { DaemonContext } from '../daemon/daemon-context'
import { createDaemonRuntime } from '../daemon/daemon-context'
import {
  cleanupScheduler,
  initializeScheduler,
  processJobs,
  rebuildSyncWorker,
} from '../daemon/daemon-scheduler'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
import type { RealSyncWorker } from '../daemon/sync-worker'
import { getCacheDb, getDataDir } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createTestDatabase } from '../db/index.ts'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  type SyncJobRow,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'
import { fakeDialogClient } from './helpers/fake-dialogs'

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
    recordJobRun: mock(() => {}),
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
    client: asTelegramClient({}),
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

describe('rebuildSyncWorker', () => {
  it('replaces the account worker while the scheduler runs', () => {
    const ctx = createContext()
    const cacheDb = getCacheDb()
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)
    const oldWorker = createWorkerStub()
    ctx.runtime.scheduler = createSchedulerStub()
    ctx.runtime.syncWorkers.set(1, oldWorker)

    const newClient = asTelegramClient({})
    rebuildSyncWorker(ctx, 1, newClient)

    const worker = ctx.runtime.syncWorkers.get(1)
    expect(worker).not.toBe(oldWorker)
    expect(worker?.client).toBe(newClient)
  })

  it('does nothing without a scheduler', () => {
    const ctx = createContext()
    const fake = fakeDialogClient([])

    expect(rebuildSyncWorker(ctx, 1, fake.client)).toBeUndefined()

    expect(ctx.runtime.syncWorkers.size).toBe(0)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('rebuildSyncWorker dialog pass', () => {
  const cacheDb = getCacheDb()
  const chatSyncState = createChatSyncStateService(cacheDb)
  const jobsService = createSyncJobsService(cacheDb)

  beforeEach(() => {
    // The deletes below clear the file-backed cache database
    if (!getDataDir().includes(`${sep}.tmp${sep}test-data-`)) {
      throw new Error(`Refusing to clear a non-test data dir: ${getDataDir()}`)
    }
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)
    // The cache database file is shared by the tests in this process
    cacheDb.run('DELETE FROM chat_sync_state')
    cacheDb.run('DELETE FROM sync_jobs')
    cacheDb.run('DELETE FROM chats_cache')

    for (const userId of [1001, 1002, 1003]) {
      chatSyncState.upsert({
        chat_id: userId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 1,
      })
      chatSyncState.markHistoryComplete(userId)
      chatSyncState.raiseTopMessageId(userId, 1000)
    }
  })

  function createRunningContext() {
    const ctx = createContext()
    ctx.runtime.scheduler = createSyncScheduler({
      db: cacheDb,
      jobsService,
      chatSyncState,
      messagesCache: createMessagesCache(cacheDb),
    })
    return ctx
  }

  const pendingCatchups = () =>
    jobsService
      .getPendingJobs()
      .filter((job) => job.job_type === SyncJobType.ForwardCatchup)
      .map((job) => job.chat_id)
      .sort()

  it('catches up the chats that got messages while the connection was down', async () => {
    const ctx = createRunningContext()
    const fake = fakeDialogClient([
      { kind: 'user', id: 1001, topMessage: 1000 },
      { kind: 'user', id: 1002, topMessage: 1007 },
    ])

    await rebuildSyncWorker(ctx, 1, fake.client)

    expect(fake.calls).toEqual([{ archived: 'keep' }])
    expect(ctx.runtime.syncWorkers.get(1)?.client).toBe(fake.client)
    expect(chatSyncState.get(1002)?.top_message_id).toBe(1007)
    // A complete pass of one account says nothing about chats it didn't list
    expect(chatSyncState.get(1003)?.top_message_id).toBe(1000)
    expect(pendingCatchups()).toEqual([1002])
    expect(ctx.runtime.dialogPassesInFlight.size).toBe(0)
  })

  it('checks an opted-in chat that the pass did not list', async () => {
    const channelId = -1_000_000_003_003
    chatSyncState.upsert({
      chat_id: channelId,
      chat_type: 'channel',
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
      forward_cursor: 900,
      backward_cursor: 1,
    })
    chatSyncState.setSyncMode(channelId, 'on')
    chatSyncState.markHistoryComplete(channelId)
    chatSyncState.raiseTopMessageId(channelId, 900)
    const ctx = createRunningContext()
    const fake = fakeDialogClient([
      { kind: 'user', id: 1001, topMessage: 1000 },
      { kind: 'user', id: 1002, topMessage: 1000 },
    ])

    await rebuildSyncWorker(ctx, 1, fake.client)

    expect(chatSyncState.get(channelId)?.top_message_id).toBeNull()
    expect(chatSyncState.get(1003)?.top_message_id).toBe(1000)
    expect(pendingCatchups()).toEqual([channelId])
  })

  it('checks every unlisted chat after a pass that failed', async () => {
    const ctx = createRunningContext()
    const fake = fakeDialogClient(
      [
        { kind: 'user', id: 1001, topMessage: 1000 },
        { kind: 'user', id: 1002, topMessage: 1000 },
      ],
      { failAfter: 1 },
    )

    await rebuildSyncWorker(ctx, 1, fake.client)

    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    expect(chatSyncState.get(1002)?.top_message_id).toBeNull()
    expect(chatSyncState.get(1003)?.top_message_id).toBeNull()
    expect(pendingCatchups()).toEqual([1002, 1003])
  })

  it('logs a pass that throws and lets the next reconnect run one', async () => {
    // Nothing awaits the pass in the daemon, so a throw must not escape
    const ctx = createContext()
    ctx.runtime.scheduler = createSchedulerStub({
      refreshQueues: mock(() => {
        throw new Error('disk I/O error')
      }),
    })
    const fake = fakeDialogClient([
      { kind: 'user', id: 1002, topMessage: 1007 },
    ])

    await expect(
      rebuildSyncWorker(ctx, 1, fake.client),
    ).resolves.toBeUndefined()

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Dialog pass after reconnect failed'),
    )
    expect(ctx.runtime.dialogPassesInFlight.size).toBe(0)
  })

  it('runs one pass for two quick reconnects of an account', async () => {
    const ctx = createRunningContext()
    const first = fakeDialogClient([
      { kind: 'user', id: 1002, topMessage: 1007 },
    ])
    const second = fakeDialogClient([
      { kind: 'user', id: 1002, topMessage: 1007 },
    ])

    const firstPass = rebuildSyncWorker(ctx, 1, first.client)
    const secondPass = rebuildSyncWorker(ctx, 1, second.client)
    await Promise.all([firstPass, secondPass])

    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(0)
    // The worker still moves to the newest client
    expect(ctx.runtime.syncWorkers.get(1)?.client).toBe(second.client)
    expect(pendingCatchups()).toEqual([1002])
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
      attempts: 0,
      next_run_at: 0,
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
      attempts: 0,
      next_run_at: 0,
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

  function jobOf(jobType: SyncJobType): SyncJobRow {
    return {
      id: 3,
      chat_id: 55,
      job_type: jobType,
      priority: SyncPriority.High,
      status: 'pending',
      cursor_start: null,
      cursor_end: null,
      messages_fetched: 0,
      error_message: null,
      created_at: Date.now(),
      started_at: null,
      completed_at: null,
      attempts: 0,
      next_run_at: 0,
    }
  }

  function connectWorker(ctx: DaemonContext, worker: RealSyncWorker) {
    ctx.runtime.syncWorkers.set(1, worker)
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+10000000001',
      name: null,
      status: 'connected',
      client: asTelegramClient({}),
    })
  }

  it('moves to the next lane slot only after a job ran', async () => {
    const job = jobOf(SyncJobType.ForwardCatchup)

    // No worker: the job doesn't run and keeps its slot
    const idle = createContext()
    const idleScheduler = createSchedulerStub({ getNextJob: () => job })
    idle.runtime.scheduler = idleScheduler
    await processJobs(idle)
    expect(idleScheduler.recordJobRun).not.toHaveBeenCalled()

    // A worker that is rate limited doesn't run it either
    const blocked = createContext()
    const blockedScheduler = createSchedulerStub({ getNextJob: () => job })
    blocked.runtime.scheduler = blockedScheduler
    connectWorker(blocked, createWorkerStub({ canMakeApiCall: () => false }))
    await processJobs(blocked)
    expect(blockedScheduler.recordJobRun).not.toHaveBeenCalled()

    // A job that ran uses the slot, even if it threw
    const ctx = createContext()
    const scheduler = createSchedulerStub({ getNextJob: () => job })
    ctx.runtime.scheduler = scheduler
    connectWorker(
      ctx,
      createWorkerStub({
        processJobReal: mock(async () => {
          throw new Error('boom')
        }),
      }),
    )
    await processJobs(ctx)
    expect(scheduler.recordJobRun).toHaveBeenCalledTimes(1)
    expect(scheduler.recordJobRun).toHaveBeenCalledWith(job)
  })

  it('queues history right after a first page with history left', async () => {
    const job = jobOf(SyncJobType.InitialLoad)
    const ctx = createContext()
    const scheduler = createSchedulerStub({ getNextJob: () => job })
    ctx.runtime.scheduler = scheduler
    connectWorker(
      ctx,
      createWorkerStub({
        processJobReal: mock(async () => ({
          success: true,
          messagesFetched: 100,
          newCursor: 300,
          historyComplete: false,
        })),
      }),
    )

    await processJobs(ctx)

    expect(scheduler.queueBackwardHistory).toHaveBeenCalledWith(55)
  })

  it('queues no history after a first page that reached the start', async () => {
    const job = jobOf(SyncJobType.InitialLoad)
    const ctx = createContext()
    const scheduler = createSchedulerStub({ getNextJob: () => job })
    ctx.runtime.scheduler = scheduler
    connectWorker(
      ctx,
      createWorkerStub({
        processJobReal: mock(async () => ({
          success: true,
          messagesFetched: 12,
          newCursor: 12,
          historyComplete: true,
        })),
      }),
    )

    await processJobs(ctx)

    expect(scheduler.queueBackwardHistory).not.toHaveBeenCalled()
  })

  describe('logs a job that did not succeed by its outcome', () => {
    async function run(
      result: Awaited<ReturnType<RealSyncWorker['processJobReal']>>,
    ) {
      const ctx = createContext()
      ctx.runtime.scheduler = createSchedulerStub({
        getNextJob: () => jobOf(SyncJobType.BackwardHistory),
      })
      connectWorker(
        ctx,
        createWorkerStub({ processJobReal: mock(async () => result) }),
      )
      await processJobs(ctx)
      const lines = (level: 'warn' | 'debug') =>
        (ctx.logger[level] as ReturnType<typeof mock>).mock.calls.map((call) =>
          String(call[0]),
        )
      return { warn: lines('warn'), debug: lines('debug') }
    }

    it('warns with the attempt and the error when the job will retry', async () => {
      const { warn } = await run({
        success: false,
        messagesFetched: 0,
        error: 'connection reset',
        permanent: false,
        outcome: { state: 'retrying', attempts: 1, nextRunAt: Date.now() },
      })

      expect(warn).toEqual([
        'Job 3 (backward_history, chat 55) failed, attempt 1 of 5, retry in 1m: connection reset',
      ])
    })

    it('warns with the error when the job failed for good', async () => {
      const permanent = await run({
        success: false,
        messagesFetched: 0,
        error: 'Telegram API error 400: CHANNEL_PRIVATE',
        permanent: true,
        outcome: { state: 'failed', attempts: 1, nextRunAt: null },
      })
      const exhausted = await run({
        success: false,
        messagesFetched: 0,
        error: 'connection reset',
        permanent: false,
        outcome: { state: 'failed', attempts: 5, nextRunAt: null },
      })

      expect(permanent.warn).toHaveLength(1)
      expect(permanent.warn[0]).toContain('failed for good (permanent error)')
      expect(permanent.warn[0]).toContain('CHANNEL_PRIVATE')
      expect(exhausted.warn).toHaveLength(1)
      expect(exhausted.warn[0]).toContain(
        '(after 5 attempts): connection reset',
      )
    })

    it('only debug-logs a job that waits out a FLOOD_WAIT', async () => {
      const { warn, debug } = await run({
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: 600,
        outcome: { state: 'deferred', attempts: 0, nextRunAt: Date.now() },
      })

      expect(warn).toEqual([])
      expect(debug).toContain('Job 3 waits out a FLOOD_WAIT of 600s')
    })
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
    expect(ctx.logger.debug).toHaveBeenCalledWith('Cleaned up 2 old jobs')
    expect(ctx.runtime.syncWorkers.size).toBe(0)
    expect(ctx.runtime.scheduler).toBeNull()
  })
})
