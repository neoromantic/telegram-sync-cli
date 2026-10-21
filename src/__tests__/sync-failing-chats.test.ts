/**
 * Chats whose sync pages keep failing (#9): a transient error retries with
 * backoff and gives up after five attempts, a permanent error fails at once,
 * and neither queues the chat again on every refresh.
 *
 * Runs the real scheduler, sync worker and job loop against a fake history,
 * with a fake clock: one loop tick per second and a refresh every 30 ticks,
 * like the daemon.
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'
import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import { processJobs } from '../daemon/daemon-scheduler'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
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
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'
import { toPeerIdFromInputPeer } from '../utils/telegram-peer-ids'
import {
  createMultiChatHistory,
  type GetHistoryRequest,
  range,
} from './helpers/fake-history'

const T0 = 1_700_000_000_000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

// Private chats with made-up user IDs, and a made-up channel
const FAILING_CHAT = 50_001
const HEALTHY_CHAT = 50_002
const PRIVATE_CHANNEL_ID = 1234567890
const PRIVATE_CHANNEL = -1001234567890

describe('chats whose sync pages keep failing', () => {
  let db: Database
  let chatSyncState: ChatSyncStateService
  let jobsService: SyncJobsService
  let scheduler: SyncScheduler
  let ctx: DaemonContext
  let now: number
  const realNow = Date.now

  /** Errors to throw instead of a page, by chat */
  const failures = new Map<number, () => unknown>()
  /** Fake clock times of each chat's getHistory calls */
  let calls: Map<number, number[]>

  beforeEach(() => {
    now = T0
    Date.now = () => now
    failures.clear()
    calls = new Map()

    db = createTestCacheDatabase().db
    initSyncSchema(db)
    chatSyncState = createChatSyncStateService(db)
    jobsService = createSyncJobsService(db)
    const messagesCache = createMessagesCache(db)
    const chatsCache = createChatsCache(db)
    const history = createMultiChatHistory()

    // Both chats are behind: 150 messages above the cursor
    for (const chatId of [FAILING_CHAT, HEALTHY_CHAT]) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 1,
      })
      chatSyncState.markHistoryComplete(chatId)
      chatSyncState.raiseTopMessageId(chatId, 1150)
      history.set(chatId, range(1, 1150))
    }

    const client = {
      call: async (request: GetHistoryRequest) => {
        const chatId = request.peer
          ? (toPeerIdFromInputPeer(request.peer, null) ?? 0)
          : 0
        calls.set(chatId, [...(calls.get(chatId) ?? []), now])
        const failure = failures.get(chatId)
        if (failure) throw failure()
        return history.client.call(request as never)
      },
    } as unknown as TelegramClient

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
    ctx.runtime.scheduler = scheduler
    ctx.runtime.syncWorkers.set(
      1,
      createRealSyncWorker({
        client,
        messagesCache,
        historyRanges: createHistoryRanges(db),
        chatSyncState,
        jobsService,
        rateLimits: createRateLimitsService(db),
        chatsCache,
      }),
    )
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: '+15550000000',
      name: null,
      status: 'connected',
      client,
    })
  })

  afterEach(() => {
    Date.now = realNow
    db.close()
  })

  /** Run the daemon loop for `ms`: a job step every second, a refresh every 30 */
  async function runFor(ms: number) {
    const end = now + ms
    while (now < end) {
      now += 1000
      if ((now - T0) % 30_000 === 0) scheduler.refreshQueues()
      await processJobs(ctx)
    }
  }

  /** 100 refresh cycles, 30 seconds apart */
  async function refreshCycles(count = 100) {
    for (let i = 0; i < count; i++) {
      now += 30_000
      scheduler.refreshQueues()
      await processJobs(ctx)
    }
  }

  const callsFor = (chatId: number) => calls.get(chatId) ?? []

  const rowsFor = (chatId: number) =>
    db
      .query(
        'SELECT id, job_type, status, attempts, error_message FROM sync_jobs WHERE chat_id = ? ORDER BY id',
      )
      .all(chatId) as Array<{
      id: number
      job_type: string
      status: string
      attempts: number
      error_message: string | null
    }>

  const warnings = () =>
    (ctx.logger.warn as ReturnType<typeof mock>).mock.calls.map((call) =>
      String(call[0]),
    )

  function expectNoDuplicateRows() {
    expect(
      db
        .query(
          `SELECT chat_id, job_type FROM sync_jobs WHERE status != 'completed'
           GROUP BY 1, 2 HAVING COUNT(*) > 1`,
        )
        .all(),
    ).toEqual([])
  }

  it('retries a transient error after 1, 2, 4 and 8 minutes, then gives up', async () => {
    failures.set(FAILING_CHAT, () => new Error('connection reset'))
    await scheduler.initializeForStartup()

    await runFor(20 * MINUTE)

    const times = callsFor(FAILING_CHAT)
    expect(times).toHaveLength(5)
    expect(times.slice(1).map((time, i) => time - times[i]!)).toEqual([
      1 * MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
    ])
    expect(rowsFor(FAILING_CHAT)).toEqual([
      {
        id: expect.any(Number),
        job_type: SyncJobType.ForwardCatchup,
        status: 'failed',
        attempts: 5,
        error_message: 'connection reset',
      },
    ])

    // The other chat was caught up meanwhile
    expect(chatSyncState.get(HEALTHY_CHAT)?.forward_cursor).toBe(1150)

    const logged = warnings()
    expect(logged[0]).toContain('attempt 1 of 5')
    expect(logged[0]).toContain('connection reset')
    expect(logged.at(-1)).toContain('failed for good (after 5 attempts)')

    await refreshCycles()
    expect(callsFor(FAILING_CHAT)).toHaveLength(5)
    expect(rowsFor(FAILING_CHAT)).toHaveLength(1)
    expectNoDuplicateRows()
  })

  it('fails a CHANNEL_PRIVATE chat at once and tries it again a day later', async () => {
    createChatsCache(db).upsert({
      chat_id: String(PRIVATE_CHANNEL_ID),
      type: 'channel',
      title: 'Example News',
      username: 'examplenews',
      member_count: 5000,
      access_hash: '777',
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: T0,
      raw_json: '{}',
    })
    chatSyncState.upsert({
      chat_id: PRIVATE_CHANNEL,
      chat_type: 'channel',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    failures.set(PRIVATE_CHANNEL, () => new tl.RpcError(400, 'CHANNEL_PRIVATE'))
    await scheduler.initializeForStartup()

    await runFor(MINUTE)
    expect(callsFor(PRIVATE_CHANNEL)).toHaveLength(1)
    expect(rowsFor(PRIVATE_CHANNEL)).toMatchObject([
      { job_type: SyncJobType.InitialLoad, status: 'failed', attempts: 1 },
    ])
    expect(warnings()).toEqual([
      expect.stringContaining('failed for good (permanent error)'),
    ])

    await refreshCycles()
    expect(callsFor(PRIVATE_CHANNEL)).toHaveLength(1)
    expectNoDuplicateRows()

    // The daily cleanup deletes the failed row, so the chat gets one more try
    now = T0 + DAY + MINUTE
    scheduler.cleanup()
    await refreshCycles()
    expect(callsFor(PRIVATE_CHANNEL)).toHaveLength(2)
    expect(rowsFor(PRIVATE_CHANNEL)).toMatchObject([
      { job_type: SyncJobType.InitialLoad, status: 'failed', attempts: 1 },
    ])
    expectNoDuplicateRows()
  })

  for (const [label, error] of [
    ['a transient error', () => new Error('connection reset')],
    ['a permanent error', () => new tl.RpcError(400, 'CHANNEL_PRIVATE')],
  ] as const) {
    it(`drops the job of a chat turned off while its page was in flight, on ${label}`, async () => {
      failures.set(FAILING_CHAT, () => {
        // tg chats sync --off runs while the call is in flight
        chatSyncState.setSyncMode(FAILING_CHAT, 'off')
        jobsService.cancelPendingForChat(FAILING_CHAT)
        return error()
      })
      await scheduler.initializeForStartup()

      await runFor(MINUTE)
      expect(callsFor(FAILING_CHAT)).toHaveLength(1)
      expect(rowsFor(FAILING_CHAT)).toEqual([])
      // tg status has no failed job to show for it
      expect(jobsService.countJobs().failed).toBe(0)

      await refreshCycles()
      expect(callsFor(FAILING_CHAT)).toHaveLength(1)
      expect(rowsFor(FAILING_CHAT)).toEqual([])
      expectNoDuplicateRows()
    })
  }
})
