/**
 * The job budget on a large account: history backfill and first pages must
 * make progress next to forward catch-up (#6), and chats that are caught up
 * must cost nothing.
 *
 * Runs the real scheduler, sync worker and job loop against a fake history
 * for 500 chats.
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import { processJobs } from '../daemon/daemon-scheduler'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
import { createSyncPacer } from '../daemon/sync-pacing'
import { createRealSyncWorker } from '../daemon/sync-worker'
import {
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createTestDatabase } from '../db/index.ts'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import { createSyncJobsService, type SyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  type SyncJobRow,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { addAccountRuntime } from './helpers/daemon-runtime'
import {
  createMultiChatHistory,
  type GetHistoryRequest,
  range,
} from './helpers/fake-history'

// Private chats with made-up user IDs, 100 or 200 per group
const GAP_CHATS = range(10_001, 10_200)
const CAUGHT_UP_CHATS = range(20_001, 20_100)
const HISTORY_CHATS = range(30_001, 30_100)
const NEW_CHATS = range(40_001, 40_100)

const CURSOR = 1000

describe('job budget with 500 chats', () => {
  let db: Database
  let chatSyncState: ChatSyncStateService
  let jobsService: SyncJobsService
  let scheduler: SyncScheduler
  let history: ReturnType<typeof createMultiChatHistory>
  let ctx: DaemonContext

  function seed(
    chatId: number,
    state: {
      forward?: number
      backward?: number
      top?: number
      historyComplete?: boolean
    },
    messageIds: number[],
  ) {
    chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: state.forward,
      backward_cursor: state.backward,
    })
    if (state.historyComplete) chatSyncState.markHistoryComplete(chatId)
    if (state.top !== undefined) {
      chatSyncState.raiseTopMessageId(chatId, state.top)
    }
    history.set(chatId, messageIds)
  }

  beforeEach(() => {
    db = createTestCacheDatabase().db
    initSyncSchema(db)
    chatSyncState = createChatSyncStateService(db)
    jobsService = createSyncJobsService(db)
    const messagesCache = createMessagesCache(db)
    history = createMultiChatHistory()

    // 150 messages arrived above the cursor while the daemon was stopped
    for (const chatId of GAP_CHATS) {
      seed(
        chatId,
        { forward: CURSOR, backward: 1, top: 1150, historyComplete: true },
        range(1, 1150),
      )
    }
    // Nothing new since the last run
    for (const chatId of CAUGHT_UP_CHATS) {
      seed(
        chatId,
        { forward: CURSOR, backward: 1, top: CURSOR, historyComplete: true },
        range(1, CURSOR),
      )
    }
    // Up to date, with messages 1-300 still to backfill
    for (const chatId of HISTORY_CHATS) {
      seed(
        chatId,
        { forward: CURSOR, backward: 301, top: CURSOR },
        range(1, CURSOR),
      )
    }
    // Never synced, 300 messages each
    for (const chatId of NEW_CHATS) {
      seed(chatId, {}, range(1, 300))
    }

    scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    })

    ctx = {
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
      logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
      pidFile: {
        acquire: () => {},
        release: () => {},
        read: () => null,
        isRunning: () => false,
        sendSignal: () => false,
        getPath: () => '/tmp/tgcli/daemon.pid',
      },
      state: { running: true, accounts: new Map(), shutdownRequested: false },
      accountsDb: createTestDatabase().accountsDb,
      runtime: createDaemonRuntime(),
    }
    addAccountRuntime(ctx, 1, db, { scheduler })
    useClient(history.client)
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000000',
      name: null,
      status: 'connected',
      client: history.client,
    })
  })

  afterEach(() => {
    db.close()
  })

  /** Give the account a sync worker on this client */
  function useClient(client: TelegramClient) {
    account().worker = createRealSyncWorker({
      client,
      messagesCache: createMessagesCache(db),
      historyRanges: createHistoryRanges(db),
      chatSyncState,
      jobsService,
      rateLimits: createRateLimitsService(db),
      chatsCache: createChatsCache(db),
      usersCache: createUsersCache(db),
    })
  }

  /** The account's runtime: its cache, scheduler and worker */
  function account() {
    return ctx.runtime.accounts.get(1)!
  }

  /**
   * Run up to `limit` jobs through the daemon's job step, without the
   * inter-job delay, refreshing the queues every 10 jobs like the loop's
   * periodic refresh. Returns the jobs that ran, in order.
   */
  async function runJobs(limit: number) {
    const ran: Array<{ id: number; type: string }> = []
    while (ran.length < limit) {
      if (ran.length > 0 && ran.length % 10 === 0) scheduler.refreshQueues()
      const job = scheduler.getNextJob()
      if (!job) break
      account().pacer = createSyncPacer()
      await processJobs(ctx)
      expect(jobsService.getById(job.id)?.status).toBe('completed')
      ran.push({ id: job.id, type: job.job_type })
    }
    return ran
  }

  const countOf = (sql: string, ...params: number[]) =>
    (db.query(sql).get(...params) as { n: number }).n

  it('shares the budget between catch-up, first pages and history', async () => {
    await scheduler.initializeForStartup()

    const ran = await runJobs(1200)

    const first40: Record<string, number> = {}
    for (const job of ran.slice(0, 40)) {
      first40[job.type] = (first40[job.type] ?? 0) + 1
    }
    expect(first40).toEqual({
      [SyncJobType.ForwardCatchup]: 20,
      [SyncJobType.InitialLoad]: 10,
      [SyncJobType.BackwardHistory]: 10,
    })

    const firstHistory = ran.findIndex(
      (job) => job.type === SyncJobType.BackwardHistory,
    )
    expect(firstHistory).toBeGreaterThanOrEqual(0)
    expect(firstHistory).toBeLessThan(4)

    // Caught-up chats cost nothing; each gap chat takes two pages
    for (const chatId of CAUGHT_UP_CHATS) {
      expect(history.requestsFor(chatId)).toHaveLength(0)
    }
    expect(
      countOf(
        "SELECT COUNT(*) AS n FROM sync_jobs WHERE job_type = 'forward_catchup'",
      ),
    ).toBe(400)

    // The queue drained
    scheduler.refreshQueues()
    expect(scheduler.getNextJob()).toBeNull()
    // 400 catch-up pages, 100 first pages, 2 + 3 history pages per chat
    expect(ran.length).toBe(1000)
    expect(
      countOf(
        "SELECT COUNT(*) AS n FROM sync_jobs WHERE status != 'completed'",
      ),
    ).toBe(0)
    expect(history.requestCount).toBe(ran.length)

    for (const chatId of GAP_CHATS) {
      expect(
        countOf(
          'SELECT COUNT(*) AS n FROM messages_cache WHERE chat_id = ? AND message_id BETWEEN 1001 AND 1150',
          chatId,
        ),
      ).toBe(150)
      const state = chatSyncState.get(chatId)
      expect(state?.forward_cursor).toBe(1150)
      expect(state?.top_message_id).toBe(1150)
    }
    for (const chatId of [...HISTORY_CHATS, ...NEW_CHATS]) {
      expect(
        countOf(
          'SELECT COUNT(*) AS n FROM messages_cache WHERE chat_id = ? AND message_id BETWEEN 1 AND 300',
          chatId,
        ),
      ).toBe(300)
    }
    expect(
      countOf(
        `SELECT COUNT(*) AS n FROM chat_sync_state
         WHERE forward_cursor IS NULL OR backward_cursor IS NULL OR history_complete = 0`,
      ),
    ).toBe(0)
  }, 60_000)

  it('waits out a FLOOD_WAIT in every lane and resumes history from its cursor', async () => {
    const historyChat = HISTORY_CHATS[0]!
    let flooded = false
    useClient({
      call: async (request: GetHistoryRequest) => {
        const peer = request.peer as { userId?: number } | undefined
        if (!flooded && peer?.userId === historyChat) {
          flooded = true
          throw new Error('FLOOD_WAIT_30')
        }
        return history.client.call(request as never)
      },
    } as unknown as TelegramClient)

    await scheduler.initializeForStartup()

    // Catch-up, first page, catch-up, then the history page that floods
    const ran: SyncJobRow[] = []
    for (let i = 0; i < 4; i++) {
      ran.push(scheduler.getNextJob()!)
      account().pacer = createSyncPacer()
      await processJobs(ctx)
    }
    const floodedJob = ran[3]!
    expect(floodedJob.job_type).toBe(SyncJobType.BackwardHistory)
    expect(flooded).toBe(true)
    expect(chatSyncState.get(historyChat)?.backward_cursor).toBe(301)

    // The wait is a delay: the job keeps its attempts and nothing failed
    const failedRows = () =>
      countOf("SELECT COUNT(*) AS n FROM sync_jobs WHERE status = 'failed'")
    expect(failedRows()).toBe(0)
    expect(jobsService.getById(floodedJob.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
      error_message: 'Rate limited: wait 30s',
    })

    // While the block lasts, no lane runs a job
    const requests = history.requestCount
    const pending = jobsService.getPendingJobs().length
    for (let i = 0; i < 5; i++) {
      account().pacer = createSyncPacer()
      await processJobs(ctx)
    }
    expect(history.requestCount).toBe(requests)
    expect(jobsService.getPendingJobs()).toHaveLength(pending)
    expect(scheduler.getNextJob()).not.toBeNull()
    scheduler.refreshQueues()
    expect(jobsService.getById(floodedJob.id)).toMatchObject({
      status: 'pending',
      attempts: 0,
    })

    const realNow = Date.now
    const later = realNow() + 31_000
    Date.now = () => later
    try {
      scheduler.refreshQueues()
      for (let i = 0; i < 1200 && scheduler.getNextJob(); i++) {
        if (i > 0 && i % 10 === 0) scheduler.refreshQueues()
        account().pacer = createSyncPacer()
        await processJobs(ctx)
      }
    } finally {
      Date.now = realNow
    }

    expect(scheduler.getNextJob()).toBeNull()
    expect(history.requestsFor(historyChat).map((r) => r.offsetId)).toEqual([
      301, 201, 101,
    ])
    const state = chatSyncState.get(historyChat)
    expect(state?.backward_cursor).toBe(1)
    expect(state?.history_complete).toBe(1)
    // The page that flooded ran again as the same job
    expect(jobsService.getById(floodedJob.id)).toMatchObject({
      status: 'completed',
      attempts: 0,
    })
    expect(failedRows()).toBe(0)
  }, 60_000)

  it("stops a chat's pages after tg chats sync --off", async () => {
    const chatId = GAP_CHATS[0]!
    useClient({
      call: async (request: GetHistoryRequest) => {
        // The CLI turns the chat off while its first page is in flight
        chatSyncState.setSyncMode(chatId, 'off')
        jobsService.cancelPendingForChat(chatId)
        return history.client.call(request as never)
      },
    } as unknown as TelegramClient)
    scheduler.queueForwardCatchup(chatId)

    account().pacer = createSyncPacer()
    await processJobs(ctx)

    // The running page finished, but its full page queued nothing
    const state = chatSyncState.get(chatId)
    expect(state?.forward_cursor).toBe(1100)
    expect(state?.sync_enabled).toBe(0)
    expect(jobsService.getJobsForChat(chatId)).toMatchObject([
      { job_type: SyncJobType.ForwardCatchup, status: 'completed' },
    ])

    scheduler.refreshQueues()
    expect(jobsService.getJobsForChat(chatId)).toHaveLength(1)
  })
})

