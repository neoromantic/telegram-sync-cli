/**
 * Group participation: a group adds messages to the cache only while the
 * account sent an ordinary message there in the last 90 days
 * (src/db/group-participation.ts). Made-up data only.
 */
import { Database } from 'bun:sqlite'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcCallOptions, TelegramClient, tl } from '@mtcute/bun'

import {
  fetchHistoryPage,
  listHistory,
  resolveHistoryChat,
} from '../commands/messages/history'
import { createDmLookup } from '../commands/send/peer-resolver'
import { cacheSentMessage } from '../commands/send/sent-message-cache'
import { createUpdateHandlers } from '../daemon/handlers'
import { createSyncScheduler } from '../daemon/scheduler'
import { processJobReal } from '../daemon/sync-worker-real-jobs'
import type { RealSyncWorkerContext } from '../daemon/sync-worker-real-types'
import { chatSyncView, createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import {
  createGroupParticipation,
  PARTICIPATION_WINDOW_SECONDS,
} from '../db/group-participation'
import { readHistoryProgress } from '../db/history-progress'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache, type MessageInput } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { initCacheSchema } from '../db/schema'
import { createSenderLookups } from '../db/sender-lookups'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  type SyncChatType,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'

const SELF = 7000
const ALICE = 7101
/** Basic group 4101 */
const BASIC = -4101
/** Supergroup 9100000001 */
const SUPERGROUP = -1_009_100_000_001
/** Channel 9100000002 */
const CHANNEL = -1_009_100_000_002
/** A -100… chat the cache knows nothing about */
const UNTYPED = -1_009_100_000_003
const DM = ALICE
const W = PARTICIPATION_WINDOW_SECONDS
const DAY = 24 * 60 * 60
/** A made-up "now", in Unix seconds */
const NOW = 1_780_000_000

function createDb(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  cacheChat(db, SUPERGROUP, 'supergroup')
  cacheChat(db, CHANNEL, 'channel')
  cacheChat(db, BASIC, 'group')
  return db
}

function cacheChat(db: Database, chatId: number, type: SyncChatType) {
  createChatsCache(db).upsert({
    chat_id: String(chatId),
    type,
    title: `Made-up ${type}`,
    username: null,
    member_count: 5,
    access_hash: chatId < -1_000_000_000_000 ? '777' : null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: '{}',
  })
}

function message(
  chatId: number,
  id: number,
  date: number,
  extra: Partial<MessageInput> = {},
): MessageInput {
  return {
    chat_id: chatId,
    message_id: id,
    from_id: ALICE,
    text: `made-up note ${id}`,
    message_type: 'text',
    date,
    raw_json: '{}',
    ...extra,
  }
}

const own = { from_id: SELF, is_outgoing: true }

function setNow(seconds: number) {
  setSystemTime(new Date(seconds * 1000))
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n
}

function gaps(db: Database, chatId: number) {
  return db
    .query(
      'SELECT start_date, end_date FROM group_capture_gaps WHERE chat_id = ? ORDER BY start_date',
    )
    .all(chatId)
}

let db: Database

beforeEach(() => {
  setNow(NOW)
  db = createDb()
})

afterEach(() => {
  db.close()
  setSystemTime()
})

