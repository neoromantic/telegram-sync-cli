/**
 * Tests for sync worker real helpers/context
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient, tl } from '@mtcute/bun'
import {
  canMakeApiCall,
  getInputPeer,
  getWaitTime,
  recordApiCall,
  resolveFloodWaitResult,
} from '../daemon/sync-worker-real-context'
import {
  buildInputPeer,
  createMessageInputs,
  extractFloodWaitSeconds,
  fetchMessagesRaw,
} from '../daemon/sync-worker-real-helpers'
import type { RealSyncWorkerContext } from '../daemon/sync-worker-real-types'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema } from '../db/sync-schema'
import { toLong } from '../utils/long'

type MockCall = <T extends tl.RpcMethod>(
  request: T,
) => Promise<tl.RpcCallReturn[T['_']]>

type MockClient = Pick<TelegramClient, 'call'>

function assertInputPeerUser(
  peer: tl.TypeInputPeer | null,
): asserts peer is tl.RawInputPeerUser {
  if (peer?._ !== 'inputPeerUser') {
    throw new Error(`Expected inputPeerUser, got ${peer?._ ?? 'null'}`)
  }
}

function assertInputPeerChat(
  peer: tl.TypeInputPeer | null,
): asserts peer is tl.RawInputPeerChat {
  if (peer?._ !== 'inputPeerChat') {
    throw new Error(`Expected inputPeerChat, got ${peer?._ ?? 'null'}`)
  }
}

function assertInputPeerChannel(
  peer: tl.TypeInputPeer | null,
): asserts peer is tl.RawInputPeerChannel {
  if (peer?._ !== 'inputPeerChannel') {
    throw new Error(`Expected inputPeerChannel, got ${peer?._ ?? 'null'}`)
  }
}

function isGetHistoryRequest(
  request: tl.RpcMethod,
): request is tl.messages.RawGetHistoryRequest {
  return request._ === 'messages.getHistory'
}

function createMockClient(overrides: Partial<MockClient> = {}): TelegramClient {
  const client = {
    call: mock<MockCall>(async () => {
      throw new Error('Unexpected API call')
    }),
    ...overrides,
  } satisfies MockClient

  return client as TelegramClient
}

describe('sync-worker real helpers/context', () => {
  let db: Database

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    initSyncSchema(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('buildInputPeer', () => {
    it('returns inputPeerUser for missing chat', () => {
      const chatsCache = createChatsCache(db)
      const peer = buildInputPeer(123, chatsCache)

      expect(peer).not.toBeNull()
      assertInputPeerUser(peer)
      expect(peer.userId).toBe(123)
      expect(peer.accessHash?.toString()).toBe(toLong(0).toString())
    })

    it('returns null for negative chatId without cache entry', () => {
      const chatsCache = createChatsCache(db)
      const peer = buildInputPeer(-42, chatsCache)
      expect(peer).toBeNull()
    })

    it('builds input peers based on cached chat type', () => {
      const chatsCache = createChatsCache(db)
      const now = Date.now()

      chatsCache.upsert({
        chat_id: '1',
        type: 'private',
        title: 'Alice',
        username: 'alice',
        member_count: null,
        access_hash: '999',
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })

      chatsCache.upsert({
        chat_id: '2',
        type: 'group',
        title: 'Group',
        username: null,
        member_count: 10,
        access_hash: null,
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })

      chatsCache.upsert({
        chat_id: '3',
        type: 'channel',
        title: 'Channel',
        username: 'channel',
        member_count: 100,
        access_hash: '555',
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })

      const privatePeer = buildInputPeer(1, chatsCache)
      const groupPeer = buildInputPeer(2, chatsCache)
      const channelPeer = buildInputPeer(3, chatsCache)

      assertInputPeerUser(privatePeer)
      expect(privatePeer.accessHash?.toString()).toBe(toLong(999).toString())
      assertInputPeerChat(groupPeer)
      expect(groupPeer.chatId).toBe(2)
      assertInputPeerChannel(channelPeer)
      expect(channelPeer.channelId).toBe(3)
      expect(channelPeer.accessHash?.toString()).toBe(toLong(555).toString())
    })
  })

  describe('extractFloodWaitSeconds', () => {
    it('extracts seconds from FLOOD_WAIT error message', () => {
      expect(extractFloodWaitSeconds(new Error('FLOOD_WAIT_42'))).toBe(42)
    })

    it('extracts seconds from error.seconds', () => {
      const err = new Error('rate limit') as Error & { seconds?: number }
      err.seconds = 15
      expect(extractFloodWaitSeconds(err)).toBe(15)
    })

    it('returns null when no flood wait present', () => {
      expect(extractFloodWaitSeconds(new Error('OTHER'))).toBeNull()
    })
  })

  describe('createMessageInputs', () => {
    it('creates inputs and updates min/max ids', () => {
      const messages = [
        { _: 'message', id: 10, date: 1700000000, message: 'new' },
        { _: 'messageEmpty', id: 0, date: 0 },
        { _: 'message', id: 5, date: 1699999999, message: 'old' },
      ]

      const result = createMessageInputs(messages, 1, 999, 0)

      expect(result.inputs.length).toBe(2)
      expect(result.minId).toBe(5)
      expect(result.maxId).toBe(10)
    })
  })

  describe('fetchMessagesRaw', () => {
    it('returns messages and count from client.call', async () => {
      const client = createMockClient({
        call: mock<MockCall>(async (payload) => {
          if (!isGetHistoryRequest(payload)) {
            throw new Error('Unexpected API call')
          }

          expect(payload.offsetId).toBe(5)

          const result: tl.messages.RawMessages = {
            _: 'messages.messages',
            messages: [
              {
                _: 'message',
                id: 1,
                date: 1,
                message: 'hi',
                peerId: { _: 'peerUser', userId: 1 },
              },
            ],
            chats: [],
            users: [],
            topics: [],
          }

          return result
        }),
      })

      const result = await fetchMessagesRaw(
        client,
        { _: 'inputPeerUser', userId: 1, accessHash: toLong(0) },
        { offsetId: 5, limit: 1 },
      )

      expect(result.messages.length).toBe(1)
      expect(result.count).toBeUndefined()
    })
  })

  describe('sync-worker real context helpers', () => {
    it('records API call and checks wait state', () => {
      const rateLimits = createRateLimitsService(db)
      const ctx: RealSyncWorkerContext = {
        client: createMockClient(),
        messagesCache: createMessagesCache(db),
        chatSyncState: createChatSyncStateService(db),
        jobsService: createSyncJobsService(db),
        rateLimits,
        chatsCache: createChatsCache(db),
        config: { apiMethod: 'messages.getHistory', batchSize: 1 },
      }

      expect(canMakeApiCall(ctx)).toBe(true)
      recordApiCall(ctx)
      expect(rateLimits.getCallCount('messages.getHistory', 1)).toBe(1)
    })

    it('returns wait time when blocked and resolves flood waits', () => {
      const rateLimits = createRateLimitsService(db)
      const ctx: RealSyncWorkerContext = {
        client: createMockClient(),
        messagesCache: createMessagesCache(db),
        chatSyncState: createChatSyncStateService(db),
        jobsService: createSyncJobsService(db),
        rateLimits,
        chatsCache: createChatsCache(db),
        config: { apiMethod: 'messages.getHistory', batchSize: 1 },
      }

      rateLimits.setFloodWait('messages.getHistory', 10)
      expect(getWaitTime(ctx)).toBeGreaterThan(0)

      const result = resolveFloodWaitResult(ctx, new Error('FLOOD_WAIT_10'))
      expect(result?.rateLimited).toBe(true)
      expect(rateLimits.isBlocked('messages.getHistory')).toBe(true)
    })

    it('returns null when no flood wait is detected', () => {
      const rateLimits = createRateLimitsService(db)
      const ctx: RealSyncWorkerContext = {
        client: createMockClient(),
        messagesCache: createMessagesCache(db),
        chatSyncState: createChatSyncStateService(db),
        jobsService: createSyncJobsService(db),
        rateLimits,
        chatsCache: createChatsCache(db),
        config: { apiMethod: 'messages.getHistory', batchSize: 1 },
      }

      const result = resolveFloodWaitResult(ctx, new Error('OTHER'))
      expect(result).toBeNull()
    })

    it('delegates getInputPeer to buildInputPeer', () => {
      const chatsCache = createChatsCache(db)
      const ctx: RealSyncWorkerContext = {
        client: createMockClient(),
        messagesCache: createMessagesCache(db),
        chatSyncState: createChatSyncStateService(db),
        jobsService: createSyncJobsService(db),
        rateLimits: createRateLimitsService(db),
        chatsCache,
        config: { apiMethod: 'messages.getHistory', batchSize: 1 },
      }

      const inputPeer = getInputPeer(ctx, 77)
      assertInputPeerUser(inputPeer)
      expect(inputPeer.userId).toBe(77)
    })
  })
})