describe('job budget with two accounts', () => {
  let dbs: Database[]

  beforeEach(() => {
    dbs = []
  })

  afterEach(() => {
    for (const db of dbs) db.close()
  })

  function seedAccount(
    ctx: DaemonContext,
    accountId: number,
    chats: { gap?: number[]; history?: number[]; fresh?: number[] },
    ran: Array<{ accountId: number; type: string }>,
  ) {
    const db = createTestCacheDatabase().db
    initSyncSchema(db)
    dbs.push(db)
    const chatSyncState = createChatSyncStateService(db)
    const jobsService = createSyncJobsService(db)
    const messagesCache = createMessagesCache(db)
    const history = createMultiChatHistory()
    for (const chatId of chats.gap ?? []) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: CURSOR,
        backward_cursor: 1,
      })
      chatSyncState.markHistoryComplete(chatId)
      chatSyncState.raiseTopMessageId(chatId, 1150)
      history.set(chatId, range(1, 1150))
    }
    for (const chatId of chats.history ?? []) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: CURSOR,
        backward_cursor: 301,
      })
      chatSyncState.raiseTopMessageId(chatId, CURSOR)
      history.set(chatId, range(1, CURSOR))
    }
    for (const chatId of chats.fresh ?? []) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      history.set(chatId, range(1, 300))
    }
    const scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    })
    const recordJobRun = scheduler.recordJobRun.bind(scheduler)
    scheduler.recordJobRun = (job) => {
      ran.push({ accountId, type: job.job_type })
      recordJobRun(job)
    }
    addAccountRuntime(ctx, accountId, db, {
      scheduler,
      worker: createRealSyncWorker({
        client: history.client,
        messagesCache,
        historyRanges: createHistoryRanges(db),
        chatSyncState,
        jobsService,
        rateLimits: createRateLimitsService(db),
        chatsCache: createChatsCache(db),
        usersCache: createUsersCache(db),
      }),
    })
    ctx.state.accounts.set(accountId, {
      accountId,
      phone: `+1555000000${accountId}`,
      name: null,
      status: 'connected',
      client: history.client,
    })
    return { scheduler, chatSyncState }
  }

  it("doesn't let one account's catch-up backlog starve another's history", async () => {
    const ctx: DaemonContext = {
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
      logger: {
        info: mock(() => {}),
        debug: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      },
      pidFile: {
        acquire: () => {},
        release: () => {},
        read: () => null,
        isRunning: () => false,
        sendSignal: () => false,
        getPath: () => '/tmp/tgcli/daemon.pid',
      },
      state: { running: true, accounts: new Map(), shutdownRequested: false },
      accountsDb: createTestDatabase().accountsDb,
      runtime: createDaemonRuntime(),
    }
    const ran: Array<{ accountId: number; type: string }> = []
    const first = seedAccount(ctx, 1, { gap: GAP_CHATS.slice(0, 50) }, ran)
    const second = seedAccount(
      ctx,
      2,
      { history: HISTORY_CHATS.slice(0, 10), fresh: NEW_CHATS.slice(0, 10) },
      ran,
    )
    await first.scheduler.initializeForStartup()
    await second.scheduler.initializeForStartup()

    for (let i = 0; i < 20; i++) {
      for (const rt of ctx.runtime.accounts.values())
        rt.pacer = createSyncPacer()
      await processJobs(ctx)
    }

    // Both accounts run every tick
    expect(ran.slice(0, 6).map((job) => job.accountId)).toEqual([
      1, 2, 1, 2, 1, 2,
    ])
    // Account 2's first pages and history start at once
    const secondTypes = ran
      .filter((job) => job.accountId === 2)
      .slice(0, 4)
      .map((job) => job.type)
    expect(secondTypes).toContain(SyncJobType.InitialLoad)
    expect(secondTypes).toContain(SyncJobType.BackwardHistory)
    expect(ran.filter((job) => job.accountId === 1)).toHaveLength(20)
    expect(
      ran
        .filter((job) => job.accountId === 1)
        .every((job) => job.type === SyncJobType.ForwardCatchup),
    ).toBe(true)
  }, 30_000)
})
