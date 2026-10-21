/**
 * Tests for daemon scheduler logic (no module mocks). Each account has its
 * own runtime: its cache, scheduler and sync worker.
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient, tl } from '@mtcute/bun'
import type { AccountRuntime, DaemonContext } from '../daemon/daemon-context'
import {
  createDaemonRuntime,
  totalMessagesSynced,
} from '../daemon/daemon-context'
import {
  cleanupScheduler,
  initializeScheduler,
  processJobs,
  rebuildSyncWorker,
} from '../daemon/daemon-scheduler'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
import type { RealSyncWorker } from '../daemon/sync-worker'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createTestDatabase } from '../db/index.ts'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType, SyncPriority } from '../db/sync-schema'
import {
  addAccountRuntime,
  createAccountCacheDb,
} from './helpers/daemon-runtime'
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

/** Mark the account connected with a client */
function connect(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient = asTelegramClient({}),
) {
  ctx.state.accounts.set(accountId, {
    accountId,
    phone: `+1555000000${accountId}`,
    name: null,
    status: 'connected',
    client,
  })
}

/** A connected account with a scheduler and a worker (stubs by default) */
function runAccount(
  ctx: DaemonContext,
  accountId: number,
  parts: { scheduler?: SyncScheduler; worker?: RealSyncWorker } = {},
): AccountRuntime {
  connect(ctx, accountId)
  return addAccountRuntime(ctx, accountId, createAccountCacheDb(), {
    scheduler: parts.scheduler ?? createSchedulerStub(),
    worker: parts.worker ?? createWorkerStub(),
  })
}

function jobOf(jobType: SyncJobType, overrides: Partial<SyncJobRow> = {}) {
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
    ...overrides,
  } satisfies SyncJobRow
}

/** Replace Date.now with a clock the test moves */
function useClock(start = 1_760_000_000_000) {
  const originalNow = Date.now
  let now = start
  Date.now = () => now
  return {
    advance(ms: number) {
      now += ms
    },
    restore() {
      Date.now = originalNow
    },
  }
}

describe('initializeScheduler', () => {
  it('creates a scheduler and a worker for each connected account', async () => {
    const ctx = createContext()
    connect(ctx, 1, asTelegramClient({ call: async () => ({}) }))
    const first = addAccountRuntime(ctx, 1)
    ctx.state.accounts.set(2, {
      accountId: 2,
      phone: '+15550000002',
      name: null,
      status: 'error',
    })
    const second = addAccountRuntime(ctx, 2)

    await initializeScheduler(ctx)

    expect(first.scheduler).not.toBeNull()
    expect(first.worker).not.toBeNull()
    expect(second.scheduler).toBeNull()
    expect(second.worker).toBeNull()
  })
})

describe('rebuildSyncWorker', () => {
  it('replaces the account worker while the scheduler runs', () => {
    const ctx = createContext()
    const oldWorker = createWorkerStub()
    const rt = runAccount(ctx, 1, { worker: oldWorker })

    const newClient = asTelegramClient({})
    rebuildSyncWorker(ctx, 1, newClient)

    expect(rt.worker).not.toBe(oldWorker)
    expect(rt.worker?.client).toBe(newClient)
  })

  it("leaves the other accounts' workers alone", () => {
    const ctx = createContext()
    runAccount(ctx, 1)
    const otherWorker = createWorkerStub()
    const other = runAccount(ctx, 2, { worker: otherWorker })

    rebuildSyncWorker(ctx, 1, asTelegramClient({}))

    expect(other.worker).toBe(otherWorker)
  })

  it('does nothing without a scheduler', () => {
    const ctx = createContext()
    const rt = addAccountRuntime(ctx, 1)
    const fake = fakeDialogClient([])

    expect(rebuildSyncWorker(ctx, 1, fake.client)).toBeUndefined()

    expect(rt.worker).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })
})