describe('GroupParticipation', () => {
  it('applies to basic groups, supergroups and chats of unknown type only', () => {
    const p = createGroupParticipation(db)
    expect(p.isGroup(BASIC)).toBe(true)
    expect(p.isGroup(SUPERGROUP)).toBe(true)
    expect(p.isGroup(UNTYPED)).toBe(true)
    expect(p.isGroup(CHANNEL)).toBe(false)
    expect(p.isGroup(DM)).toBe(false)

    expect(p.status(BASIC)).toBe('unknown')
    expect(p.captures(BASIC)).toBe(false)
    expect(p.captures(UNTYPED)).toBe(false)
    expect(p.captures(CHANNEL)).toBe(true)
    expect(p.captures(DM)).toBe(true)
  })

  it('keeps a group active for exactly 90 days after an own message', () => {
    const p = createGroupParticipation(db)
    p.recordCheck(BASIC, NOW - W + 1, NOW)
    expect(p.status(BASIC, NOW)).toBe('active')
    // At the boundary the group is already off
    expect(p.status(BASIC, NOW + 1)).toBe('inactive')
    expect(p.lastOwnDate(BASIC)).toBe(NOW - W + 1)
  })

  it('takes an own message as proof before the first check, but not an old one', () => {
    const p = createGroupParticipation(db)
    p.observeOwnMessage(BASIC, NOW - W - 1, NOW)
    expect(p.status(BASIC, NOW)).toBe('unknown')
    p.observeOwnMessage(SUPERGROUP, NOW - DAY, NOW)
    expect(p.status(SUPERGROUP, NOW)).toBe('active')
  })

  it('starts the first pause at the check that found nothing, and ends it at the next own message', () => {
    const p = createGroupParticipation(db)
    p.recordCheck(BASIC, null, NOW)
    expect(p.status(BASIC, NOW)).toBe('inactive')
    expect(p.canInsert(BASIC, NOW - 10 * DAY, NOW)).toBe(false)

    const back = NOW + 5 * DAY
    p.observeOwnMessage(BASIC, back, back)
    expect(gaps(db, BASIC)).toEqual([{ start_date: NOW, end_date: back }])
    // History from before the rule may still be cached; the pause may not
    expect(p.canInsert(BASIC, NOW - 10 * DAY, back)).toBe(true)
    expect(p.canInsert(BASIC, NOW + DAY, back)).toBe(false)
    expect(p.canInsert(BASIC, back, back)).toBe(true)
  })

  it('records each pause from expiry to the next own message, even noticed late', () => {
    const p = createGroupParticipation(db)
    p.recordCheck(BASIC, NOW - DAY, NOW)
    const first = NOW + 200 * DAY
    p.observeOwnMessage(BASIC, first, first)
    const second = first + 100 * DAY
    p.observeOwnMessage(BASIC, second, second + 10 * DAY)

    expect(gaps(db, BASIC)).toEqual([
      { start_date: NOW - DAY + W, end_date: first },
      { start_date: first + W, end_date: second },
    ])
    expect(p.canInsert(BASIC, first + W + DAY, second + DAY)).toBe(false)
    expect(p.canInsert(BASIC, first + DAY, second + DAY)).toBe(true)
  })

  it('never lowers the date or reopens a pause with an older or repeated fact', () => {
    const p = createGroupParticipation(db)
    p.recordCheck(BASIC, null, NOW)
    p.observeOwnMessage(BASIC, NOW + 10 * DAY, NOW + 10 * DAY)
    p.observeOwnMessage(BASIC, NOW + 2 * DAY, NOW + 10 * DAY)
    p.observeOwnMessage(BASIC, NOW + 10 * DAY, NOW + 10 * DAY)
    p.recordCheck(BASIC, null, NOW + 11 * DAY)

    expect(p.lastOwnDate(BASIC)).toBe(NOW + 10 * DAY)
    expect(gaps(db, BASIC)).toEqual([
      { start_date: NOW, end_date: NOW + 10 * DAY },
    ])
  })

  it('marks the newest message of a returning group unknown, so it gets a catch-up', () => {
    const state = createChatSyncStateService(db)
    state.upsert({
      chat_id: BASIC,
      chat_type: 'group',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 10,
    })
    state.markCaughtUp([BASIC])
    const p = createGroupParticipation(db)
    p.recordCheck(BASIC, null, NOW)
    expect(state.get(BASIC)?.top_message_id).toBe(10)

    p.observeOwnMessage(BASIC, NOW + DAY, NOW + DAY)
    expect(state.get(BASIC)?.top_message_id).toBeNull()
    expect(state.get(BASIC)?.forward_cursor).toBe(10)
  })

  it('takes the own messages an older cache holds as its first facts, once', () => {
    const cache = createMessagesCache(db)
    createGroupParticipation(db).recordCheck(BASIC, NOW, NOW)
    createGroupParticipation(db).recordCheck(SUPERGROUP, NOW, NOW)
    cache.upsertBatch([
      message(BASIC, 1, NOW - 5 * DAY, own),
      message(BASIC, 2, NOW - DAY, { ...own, message_type: 'service' }),
      message(SUPERGROUP, 3, NOW - 3 * DAY, {
        is_outgoing: true,
        // Sent as the group itself: an anonymous admin
        from_id: SUPERGROUP,
      }),
      message(SUPERGROUP, 4, NOW - 2 * DAY),
    ])
    // A cache from before the rule
    db.run('DROP TABLE group_participation')
    db.run('DROP TABLE group_capture_gaps')
    initSyncSchema(db)

    expect(
      db.query('SELECT * FROM group_participation ORDER BY chat_id').all(),
    ).toEqual([
      { chat_id: BASIC, last_own_date: NOW - 5 * DAY, initialized_at: null },
    ])
    expect(createGroupParticipation(db).status(BASIC)).toBe('active')
    expect(createGroupParticipation(db).status(SUPERGROUP)).toBe('unknown')
  })

  it('keeps the newest date when two connections write facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-participation-'))
    try {
      const path = join(dir, 'cache.db')
      const a = new Database(path)
      initCacheSchema(a)
      initSyncSchema(a)
      const b = new Database(path)
      const pa = createGroupParticipation(a)
      const pb = createGroupParticipation(b)
      pa.recordCheck(BASIC, null, NOW)
      pa.observeOwnMessage(BASIC, NOW + 5 * DAY, NOW + 5 * DAY)
      pb.observeOwnMessage(BASIC, NOW + 3 * DAY, NOW + 5 * DAY)
      pb.recordCheck(BASIC, NOW + 4 * DAY, NOW + 5 * DAY)

      expect(pa.lastOwnDate(BASIC)).toBe(NOW + 5 * DAY)
      expect(gaps(b, BASIC)).toEqual([
        { start_date: NOW, end_date: NOW + 5 * DAY },
      ])
      a.close()
      b.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('MessagesCache under the participation rule', () => {
  it('keeps new messages of a group out until the account takes part', () => {
    const cache = createMessagesCache(db)
    const photo = {
      _: 'message',
      id: 2,
      date: NOW,
      media: {
        _: 'messageMediaPhoto',
        photo: {
          _: 'photo',
          id: toLong(1),
          accessHash: toLong(2),
          fileReference: new Uint8Array(),
          date: NOW,
          sizes: [],
          dcId: 2,
        },
      },
    }
    const result = cache.upsertBatch([
      message(BASIC, 1, NOW),
      message(BASIC, 2, NOW, {
        message_type: 'photo',
        has_media: true,
        raw_json: JSON.stringify(photo),
      }),
      message(UNTYPED, 3, NOW),
      message(DM, 4, NOW),
      message(CHANNEL, 5, NOW),
    ])

    expect(result.inserted).toBe(2)
    expect(result.skipped).toBe(3)
    expect(result.accepted).toEqual([
      { chat_id: DM, message_id: 4 },
      { chat_id: CHANNEL, message_id: 5 },
    ])
    expect(cache.get(BASIC, 1)).toBeNull()
    expect(count(db, 'SELECT COUNT(*) AS n FROM message_attachments')).toBe(0)
    expect(
      count(
        db,
        `SELECT COUNT(*) AS n FROM message_search_text WHERE message_search_text MATCH 'made'`,
      ),
    ).toBe(2)
  })

  it('counts an own message before writing it, oldest first, and lets the rest of the batch in', () => {
    const cache = createMessagesCache(db)
    createGroupParticipation(db).recordCheck(BASIC, null, NOW - 30 * DAY)
    const result = cache.upsertBatch([
      message(BASIC, 9, NOW - DAY),
      message(BASIC, 7, NOW - 10 * DAY),
      message(BASIC, 8, NOW - 2 * DAY, { ...own, message_type: 'voice' }),
    ])

    // The pause ran until the own message; the one before it stays out
    expect(result.inserted).toBe(2)
    expect(cache.get(BASIC, 7)).toBeNull()
    expect(cache.participation.status(BASIC)).toBe('active')
    expect(gaps(db, BASIC)).toEqual([
      { start_date: NOW - 30 * DAY, end_date: NOW - 2 * DAY },
    ])
  })

  it('updates cached messages of a paused group and adds none', () => {
    const cache = createMessagesCache(db)
    cache.participation.recordCheck(BASIC, NOW - DAY, NOW)
    cache.upsert(message(BASIC, 1, NOW - DAY, own))
    cache.upsert(message(BASIC, 2, NOW))

    setNow(NOW + W)
    expect(cache.participation.status(BASIC)).toBe('inactive')
    const result = cache.upsertBatch([
      message(BASIC, 2, NOW, { text: 'edited note', is_edited: true }),
      message(BASIC, 3, NOW + W),
    ])
    cache.updateText(BASIC, 1, 'edited own note', NOW + W)

    expect(result).toEqual({
      accepted: [{ chat_id: BASIC, message_id: 2 }],
      inserted: 0,
      skipped: 1,
    })
    expect(cache.get(BASIC, 2)?.text).toBe('edited note')
    expect(cache.get(BASIC, 3)).toBeNull()
    // An edit is no participation
    expect(cache.participation.lastOwnDate(BASIC)).toBe(NOW - DAY)
  })

  it('counts neither service messages nor messages sent as the group', () => {
    const cache = createMessagesCache(db)
    cache.upsertBatch([
      message(BASIC, 1, NOW, { ...own, message_type: 'service' }),
      message(SUPERGROUP, 2, NOW, { is_outgoing: true, from_id: SUPERGROUP }),
      message(BASIC, 3, NOW, { from_id: SELF, is_outgoing: false }),
    ])
    expect(cache.participation.status(BASIC)).toBe('unknown')
    expect(cache.participation.status(SUPERGROUP)).toBe('unknown')
  })

  it("keeps one account's participation out of another account's cache", () => {
    const other = createDb()
    const a = createMessagesCache(db)
    const b = createMessagesCache(other)
    a.upsert(message(BASIC, 1, NOW, own))
    b.upsert(message(BASIC, 2, NOW))

    expect(a.participation.status(BASIC)).toBe('active')
    expect(b.participation.status(BASIC)).toBe('unknown')
    expect(b.get(BASIC, 2)).toBeNull()
    other.close()
  })
})

describe('the daemon under the participation rule', () => {
  function enableGroup(chatId: number, forwardCursor: number | null = null) {
    createChatSyncStateService(db).upsert({
      chat_id: chatId,
      chat_type: 'group',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: forwardCursor,
    })
    createChatSyncStateService(db).setSyncMode(chatId, 'on')
  }

  function workerContext(
    call: (request: { _: string }, params?: RpcCallOptions) => unknown,
  ): RealSyncWorkerContext {
    return {
      client: { call: mock(call) } as unknown as TelegramClient,
      messagesCache: createMessagesCache(db),
      historyRanges: createHistoryRanges(db),
      chatSyncState: createChatSyncStateService(db),
      jobsService: createSyncJobsService(db),
      rateLimits: createRateLimitsService(db),
      chatsCache: createChatsCache(db),
      usersCache: createUsersCache(db),
      senderLookups: createSenderLookups(db),
      config: { apiMethod: 'messages.getHistory', batchSize: 3 },
    }
  }

  function rawGroupMessage(id: number, date: number, extra = {}) {
    return {
      _: 'message',
      id,
      date,
      peerId: { _: 'peerChat', chatId: 4101 },
      fromId: { _: 'peerUser', userId: ALICE },
      message: `made-up note ${id}`,
      ...extra,
    }
  }

  function job(ctx: RealSyncWorkerContext, type: SyncJobType, chatId = BASIC) {
    return ctx.jobsService.create({
      chat_id: chatId,
      job_type: type,
      priority: SyncPriority.High,
    })
  }

  it('queues no work for a group turned on by hand until the account takes part', () => {
    enableGroup(BASIC)
    const cache = createMessagesCache(db)
    const jobs = createSyncJobsService(db)
    const scheduler = createSyncScheduler({
      db,
      jobsService: jobs,
      chatSyncState: createChatSyncStateService(db),
      messagesCache: cache,
    })
    jobs.create({
      chat_id: BASIC,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })
    const retry = jobs.create({
      chat_id: BASIC,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })
    db.run('UPDATE sync_jobs SET attempts = 2 WHERE id = ?', [retry.id])
    jobs.create({
      chat_id: BASIC,
      job_type: SyncJobType.CheckGroupParticipation,
      priority: SyncPriority.Background,
    })

    scheduler.refreshQueues()
    expect(jobs.getPendingJobs().map((j) => j.job_type)).toEqual([
      SyncJobType.CheckGroupParticipation,
    ])

    cache.participation.observeOwnMessage(BASIC, NOW)
    scheduler.refreshQueues()
    expect(
      jobs
        .getPendingJobs()
        .map((j) => j.job_type)
        .sort(),
    ).toEqual([SyncJobType.CheckGroupParticipation, SyncJobType.InitialLoad])
  })

  it('ends a queued job of a paused group without a request', async () => {
    enableGroup(BASIC, 10)
    const ctx = workerContext(() => {
      throw new Error('no request expected')
    })
    const result = await processJobReal(
      ctx,
      job(ctx, SyncJobType.ForwardCatchup),
    )
    expect(result).toMatchObject({ success: true, messagesFetched: 0 })
    expect(result.outcome?.state).toBe('completed')
    expect(ctx.chatSyncState.get(BASIC)?.forward_cursor).toBe(10)
  })

  it('moves the cursor past a pause without caching it or recording a range', async () => {
    enableGroup(BASIC, 10)
    const cache = createMessagesCache(db)
    cache.participation.recordCheck(BASIC, null, NOW - 20 * DAY)
    cache.participation.observeOwnMessage(BASIC, NOW - DAY)
    const ctx = workerContext(() => ({
      _: 'messages.messages',
      messages: [
        rawGroupMessage(13, NOW),
        rawGroupMessage(12, NOW - DAY, {
          out: true,
          fromId: { _: 'peerUser', userId: SELF },
        }),
        rawGroupMessage(11, NOW - 5 * DAY),
      ],
      users: [],
      chats: [],
    }))

    const result = await processJobReal(
      ctx,
      job(ctx, SyncJobType.ForwardCatchup),
    )

    expect(result).toMatchObject({ success: true, messagesFetched: 2 })
    expect(ctx.chatSyncState.get(BASIC)?.forward_cursor).toBe(13)
    expect(ctx.messagesCache.get(BASIC, 11)).toBeNull()
    expect(ctx.messagesCache.get(BASIC, 12)).not.toBeNull()
    expect(db.query('SELECT * FROM history_ranges').all()).toEqual([])
    expect(ctx.chatSyncState.get(BASIC)?.synced_messages).toBe(2)
  })

  it('ends a page whose group expired while it was in flight, moving nothing', async () => {
    enableGroup(BASIC, 10)
    const cache = createMessagesCache(db)
    cache.participation.recordCheck(BASIC, NOW - W + 5, NOW)
    const ctx = workerContext(() => {
      setNow(NOW + 10)
      return {
        _: 'messages.messages',
        messages: [rawGroupMessage(11, NOW + 9)],
        users: [],
        chats: [],
      }
    })

    const result = await processJobReal(
      ctx,
      job(ctx, SyncJobType.ForwardCatchup),
    )

    expect(result).toMatchObject({ success: true, messagesFetched: 0 })
    expect(result.outcome?.state).toBe('completed')
    expect(ctx.chatSyncState.get(BASIC)?.forward_cursor).toBe(10)
    expect(ctx.messagesCache.get(BASIC, 11)).toBeNull()
  })

  it('keeps an own message that arrived while a page was in flight', async () => {
    enableGroup(BASIC, 10)
    const cache = createMessagesCache(db)
    cache.participation.recordCheck(BASIC, NOW - DAY, NOW)
    const ctx = workerContext(() => {
      cache.participation.observeOwnMessage(BASIC, NOW)
      return {
        _: 'messages.messages',
        messages: [rawGroupMessage(11, NOW - 2 * DAY)],
        users: [],
        chats: [],
      }
    })
    await processJobReal(ctx, job(ctx, SyncJobType.ForwardCatchup))
    expect(cache.participation.lastOwnDate(BASIC)).toBe(NOW)
    expect(ctx.messagesCache.get(BASIC, 11)).not.toBeNull()
  })

  it('checks participation with one search for own messages of the last 90 days', async () => {
    const requests: Array<Record<string, unknown>> = []
    const ctx = workerContext((request) => {
      requests.push(request as Record<string, unknown>)
      return {
        _: 'messages.messages',
        messages: [
          { _: 'messageService', id: 30, date: NOW, out: true },
          rawGroupMessage(29, NOW - 3 * DAY, {
            out: true,
            fromId: { _: 'peerUser', userId: SELF },
            media: { _: 'messageMediaDocument' },
          }),
        ],
        users: [],
        chats: [],
      }
    })

    const result = await processJobReal(
      ctx,
      job(ctx, SyncJobType.CheckGroupParticipation),
    )

    expect(result.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      _: 'messages.search',
      peer: { _: 'inputPeerChat', chatId: 4101 },
      q: '',
      fromId: { _: 'inputPeerSelf' },
      minDate: NOW - W,
    })
    const p = createGroupParticipation(db)
    expect(p.lastOwnDate(BASIC)).toBe(NOW - 3 * DAY)
    expect(p.status(BASIC)).toBe('active')
    // Nothing of the search goes to the cache
    expect(count(db, 'SELECT COUNT(*) AS n FROM messages_cache')).toBe(0)
  })

  it('records an empty search as no participation, and an error as nothing', async () => {
    const failing = workerContext(() => {
      throw new Error('CHAT_ADMIN_REQUIRED')
    })
    const failed = await processJobReal(
      failing,
      job(failing, SyncJobType.CheckGroupParticipation),
    )
    expect(failed.success).toBe(false)
    expect(createGroupParticipation(db).status(BASIC)).toBe('unknown')

    const empty = workerContext(() => ({
      _: 'messages.messages',
      messages: [],
      users: [],
      chats: [],
    }))
    await processJobReal(empty, job(empty, SyncJobType.CheckGroupParticipation))
    expect(createGroupParticipation(db).status(BASIC)).toBe('inactive')

    const flood = workerContext(() => {
      throw new Error('FLOOD_WAIT_30')
    })
    const deferred = await processJobReal(
      flood,
      job(flood, SyncJobType.CheckGroupParticipation, SUPERGROUP),
    )
    expect(deferred.rateLimited).toBe(true)
    expect(createGroupParticipation(db).status(SUPERGROUP)).toBe('unknown')
  })

  it('keeps live messages of a group the account left, and starts again on an own one', async () => {
    const cache = createMessagesCache(db)
    const state = createChatSyncStateService(db)
    let synced = 0
    const handlers = createUpdateHandlers({
      db,
      messagesCache: cache,
      chatSyncState: state,
      onMessagesSynced: (n) => {
        synced += n
      },
    })
    const ctx = { accountId: 1, receivedAt: Date.now() }
    const live = (id: number, extra = {}) => ({
      chatId: BASIC,
      chatType: 'group' as const,
      memberCount: 5,
      messageId: id,
      fromId: ALICE,
      text: `made-up note ${id}`,
      date: NOW,
      isOutgoing: false,
      rawMessage: { _: 'message', id },
      ...extra,
    })

    await handlers.handleNewMessage(ctx, live(1))
    await handlers.handleNewMessage(
      ctx,
      live(2, { fromId: SELF, isOutgoing: true, messageType: 'service' }),
    )
    expect(cache.get(BASIC, 1)).toBeNull()
    expect(cache.get(BASIC, 2)).toBeNull()
    expect(state.get(BASIC)?.chat_type).toBe('group')
    expect(synced).toBe(0)

    await handlers.handleNewMessage(
      ctx,
      live(3, { fromId: SELF, isOutgoing: true }),
    )
    await handlers.handleNewMessage(ctx, live(4))
    expect(cache.get(BASIC, 3)).not.toBeNull()
    expect(cache.get(BASIC, 4)).not.toBeNull()
    expect(synced).toBe(2)
    expect(state.get(BASIC)?.synced_messages).toBe(2)
  })

  it('leaves paused groups out of the history progress', () => {
    enableGroup(BASIC)
    db.run(
      'UPDATE chat_sync_state SET total_messages = 500 WHERE chat_id = ?',
      [BASIC],
    )
    expect(readHistoryProgress(db).chats_pending).toBe(0)

    const p = createGroupParticipation(db)
    p.recordCheck(BASIC, null, NOW - 10 * DAY)
    p.observeOwnMessage(BASIC, NOW - DAY)
    // A group with a pause has no server count to reach
    expect(readHistoryProgress(db)).toMatchObject({
      chats_pending: 1,
      chats_without_count: 1,
      messages_left: 0,
    })
  })

  it('shows why a group takes no messages, whatever its mode', () => {
    enableGroup(BASIC)
    const p = createGroupParticipation(db)
    const state = createChatSyncStateService(db)
    expect(chatSyncView(p, BASIC, state.get(BASIC))).toEqual({
      syncEnabled: false,
      syncReason: 'group_participation_unknown',
      lastOwnMessageAt: null,
    })
    p.recordCheck(BASIC, NOW - W - DAY, NOW)
    expect(chatSyncView(p, BASIC, state.get(BASIC))).toEqual({
      syncEnabled: false,
      syncReason: 'group_participation_required',
      lastOwnMessageAt: (NOW - W - DAY) * 1000,
    })
    p.observeOwnMessage(BASIC, NOW)
    expect(chatSyncView(p, BASIC, state.get(BASIC))).toMatchObject({
      syncEnabled: true,
      syncReason: 'on_by_hand',
    })
    expect(chatSyncView(p, DM, null)).toEqual({
      syncEnabled: false,
      syncReason: null,
      lastOwnMessageAt: null,
    })
  })
})

describe('the CLI under the participation rule', () => {
  it('shows a Telegram page of a paused group without caching it', async () => {
    createUsersCache(db).upsert({
      user_id: String(ALICE),
      first_name: 'Alice',
      last_name: null,
      username: 'alice_example',
      access_hash: '1',
      fetched_at: Date.now(),
      raw_json: '{}',
    })
    const client = {
      call: async () => ({
        _: 'messages.messages',
        messages: [3, 2, 1].map((id) => ({
          _: 'message',
          id,
          date: NOW - id,
          peerId: { _: 'peerChat', chatId: 4101 },
          fromId: { _: 'peerUser', userId: ALICE },
          message: `made-up note ${id}`,
        })),
        users: [],
        chats: [],
      }),
    }

    const rows = await fetchHistoryPage(
      client,
      db,
      { chatId: BASIC, inputPeer: { _: 'inputPeerChat', chatId: 4101 } },
      { limit: 3 },
    )

    expect(rows.map((row) => row.message_id)).toEqual([3, 2, 1])
    expect(rows[0]).toMatchObject({
      text: 'made-up note 3',
      chat_title: 'Made-up group',
      sender_username: 'alice_example',
    })
    expect(count(db, 'SELECT COUNT(*) AS n FROM messages_cache')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) AS n FROM history_ranges')).toBe(0)
  })

  it('caches the first page of a channel resolved by username, but not of a supergroup', async () => {
    // Neither chat is cached yet: resolving the username gives its type
    const read = async (
      username: string,
      channelId: number,
      megagroup: boolean,
    ) => {
      const channel = {
        _: 'channel',
        id: channelId,
        broadcast: !megagroup,
        megagroup,
        title: `Made-up ${username}`,
        username,
        accessHash: toLong(777),
        photo: { _: 'chatPhotoEmpty' },
        date: NOW - DAY,
      }
      const peer = { _: 'peerChannel', channelId }
      const client = {
        call: async (request: { _: string }) =>
          request._ === 'contacts.resolveUsername'
            ? { _: 'contacts.resolvedPeer', peer, chats: [channel], users: [] }
            : {
                _: 'messages.channelMessages',
                messages: [
                  {
                    _: 'message',
                    id: 1,
                    date: NOW - 10,
                    peerId: peer,
                    fromId: peer,
                    message: 'made-up post',
                  },
                ],
                chats: [channel],
                users: [],
              },
      } as unknown as TelegramClient
      const chat = await resolveHistoryChat(client, `@${username}`, {
        usersCache: createUsersCache(db),
        chatsCache: createChatsCache(db),
        dms: createDmLookup(db),
        accounts: {} as never,
        accountId: 1,
      })
      const { items } = await listHistory({
        cacheDb: db,
        client,
        chat,
        window: { limit: 20 },
        includeDeleted: false,
        fresh: true,
      })
      expect(items.map((item) => item.messageId)).toEqual([1])
      return db
        .query('SELECT message_id FROM messages_cache WHERE chat_id = ?')
        .all(chat.chatId)
    }

    expect(await read('made_up_broadcast', 9_100_000_004, false)).toEqual([
      { message_id: 1 },
    ])
    expect(await read('made_up_supergroup', 9_100_000_005, true)).toEqual([])
  })

  it('caches a message tg send sent, and the group takes messages again', async () => {
    const cache = createMessagesCache(db)
    cache.participation.recordCheck(BASIC, null, NOW - DAY)

    const cached = await cacheSentMessage(
      { cacheDb: db, getSelfId: async () => SELF },
      {
        _: 'updates',
        updates: [
          {
            _: 'updateNewMessage',
            message: {
              _: 'message',
              id: 50,
              out: true,
              date: NOW,
              peerId: { _: 'peerChat', chatId: 4101 },
              fromId: { _: 'peerUser', userId: SELF },
              message: 'made-up reply',
            } as unknown as tl.RawMessage,
            pts: 1,
            ptsCount: 1,
          },
        ],
        users: [],
        chats: [],
        date: NOW,
        seq: 0,
      },
      { peer: { _: 'inputPeerChat', chatId: 4101 }, text: 'made-up reply' },
    )

    expect(cached).toBe(1)
    expect(cache.get(BASIC, 50)?.text).toBe('made-up reply')
    expect(cache.participation.status(BASIC)).toBe('active')
  })
})

it('runs a participation check whether the group syncs or not', () => {
  const jobs = createSyncJobsService(db)
  const check = jobs.create({
    chat_id: UNTYPED,
    job_type: SyncJobType.CheckGroupParticipation,
    priority: SyncPriority.Background,
  })
  jobs.deletePendingForInactiveChats()
  expect(jobs.getById(check.id)?.status).toBe(SyncJobStatus.Pending)
})
