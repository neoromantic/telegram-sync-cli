/**
 * Senders missing from the cache (#143): the daemon lists them once a day,
 * asks Telegram for one message of each by ID at the lowest priority, and
 * caches the senders the reply carries, which re-indexes their messages.
 * Made-up data only.
 */
import type { Database } from 'bun:sqlite'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'
import {
  createSyncScheduler,
  SENDER_SCAN_INTERVAL_MS,
} from '../daemon/scheduler'
import { processJobReal } from '../daemon/sync-worker-real-jobs'
import type { RealSyncWorkerContext } from '../daemon/sync-worker-real-types'
import { runPendingMigrations } from '../db/background-migrations'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { type CachedChatInput, createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import { createSenderLookups, SENDER_RETRY_MS } from '../db/sender-lookups'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  type SyncJobRow,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'

/** A supergroup whose access hash is cached */
const GROUP = -1_000_000_003_003
/** A basic group: messages.getMessages needs no hash */
const BASIC = -77
/** A channel without a cached access hash: Telegram can't be asked */
const NO_HASH = -1_000_000_004_004

const ALICIA = 7001
const BORIS = 7002
const CARMEN = 7003
const DMITRI = 7004

const DAY = 24 * 60 * 60 * 1000
const START = new Date('2026-03-01T00:00:00Z').getTime()

let db: Database
let ctx: RealSyncWorkerContext
let requests: Record<string, unknown>[]

function chatRow(chatId: number, accessHash: string | null): CachedChatInput {
  return {
    chat_id: String(chatId),
    type: 'supergroup',
    title: `Made-up group ${chatId}`,
    username: null,
    member_count: 500,
    access_hash: accessHash,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: 1,
    raw_json: '{}',
  }
}

function seed(
  chatId: number,
  messageId: number,
  fromId: number,
  extra: { is_deleted?: boolean } = {},
) {
  createMessagesCache(db).upsert({
    chat_id: chatId,
    message_id: messageId,
    from_id: fromId,
    text: `made-up note ${messageId} about tulips`,
    message_type: 'text',
    date: 1_700_000_000 + messageId,
    raw_json: '{}',
  })
  if (extra.is_deleted) createMessagesCache(db).markDeleted(chatId, [messageId])
}

function user(id: number, firstName: string): tl.RawUser {
  return {
    _: 'user',
    id,
    accessHash: toLong(900 + id),
    firstName,
    lastName: 'Example',
  } as tl.RawUser
}

/** A client whose getMessages answers with `users`, or throws `error` */
function answer(users: tl.TypeUser[], error?: Error) {
  ctx.client = {
    call: mock(async (request: Record<string, unknown>) => {
      requests.push(request)
      if (error) throw error
      return { _: 'messages.messages', messages: [], chats: [], users }
    }),
  } as unknown as TelegramClient
}

function lookupRows() {
  return db
    .query(
      'SELECT sender_id, chat_id, message_id, asked_at FROM sender_lookups ORDER BY sender_id',
    )
    .all()
}

function fetchJob(chatId: number): SyncJobRow {
  return ctx.jobsService.create({
    chat_id: chatId,
    job_type: SyncJobType.FetchSenders,
    priority: SyncPriority.Background,
  })
}

function scheduler() {
  return createSyncScheduler({
    db,
    jobsService: ctx.jobsService,
    chatSyncState: ctx.chatSyncState,
    messagesCache: ctx.messagesCache,
  })
}

beforeEach(() => {
  setSystemTime(new Date(START))
  db = createTestCacheDatabase().db
  initSyncSchema(db)
  requests = []
  ctx = {
    client: {} as TelegramClient,
    messagesCache: createMessagesCache(db),
    historyRanges: createHistoryRanges(db),
    chatSyncState: createChatSyncStateService(db),
    jobsService: createSyncJobsService(db),
    rateLimits: createRateLimitsService(db),
    chatsCache: createChatsCache(db),
    usersCache: createUsersCache(db),
    senderLookups: createSenderLookups(db),
    config: { apiMethod: 'messages.getHistory', batchSize: 100 },
  }
  createChatsCache(db).upsert(chatRow(GROUP, '4242'))
  createChatsCache(db).upsert(chatRow(NO_HASH, null))
  // An older cache: history synced without its senders (#126)
  for (const id of [10, 11, 12]) seed(GROUP, id, ALICIA)
  seed(GROUP, 13, BORIS)
  seed(GROUP, 14, GROUP) // the group posting as itself: not a user
  seed(BASIC, 500, CARMEN)
  seed(BASIC, 501, CARMEN, { is_deleted: true })
  seed(NO_HASH, 3, DMITRI)
  ctx.usersCache.upsert({
    user_id: String(BORIS),
    first_name: 'Boris',
    fetched_at: 1,
    raw_json: '{}',
  })
})

afterEach(() => {
  setSystemTime()
  db.close()
})

describe('senders missing from the cache (#143)', () => {
  it('lists each missing user once, with their newest message Telegram can be asked for', () => {
    expect(ctx.senderLookups.countMissing()).toBe(3)
    expect(ctx.senderLookups.scan(Date.now())).toBe(2)

    // Boris is cached and the group is no user; Dmitri's only chat has no
    // access hash, and Carmen's newest message is deleted
    expect(lookupRows()).toEqual([
      { sender_id: ALICIA, chat_id: GROUP, message_id: 12, asked_at: null },
      { sender_id: CARMEN, chat_id: BASIC, message_id: 500, asked_at: null },
    ])
    expect(ctx.senderLookups.chatsDue().sort((a, b) => a - b)).toEqual([
      GROUP,
      BASIC,
    ])
  })

  it('does not count a sender whose every cached message is deleted', () => {
    seed(GROUP, 30, 7006, { is_deleted: true })
    expect(ctx.senderLookups.countMissing()).toBe(3)
    expect(ctx.senderLookups.scan(Date.now())).toBe(2)
  })

  it('takes the newest message, not the one cached last: history is written newest first', () => {
    const ELENA = 7005
    seed(GROUP, 900, ELENA)
    seed(GROUP, 20, ELENA)
    ctx.senderLookups.scan(Date.now())
    expect(lookupRows()).toContainEqual({
      sender_id: ELENA,
      chat_id: GROUP,
      message_id: 900,
      asked_at: null,
    })
  })

  it('makes no job for a chat whose senders were cached after the scan', () => {
    ctx.senderLookups.scan(Date.now())
    ctx.usersCache.upsert({
      user_id: String(ALICIA),
      first_name: 'Alicia',
      fetched_at: 1,
      raw_json: '{}',
    })
    expect(ctx.senderLookups.chatsDue()).toEqual([BASIC])
  })

  it('caches the senders of the messages asked for, and search finds their older messages by name', async () => {
    runPendingMigrations(db)
    const search = createMessagesSearch(db)
    expect(search.search('sender:alicia')).toHaveLength(0)

    ctx.senderLookups.scan(Date.now())
    answer([user(ALICIA, 'Alicia')])
    const result = await processJobReal(ctx, fetchJob(GROUP))

    expect(result.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      _: 'channels.getMessages',
      channel: { _: 'inputChannel', channelId: 3003 },
      id: [{ _: 'inputMessageID', id: 12 }],
    })
    expect(ctx.usersCache.getById(String(ALICIA))).toMatchObject({
      first_name: 'Alicia',
      access_hash: String(900 + ALICIA),
    })
    // The users_cache row queued a re-index of her messages (#93)
    runPendingMigrations(db)
    expect(
      search
        .search('sender:alicia')
        .map((row) => row.message_id)
        .sort(),
    ).toEqual([10, 11, 12])
    expect(lookupRows()).toEqual([
      { sender_id: CARMEN, chat_id: BASIC, message_id: 500, asked_at: null },
    ])
    expect(ctx.senderLookups.countMissing()).toBe(2)
  })

  it('asks for a basic group with messages.getMessages', async () => {
    ctx.senderLookups.scan(Date.now())
    answer([user(CARMEN, 'Carmen')])
    await processJobReal(ctx, fetchJob(BASIC))

    expect(requests[0]).toEqual({
      _: 'messages.getMessages',
      id: [{ _: 'inputMessageID', id: 500 }],
    })
    expect(ctx.usersCache.getById(String(CARMEN))).not.toBeNull()
  })

  it('asks again after 30 days for a sender Telegram did not return, with their newest message', async () => {
    ctx.senderLookups.scan(Date.now())
    answer([])
    expect((await processJobReal(ctx, fetchJob(GROUP))).success).toBe(true)

    expect(ctx.senderLookups.countNotFound()).toBe(1)
    expect(lookupRows()[0]).toMatchObject({
      sender_id: ALICIA,
      asked_at: START,
    })
    expect(ctx.senderLookups.nextBatch(GROUP, 100)).toEqual([])

    seed(GROUP, 20, ALICIA)
    ctx.senderLookups.scan(START + 29 * DAY)
    expect(ctx.senderLookups.chatsDue()).toEqual([BASIC])

    ctx.senderLookups.scan(START + SENDER_RETRY_MS)
    expect(ctx.senderLookups.nextBatch(GROUP, 100)).toEqual([
      { sender_id: ALICIA, message_id: 20 },
    ])
  })

  it('does not ask again for a chat Telegram refuses for good', async () => {
    ctx.senderLookups.scan(Date.now())
    answer([], new tl.RpcError(400, 'CHANNEL_PRIVATE'))
    const result = await processJobReal(ctx, fetchJob(GROUP))

    expect(result).toMatchObject({ success: false, permanent: true })
    expect(ctx.senderLookups.chatsDue()).toEqual([BASIC])
    expect(ctx.senderLookups.countNotFound()).toBe(1)
  })

  it('keeps the senders waiting after an error that is retried', async () => {
    ctx.senderLookups.scan(Date.now())
    answer([], new Error('connection reset'))
    const result = await processJobReal(ctx, fetchJob(GROUP))

    expect(result).toMatchObject({ success: false, permanent: false })
    expect(ctx.senderLookups.nextBatch(GROUP, 100)).toHaveLength(1)
  })

  it('asks for at most 100 senders of a chat per request', async () => {
    for (let i = 0; i < 150; i++) seed(GROUP, 1000 + i, 8000 + i)
    ctx.senderLookups.scan(Date.now())
    answer([])
    await processJobReal(ctx, fetchJob(GROUP))

    expect((requests[0] as { id: unknown[] }).id).toHaveLength(100)
    expect(ctx.senderLookups.nextBatch(GROUP, 1000)).toHaveLength(51)
  })
})