describe('rebuildSyncWorker dialog pass', () => {
  let cacheDb: Database
  let otherDb: Database
  let chatSyncState: ReturnType<typeof createChatSyncStateService>
  let jobsService: ReturnType<typeof createSyncJobsService>

  function seedChats(db: Database) {
    const state = createChatSyncStateService(db)
    for (const userId of [1001, 1002, 1003]) {
      state.upsert({
        chat_id: userId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 1,
      })
      state.markHistoryComplete(userId)
      state.raiseTopMessageId(userId, 1000)
    }
  }

  beforeEach(() => {
    cacheDb = createAccountCacheDb()
    otherDb = createAccountCacheDb()
    chatSyncState = createChatSyncStateService(cacheDb)
    jobsService = createSyncJobsService(cacheDb)
    seedChats(cacheDb)
    seedChats(otherDb)
  })

  afterEach(() => {
    cacheDb.close()
    otherDb.close()
  })

  function createRunningContext() {
    const ctx = createContext()
    addAccountRuntime(ctx, 1, cacheDb, {
      scheduler: createSyncScheduler({
        db: cacheDb,
        jobsService,
        chatSyncState,
        messagesCache: createMessagesCache(cacheDb),
      }),
    })
    return ctx
  }

  const pendingCatchups = (service = jobsService) =>
    service
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
    expect(ctx.runtime.accounts.get(1)?.worker?.client).toBe(fake.client)
    expect(chatSyncState.get(1002)?.top_message_id).toBe(1007)
    expect(chatSyncState.get(1003)?.top_message_id).toBe(1000)
    expect(pendingCatchups()).toEqual([1002])
    expect(ctx.runtime.dialogPassesInFlight.size).toBe(0)
  })

  it("changes only the reconnected account's cache", async () => {
    const ctx = createRunningContext()
    const otherState = createChatSyncStateService(otherDb)
    addAccountRuntime(ctx, 2, otherDb, {
      scheduler: createSyncScheduler({
        db: otherDb,
        jobsService: createSyncJobsService(otherDb),
        chatSyncState: otherState,
        messagesCache: createMessagesCache(otherDb),
      }),
    })
    const fake = fakeDialogClient(
      [
        { kind: 'user', id: 1001, topMessage: 1000 },
        { kind: 'user', id: 1002, topMessage: 1007 },
      ],
      { failAfter: 1 },
    )

    await rebuildSyncWorker(ctx, 1, fake.client)

    expect(chatSyncState.get(1003)?.top_message_id).toBeNull()
    for (const userId of [1001, 1002, 1003]) {
      expect(otherState.get(userId)?.top_message_id).toBe(1000)
    }
    expect(pendingCatchups(createSyncJobsService(otherDb))).toEqual([])
    expect(createChatsCache(otherDb).getById('1001')).toBeNull()
  })

  it("marks the account's unlisted chats caught up after a complete pass", async () => {
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
    // An earlier pass that failed left 1003's newest message unknown, in
    // both accounts' caches
    const otherState = createChatSyncStateService(otherDb)
    chatSyncState.markTopUnknown([1003])
    otherState.markTopUnknown([1003])
    const ctx = createRunningContext()
    addAccountRuntime(ctx, 2, otherDb)
    const fake = fakeDialogClient([
      { kind: 'user', id: 1001, topMessage: 1000 },
      { kind: 'user', id: 1002, topMessage: 1007 },
    ])

    await rebuildSyncWorker(ctx, 1, fake.client)

    // Left, deleted or migrated: caught up at its cursor, no checking page
    expect(chatSyncState.get(1003)).toMatchObject({
      top_message_id: 1000,
      forward_cursor: 1000,
    })
    // Turned on with tg chats sync: maybe a channel no dialog list shows
    expect(chatSyncState.get(channelId)?.top_message_id).toBeNull()
    expect(pendingCatchups()).toEqual([channelId, 1002])
    // The other account's pass is its own
    expect(otherState.get(1003)?.top_message_id).toBeNull()
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
    addAccountRuntime(ctx, 1, cacheDb, {
      scheduler: createSchedulerStub({
        refreshQueues: mock(() => {
          throw new Error('disk I/O error')
        }),
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
    expect(ctx.runtime.accounts.get(1)?.worker?.client).toBe(second.client)
    expect(pendingCatchups()).toEqual([1002])
  })
})

describe('processJobs', () => {
  it('queues follow-up jobs on success with hasMore', async () => {
    const ctx = createContext()
    const job = jobOf(SyncJobType.BackwardHistory, { id: 1, chat_id: 10 })
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
    const rt = runAccount(ctx, 1, { scheduler, worker })

    await processJobs(ctx)

    expect(worker.processJobReal).toHaveBeenCalledWith(job)
    expect(scheduler.queueBackwardHistory).toHaveBeenCalledWith(10)
    expect(rt.messagesSynced).toBe(4)
    expect(totalMessagesSynced(ctx.runtime)).toBe(4)
  })

  it('records last job time when rate limited', async () => {
    const ctx = createContext()
    const job = jobOf(SyncJobType.ForwardCatchup, { id: 2, chat_id: 44 })
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
    const rt = runAccount(ctx, 1, { scheduler, worker })

    await processJobs(ctx)

    expect(rt.lastJobProcessTime).toBeGreaterThan(0)
    expect(ctx.runtime.lastJobAccountId).toBe(1)
    expect(scheduler.queueForwardCatchup).not.toHaveBeenCalled()
  })

  it('moves to the next lane slot only after a job ran', async () => {
    const job = jobOf(SyncJobType.ForwardCatchup)

    // No worker: the job doesn't run and keeps its slot
    const idle = createContext()
    const idleScheduler = createSchedulerStub({ getNextJob: () => job })
    connect(idle, 1)
    addAccountRuntime(idle, 1, createAccountCacheDb(), {
      scheduler: idleScheduler,
    })
    await processJobs(idle)
    expect(idleScheduler.recordJobRun).not.toHaveBeenCalled()

    // A worker that is rate limited doesn't run it either
    const blocked = createContext()
    const blockedScheduler = createSchedulerStub({ getNextJob: () => job })
    runAccount(blocked, 1, {
      scheduler: blockedScheduler,
      worker: createWorkerStub({ canMakeApiCall: () => false }),
    })
    await processJobs(blocked)
    expect(blockedScheduler.recordJobRun).not.toHaveBeenCalled()

    // A job that ran uses the slot, even if it threw
    const ctx = createContext()
    const scheduler = createSchedulerStub({ getNextJob: () => job })
    runAccount(ctx, 1, {
      scheduler,
      worker: createWorkerStub({
        processJobReal: mock(async () => {
          throw new Error('boom')
        }),
      }),
    })
    await processJobs(ctx)
    expect(scheduler.recordJobRun).toHaveBeenCalledTimes(1)
    expect(scheduler.recordJobRun).toHaveBeenCalledWith(job)
  })

  it('queues history right after a first page with history left', async () => {
    const ctx = createContext()
    const scheduler = createSchedulerStub({
      getNextJob: () => jobOf(SyncJobType.InitialLoad),
    })
    runAccount(ctx, 1, {
      scheduler,
      worker: createWorkerStub({
        processJobReal: mock(async () => ({
          success: true,
          messagesFetched: 100,
          newCursor: 300,
          historyComplete: false,
        })),
      }),
    })

    await processJobs(ctx)

    expect(scheduler.queueBackwardHistory).toHaveBeenCalledWith(55)
  })

  it('queues no history after a first page that reached the start', async () => {
    const ctx = createContext()
    const scheduler = createSchedulerStub({
      getNextJob: () => jobOf(SyncJobType.InitialLoad),
    })
    runAccount(ctx, 1, {
      scheduler,
      worker: createWorkerStub({
        processJobReal: mock(async () => ({
          success: true,
          messagesFetched: 12,
          newCursor: 12,
          historyComplete: true,
        })),
      }),
    })

    await processJobs(ctx)

    expect(scheduler.queueBackwardHistory).not.toHaveBeenCalled()
  })

  describe('logs a job that did not succeed by its outcome', () => {
    async function run(
      result: Awaited<ReturnType<RealSyncWorker['processJobReal']>>,
    ) {
      const ctx = createContext()
      runAccount(ctx, 1, {
        scheduler: createSchedulerStub({
          getNextJob: () => jobOf(SyncJobType.BackwardHistory),
        }),
        worker: createWorkerStub({ processJobReal: mock(async () => result) }),
      })
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
        '[Account 1] Job 3 (backward_history, chat 55) failed, attempt 1 of 5, retry in 1m: connection reset',
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
      // Bare tg chats sync would turn an auto chat on; tg status prints the
      // command with the chat's mode
      expect(permanent.warn[0]).toContain(
        'tg status shows the tg chats sync command',
      )
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
      expect(debug).toContain(
        '[Account 1] Job 3 waits out a FLOOD_WAIT of 600s',
      )
    })
  })

  it("skips an account whose inter-job delay hasn't elapsed", async () => {
    const ctx = createContext()
    const clock = useClock()
    const getNextJob = mock(() => null)
    const rt = runAccount(ctx, 1, {
      scheduler: createSchedulerStub({ getNextJob }),
    })
    rt.lastJobProcessTime = Date.now()

    try {
      await processJobs(ctx)
    } finally {
      clock.restore()
    }

    expect(getNextJob).not.toHaveBeenCalled()
  })

  it('takes turns between accounts, each waiting its own delay', async () => {
    const ctx = createContext()
    const ran: number[] = []
    for (const accountId of [1, 2]) {
      runAccount(ctx, accountId, {
        scheduler: createSchedulerStub({
          getNextJob: () => jobOf(SyncJobType.ForwardCatchup),
        }),
        worker: createWorkerStub({
          processJobReal: mock(async () => {
            ran.push(accountId)
            return { success: true, messagesFetched: 1 }
          }),
        }),
      })
    }
    const clock = useClock()

    try {
      for (let tick = 0; tick < 5; tick++) {
        await processJobs(ctx)
        clock.advance(1000)
      }
    } finally {
      clock.restore()
    }

    // 1 and 2 at 0 s and 1 s; both wait 3 s from their own last job
    expect(ran).toEqual([1, 2, 1, 2])
  })
})

describe('processJobs with two accounts', () => {
  const ALICE = 5001
  let dbs: Database[]

  beforeEach(() => {
    dbs = []
  })

  afterEach(() => {
    for (const db of dbs) db.close()
  })

  /** A client that records the getHistory peers it is asked for */
  function recordingClient() {
    const peers: tl.TypeInputPeer[] = []
    const client = asTelegramClient({
      call: mock(async (request: { _: string; peer?: tl.TypeInputPeer }) => {
        if (request.peer) peers.push(request.peer)
        return { _: 'messages.messages', messages: [], chats: [], users: [] }
      }) as unknown as TelegramClient['call'],
    })
    return { client, peers }
  }

  /**
   * An account whose cache knows Alice's DM with the account's own access
   * hash, and is due for its first page
   */
  function seedAccount(
    ctx: DaemonContext,
    accountId: number,
    options: { withChat: boolean },
  ) {
    const db = createAccountCacheDb()
    dbs.push(db)
    if (options.withChat) {
      createChatsCache(db).upsert({
        chat_id: String(ALICE),
        type: 'private',
        title: 'Alice Able',
        username: null,
        member_count: null,
        access_hash: `${accountId}${accountId}${accountId}`,
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: Date.now(),
        raw_json: '{}',
      })
      createChatSyncStateService(db).upsert({
        chat_id: ALICE,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    }
    const recording = recordingClient()
    connect(ctx, accountId, recording.client)
    const rt = addAccountRuntime(ctx, accountId, db)
    return { db, rt, ...recording }
  }

  const pendingJobs = (db: Database) =>
    createSyncJobsService(db).getPendingJobs()

  it("runs a job from account 2's cache on account 2's client", async () => {
    const ctx = createContext()
    const first = seedAccount(ctx, 1, { withChat: false })
    const second = seedAccount(ctx, 2, { withChat: true })
    await initializeScheduler(ctx)
    expect(pendingJobs(second.db)).toHaveLength(1)

    await processJobs(ctx)

    expect(first.peers).toEqual([])
    expect(second.peers).toHaveLength(1)
    expect(second.peers[0]).toMatchObject({
      _: 'inputPeerUser',
      userId: ALICE,
    })
    expect((second.peers[0] as tl.RawInputPeerUser).accessHash.toString()).toBe(
      '222',
    )
    expect(pendingJobs(second.db)).toHaveLength(0)
  })

  it("keeps a disconnected account's jobs pending", async () => {
    const ctx = createContext()
    const first = seedAccount(ctx, 1, { withChat: true })
    const second = seedAccount(ctx, 2, { withChat: true })
    await initializeScheduler(ctx)
    // Account 1 drops its connection: its worker goes with the client
    const firstState = ctx.state.accounts.get(1)!
    firstState.status = 'reconnecting'
    firstState.client = undefined
    first.rt.worker = null
    const clock = useClock()

    try {
      for (let tick = 0; tick < 4; tick++) {
        await processJobs(ctx)
        clock.advance(4000)
      }
    } finally {
      clock.restore()
    }

    expect(pendingJobs(first.db)).toHaveLength(1)
    expect(first.peers).toEqual([])
    // Account 2 never ran account 1's job: every peer carries its own hash
    expect(
      second.peers.map((peer) =>
        (peer as tl.RawInputPeerUser).accessHash.toString(),
      ),
    ).toEqual(['222'])
  })

  it("runs account 2's jobs while account 1 waits out a FLOOD_WAIT", async () => {
    const ctx = createContext()
    const first = seedAccount(ctx, 1, { withChat: true })
    const second = seedAccount(ctx, 2, { withChat: true })
    await initializeScheduler(ctx)
    createRateLimitsService(first.db).setFloodWait('messages.getHistory', 600)

    await processJobs(ctx)

    expect(first.peers).toEqual([])
    expect(second.peers).toHaveLength(1)
    expect(pendingJobs(first.db)).toHaveLength(1)
    expect(
      createRateLimitsService(second.db).isBlocked('messages.getHistory'),
    ).toBe(false)
  })
})

describe('cleanupScheduler', () => {
  it("cleans up every account's old jobs and drops its scheduler and worker", () => {
    const ctx = createContext()
    const schedulers = [1, 2].map((accountId) => {
      const scheduler = createSchedulerStub({ cleanup: mock(() => 2) })
      runAccount(ctx, accountId, { scheduler })
      return scheduler
    })

    cleanupScheduler(ctx)

    for (const scheduler of schedulers) {
      expect(scheduler.cleanup).toHaveBeenCalled()
    }
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      '[Account 1] Cleaned up 2 old jobs',
    )
    for (const rt of ctx.runtime.accounts.values()) {
      expect(rt.scheduler).toBeNull()
      expect(rt.worker).toBeNull()
    }
  })
})
