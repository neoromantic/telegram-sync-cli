/**
 * Messages an older version cached live with raw_json '{}' (#130): a
 * background migration queues one refetch job per chat, and the job fetches
 * them again by ID. Made-up data only.
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { createSyncScheduler } from '../daemon/scheduler'
import {
  processJobReal,
  REFETCH_BATCH_SIZE,
} from '../daemon/sync-worker-real-jobs'
import type { RealSyncWorkerContext } from '../daemon/sync-worker-real-types'
import {
  runMigrationBatch,
  runPendingMigrations,
} from '../db/background-migrations'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { BACKGROUND_MIGRATIONS } from '../db/raw-json-migrations'
import { createTestCacheDatabase } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { toRawJson } from '../utils/raw-json'
import { fakeDialog } from './helpers/fake-dialogs'
import { range } from './helpers/fake-history'
import { photoMessage } from './helpers/photo-message'

const DM = 5001
const CHANNEL_ID = 2002
const CHANNEL = -1_000_000_002_002

let db: Database
let ctx: RealSyncWorkerContext
let requests: Record<string, unknown>[]

/** A message as an older version cached it live: no raw_json */
function seedEmpty(chatId: number, messageId: number, hasMedia = false) {
  createMessagesCache(db).upsert({
    chat_id: chatId,
    message_id: messageId,
    text: hasMedia ? null : `made-up note ${messageId}`,
    message_type: hasMedia ? 'photo' : 'text',
    has_media: hasMedia,
    date: 1_700_000_000 + messageId,
    raw_json: '{}',
  })
}

function textMessage(peerId: Record<string, unknown>, id: number) {
  return {
    _: 'message',
    id,
    peerId,
    date: 1_700_000_000 + id,
    message: `made-up note ${id}`,
  }
}

/** A client whose getMessages answers with `messages` */
function answer(messages: unknown[]) {
  ctx.client = {
    call: mock(async (request: Record<string, unknown>) => {
      requests.push(request)
      return { _: 'messages.messages', messages, chats: [], users: [] }
    }),
  } as unknown as TelegramClient
}

function rawJsonOf(chatId: number, messageId: number) {
  return createMessagesCache(db).get(chatId, messageId)?.raw_json
}

beforeEach(() => {
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
    config: { apiMethod: 'messages.getHistory', batchSize: 100 },
  }
})

afterEach(() => {
  db.close()
})

const refetchMigration = BACKGROUND_MIGRATIONS.find(
  (migration) => migration.name === 'messages_refetch_empty_raw_json',
)!

/** Make the refetch pass pending again, as on a cache of an older version */
function restartRefetchPass() {
  db.run(
    `UPDATE cache_migrations SET state = 'pending', cursor = 0, end_rowid = NULL, done = 0, total = NULL WHERE name = ?`,
    [refetchMigration.name],
  )
}

/** One batch of the refetch pass, then every pending job, like the daemon interleaves them */
async function migrateBatchThenRunJobs(maxRows: number) {
  const batch = runMigrationBatch(db, refetchMigration, {
    maxRows,
    maxMs: 60_000,
  })
  for (const job of ctx.jobsService.getPendingJobs()) {
    await processJobReal(ctx, job)
  }
  return batch.finished
}