describe('scheduling sender fetches (#143)', () => {
  it('queues one job per chat in any mode, run only when the other lanes are empty', () => {
    // Neither chat syncs: sender fetches don't depend on the mode
    const history = ctx.jobsService.create({
      chat_id: GROUP,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })
    const sched = scheduler()
    sched.refreshQueues()
    sched.refreshQueues()

    const fetches = ctx.jobsService
      .getPendingJobs()
      .filter((job) => job.job_type === SyncJobType.FetchSenders)
    expect(fetches.map((job) => [job.chat_id, job.priority]).sort()).toEqual(
      [
        [BASIC, SyncPriority.Background],
        [GROUP, SyncPriority.Background],
      ].sort(),
    )

    expect(sched.getNextJob()?.id).toBe(history.id)
    expect(sched.hasHistoryDue()).toBe(true)
    ctx.jobsService.markRunning(history.id)
    ctx.jobsService.markCompleted(history.id)
    expect(sched.getNextJob()?.job_type).toBe(SyncJobType.FetchSenders)
    // Sender fetches run at the calm pace, not the history pace (#133)
    expect(sched.hasHistoryDue()).toBe(false)

    // Turning a chat off, or a start's cleanup, keeps them
    ctx.jobsService.cancelPendingForChat(GROUP)
    ctx.jobsService.deletePendingForInactiveChats()
    expect(
      ctx.jobsService
        .getPendingJobs()
        .filter((job) => job.job_type === SyncJobType.FetchSenders),
    ).toHaveLength(2)
  })

  it('looks for missing senders on start and then once a day', () => {
    const sched = scheduler()
    sched.refreshQueues()
    expect(lookupRows()).toHaveLength(2)

    seed(BASIC, 600, 7777)
    sched.refreshQueues()
    expect(lookupRows()).toHaveLength(2)

    setSystemTime(new Date(START + SENDER_SCAN_INTERVAL_MS))
    sched.refreshQueues()
    expect(lookupRows()).toHaveLength(3)
  })
})

it("keeps a failed fetch job of a chat that doesn't sync, so it isn't retried at once", () => {
  ctx.senderLookups.scan(Date.now())
  const job = fetchJob(GROUP)
  ctx.jobsService.markRunning(job.id)
  ctx.jobsService.failOrDrop(job.id, 'CHANNEL_PRIVATE')
  expect(ctx.jobsService.getById(job.id)?.status).toBe(SyncJobStatus.Failed)
})