describe('refetching messages cached with an empty raw_json (#130)', () => {
  it('queues one low-priority job per chat in a background pass', async () => {
    for (const id of [3, 4]) seedEmpty(DM, id)
    seedEmpty(CHANNEL, 9)
    createMessagesCache(db).upsert({
      chat_id: 6001,
      message_id: 1,
      text: 'made-up note',
      message_type: 'text',
      date: 1_700_000_000,
      raw_json: JSON.stringify(textMessage({ _: 'peerUser', userId: 6001 }, 1)),
    })
    // A cache from an older version: the pass hasn't run on it yet
    db.run(
      `UPDATE cache_migrations SET state = 'pending', cursor = 0, end_rowid = NULL, done = 0, total = NULL`,
    )

    await runPendingMigrations(db)

    const jobs = ctx.jobsService
      .getPendingJobs()
      .map((job) => [job.chat_id, job.job_type, job.priority])
    expect(jobs).toEqual([
      [DM, SyncJobType.RefetchMessages, SyncPriority.Background],
      [CHANNEL, SyncJobType.RefetchMessages, SyncPriority.Background],
    ])
  })

  it('fills the rows Telegram still has, attachment included, and leaves the others', async () => {
    const peer = { _: 'peerUser', userId: DM } as const
    seedEmpty(DM, 3)
    seedEmpty(DM, 4, true)
    seedEmpty(DM, 5)
    ctx.jobsService.queueRefetch(DM)
    const photo = photoMessage(peer, 4)
    answer([
      textMessage(peer, 3),
      photo,
      { _: 'messageEmpty', id: 5 },
      // Another chat's message under a wanted ID is never written here
      textMessage({ _: 'peerUser', userId: 6001 }, 3),
    ])

    const [job] = ctx.jobsService.getPendingJobs()
    const result = await processJobReal(ctx, job!)

    expect(result).toMatchObject({ success: true, messagesFetched: 2 })
    expect(requests).toEqual([
      {
        _: 'messages.getMessages',
        id: [3, 4, 5].map((id) => ({ _: 'inputMessageID', id })),
      },
    ])
    expect(rawJsonOf(DM, 3)).toBe(toRawJson(textMessage(peer, 3)))
    expect(rawJsonOf(DM, 4)).toBe(toRawJson(photo))
    expect(rawJsonOf(DM, 5)).toBe('{}')
    expect(rawJsonOf(6001, 3)).toBeUndefined()
    expect(
      db
        .query('SELECT chat_id, message_id, kind FROM message_attachments')
        .all(),
    ).toEqual([{ chat_id: DM, message_id: 4, kind: 'photo' }])
    expect(ctx.jobsService.getJobsForChat(DM)).toMatchObject([
      { status: SyncJobStatus.Completed, cursor_start: 5 },
    ])
  })

  it('asks channels.getMessages for a channel, whose sync is off', async () => {
    createChatsCache(db).upsert(
      dialogToCacheInput(fakeDialog({ kind: 'channel', id: CHANNEL_ID })),
    )
    ctx.chatSyncState.upsert({
      chat_id: CHANNEL,
      chat_type: 'channel',
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    })
    seedEmpty(CHANNEL, 9)
    ctx.jobsService.queueRefetch(CHANNEL)
    const post = textMessage({ _: 'peerChannel', channelId: CHANNEL_ID }, 9)
    answer([post])

    // The startup cleanup drops jobs of chats that are off, but not this one
    await createSyncScheduler({
      db,
      jobsService: ctx.jobsService,
      chatSyncState: ctx.chatSyncState,
      messagesCache: ctx.messagesCache,
    }).initializeForStartup()
    const [job] = ctx.jobsService.getPendingJobs()
    expect(job).toMatchObject({
      job_type: SyncJobType.RefetchMessages,
      priority: SyncPriority.Background,
    })
    await processJobReal(ctx, job!)

    expect(requests).toMatchObject([
      {
        _: 'channels.getMessages',
        channel: { _: 'inputChannel', channelId: CHANNEL_ID },
        id: [{ _: 'inputMessageID', id: 9 }],
      },
    ])
    expect(rawJsonOf(CHANNEL, 9)).toBe(toRawJson(post))
  })

  it('takes 100 IDs per request and queues the next job above them', async () => {
    const peer = { _: 'peerUser', userId: DM } as const
    for (const id of range(1, REFETCH_BATCH_SIZE + 5)) seedEmpty(DM, id)
    ctx.jobsService.queueRefetch(DM)
    // Telegram has none of them any more
    answer([])

    const [first] = ctx.jobsService.getPendingJobs()
    await processJobReal(ctx, first!)
    const [second] = ctx.jobsService.getPendingJobs()
    expect(second).toMatchObject({
      job_type: SyncJobType.RefetchMessages,
      cursor_start: REFETCH_BATCH_SIZE,
    })
    answer([textMessage(peer, REFETCH_BATCH_SIZE + 2)])
    await processJobReal(ctx, second!)

    expect(requests.map((request) => (request.id as unknown[]).length)).toEqual(
      [REFETCH_BATCH_SIZE, 5],
    )
    expect(rawJsonOf(DM, REFETCH_BATCH_SIZE + 2)).not.toBe('{}')
    // The rows that stay '{}' are asked for once
    expect(ctx.jobsService.getPendingJobs()).toHaveLength(0)
  })

  it('queues a chat once per pass, even after its job failed for good', async () => {
    for (const id of range(1, 501)) seedEmpty(DM, id)
    restartRefetchPass()
    ctx.client = {
      call: mock(async (request: Record<string, unknown>) => {
        requests.push(request)
        throw new tl.RpcError(400, 'PEER_ID_INVALID')
      }),
    } as unknown as TelegramClient

    // 500 rows, the failing job, then the 501st row
    expect(await migrateBatchThenRunJobs(500)).toBe(false)
    while (!(await migrateBatchThenRunJobs(500))) {}

    expect(requests).toHaveLength(1)
    expect(ctx.jobsService.getJobsForChat(DM)).toMatchObject([
      { status: SyncJobStatus.Failed },
    ])
  })

  it('asks for a message Telegram no longer has once, across batches of the pass', async () => {
    seedEmpty(DM, 3)
    seedEmpty(DM, 4)
    restartRefetchPass()
    answer([
      { _: 'messageEmpty', id: 3 },
      { _: 'messageEmpty', id: 4 },
    ])

    while (!(await migrateBatchThenRunJobs(1))) {}

    expect(requests).toHaveLength(1)
    expect(rawJsonOf(DM, 3)).toBe('{}')
    expect(ctx.jobsService.getPendingJobs()).toHaveLength(0)
  })

  it('fetches a message cached without raw form while a refetch of its chat runs', async () => {
    const peer = { _: 'peerUser', userId: DM } as const
    seedEmpty(DM, 3)
    ctx.jobsService.queueRefetch(DM)
    ctx.client = {
      call: mock(async (request: Record<string, unknown>) => {
        requests.push(request)
        if (requests.length === 1) {
          // A live message without its raw form lands mid-request
          seedEmpty(DM, 9)
          ctx.jobsService.queueRefetch(DM)
          return { messages: [textMessage(peer, 3)], users: [] }
        }
        return { messages: [textMessage(peer, 9)], users: [] }
      }),
    } as unknown as TelegramClient

    for (let i = 0; i < 5; i++) {
      const [job] = ctx.jobsService.getPendingJobs()
      if (!job) break
      await processJobReal(ctx, job)
    }

    expect(requests).toHaveLength(2)
    expect(rawJsonOf(DM, 9)).toBe(toRawJson(textMessage(peer, 9)))
    expect(ctx.jobsService.getPendingJobs()).toHaveLength(0)
  })

  it('keeps a pending refetch when tg chats sync changes the mode', () => {
    seedEmpty(DM, 3)
    ctx.chatSyncState.upsert({
      chat_id: DM,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    expect(ctx.jobsService.queueRefetch(DM)).toBe(true)
    expect(ctx.jobsService.queueRefetch(DM)).toBe(false)

    ctx.jobsService.cancelPendingForChat(DM)
    ctx.jobsService.alignPendingPriorities()

    expect(ctx.jobsService.getPendingJobs()).toMatchObject([
      {
        job_type: SyncJobType.RefetchMessages,
        priority: SyncPriority.Background,
      },
    ])
  })
})
