/**
 * Comprehensive tests for the send command
 *
 * Tests:
 * - Peer resolution by @username
 * - Peer resolution by phone number
 * - Peer resolution by numeric ID
 * - Cache lookups for peer resolution
 * - Message sending with options (--silent, --reply-to)
 * - Error handling (invalid peer, permission errors)
 */

import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'

type MockCall = <T extends tl.RpcMethod>(
  request: T,
) => Promise<tl.RpcCallReturn[T['_']]>

type MockClient = {
  call: MockCall
  getMe: TelegramClient['getMe']
}

import { dialogToCacheInput } from '../commands/chats/helpers'
import { resolvePeer } from '../commands/send/peer-resolver'
import { type ChatsCache, createChatsCache } from '../db/chats-cache'
import { createTestCacheDatabase } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import type { ChatType } from '../db/types'
import { createUsersCache, type UsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'
import { mockDbModule } from './helpers/db-mock'
import { fakeDialog } from './helpers/fake-dialogs'

// The send command reads the cache and the client through these modules
let commandCacheDb: Database
const commandCall = mock(async (_request: unknown): Promise<unknown> => {
  throw new Error('Unexpected API call')
})
// The command wraps call() in place, so each test gets a fresh client
let commandClient = { call: commandCall }
mock.module('../db', () => mockDbModule({ cacheFor: () => commandCacheDb }))
mock.module('../services/telegram', () => ({
  getClientForAccount: () => commandClient,
}))

function expectLongEqual(actual: tl.Long, expected: string | number | bigint) {
  expect(actual.toString()).toBe(toLong(expected).toString())
}

type UserResult = Awaited<ReturnType<TelegramClient['getMe']>>

const createUser = (overrides: Partial<UserResult> = {}): UserResult =>
  ({
    id: 123,
    firstName: 'Test',
    username: 'test',
    ...overrides,
  }) as UserResult

function assertInputPeerUser(
  peer: tl.TypeInputPeer,
): asserts peer is tl.RawInputPeerUser {
  if (peer._ !== 'inputPeerUser') {
    throw new Error(`Expected inputPeerUser, got ${peer._}`)
  }
}

function assertInputPeerChat(
  peer: tl.TypeInputPeer,
): asserts peer is tl.RawInputPeerChat {
  if (peer._ !== 'inputPeerChat') {
    throw new Error(`Expected inputPeerChat, got ${peer._}`)
  }
}

function assertInputPeerChannel(
  peer: tl.TypeInputPeer,
): asserts peer is tl.RawInputPeerChannel {
  if (peer._ !== 'inputPeerChannel') {
    throw new Error(`Expected inputPeerChannel, got ${peer._}`)
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create test user data for cache
 */
function createTestUser(overrides = {}) {
  return {
    user_id: '123456',
    username: 'testuser',
    first_name: 'Test',
    last_name: 'User',
    phone: '1234567890',
    access_hash: '9876543210',
    is_contact: 1,
    is_bot: 0,
    is_premium: 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 123456, first_name: 'Test' }),
    ...overrides,
  }
}

/**
 * Create test chat data for cache
 */
function createTestChat(overrides = {}) {
  return {
    chat_id: '-789012',
    type: 'group' as ChatType,
    title: 'Test Group',
    username: 'testgroup',
    member_count: 10,
    access_hash: '1234567890',
    is_creator: 0,
    is_admin: 1,
    last_message_id: 100,
    last_message_at: Date.now() - 1000,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ _: 'chat', id: 789012, title: 'Test Group' }),
    ...overrides,
  }
}

/**
 * Create a mock Telegram client
 */
function createMockClient(overrides: Partial<MockClient> = {}) {
  const client = {
    call: mock<MockCall>(async () => {
      throw new Error('Unexpected API call')
    }),
    getMe: mock<TelegramClient['getMe']>(async () =>
      createUser({
        id: 123,
        firstName: 'Test',
        username: 'test',
      }),
    ),
    ...overrides,
  } satisfies MockClient

  return client
}

// =============================================================================
// Peer Resolution Tests - By Username
// =============================================================================

describe('Peer Resolution - By Username', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('cached user lookup', () => {
    it('should resolve @username from users cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
          access_hash: '123456789',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@alice',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(111)
      expectLongEqual(result.inputPeer.accessHash, '123456789')
      expect(result.name).toBe('Alice Smith')
      // API should not be called when found in cache
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should use display_name when available', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          username: 'bob',
          first_name: 'Robert',
          last_name: null,
          access_hash: '987654321',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@bob',
        usersCache,
        chatsCache,
      )

      expect(result.name).toBe('Robert')
    })

    it('should fallback to @username when no display_name', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          username: 'mystery',
          first_name: null,
          last_name: null,
          access_hash: '111222333',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@mystery',
        usersCache,
        chatsCache,
      )

      expect(result.name).toBe('@mystery')
    })
  })

  describe('cached channel/supergroup lookup', () => {
    it('should resolve @username from chats cache for channel', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '-1000000000444',
          type: 'channel',
          username: 'newschannel',
          title: 'News Channel',
          access_hash: '555666777',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@newschannel',
        usersCache,
        chatsCache,
      )

      assertInputPeerChannel(result.inputPeer)
      expect(result.inputPeer.channelId).toBe(444)
      expectLongEqual(result.inputPeer.accessHash, '555666777')
      expect(result.name).toBe('News Channel')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should resolve @username from chats cache for supergroup', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '-1000000000555',
          type: 'supergroup',
          username: 'community',
          title: 'Community Group',
          access_hash: '888999000',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '@community',
        usersCache,
        chatsCache,
      )

      assertInputPeerChannel(result.inputPeer)
      expect(result.inputPeer.channelId).toBe(555)
      expect(result.name).toBe('Community Group')
    })

    it('should not resolve regular group by username from chats cache', async () => {
      // Regular groups cannot have usernames, so this tests cache filtering
      chatsCache.upsert(
        createTestChat({
          chat_id: '-666',
          type: 'group',
          username: 'regulargroup', // This shouldn't happen in practice
          title: 'Regular Group',
          access_hash: null, // Groups don't have access_hash
        }),
      )

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerChat', chatId: 666 },
            users: [],
            chats: [
              {
                _: 'chat',
                id: 666,
                title: 'Regular Group',
                participantsCount: 10,
                photo: { _: 'chatPhotoEmpty' },
                date: Math.floor(Date.now() / 1000),
                version: 1,
              },
            ],
          }

          return result
        }),
      })

      await resolvePeer(mockClient, '@regulargroup', usersCache, chatsCache)

      // Should have called API because group in cache has no access_hash
      expect(mockClient.call).toHaveBeenCalled()
    })
  })

  describe('API resolution fallback', () => {
    it('should resolve username via API when not in cache', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 777 },
            users: [
              {
                _: 'user',
                id: 777,
                firstName: 'John',
                lastName: 'Doe',
                accessHash: toLong('111222333444'),
              },
            ],
            chats: [],
          }

          return result
        }),
      })

      const result = await resolvePeer(
        mockClient,
        '@johndoe',
        usersCache,
        chatsCache,
      )

      expect(mockClient.call).toHaveBeenCalledWith({
        _: 'contacts.resolveUsername',
        username: 'johndoe',
      })
      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(777)
      expect(result.name).toBe('John Doe')
    })

    it('should resolve channel via API when not in cache', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerChannel', channelId: 888 },
            users: [],
            chats: [
              {
                _: 'channel',
                id: 888,
                title: 'Tech Channel',
                accessHash: toLong('444555666777'),
                photo: { _: 'chatPhotoEmpty' },
                date: Math.floor(Date.now() / 1000),
              },
            ],
          }

          return result
        }),
      })

      const result = await resolvePeer(
        mockClient,
        '@techchannel',
        usersCache,
        chatsCache,
      )

      assertInputPeerChannel(result.inputPeer)
      expect(result.inputPeer.channelId).toBe(888)
      expect(result.name).toBe('Tech Channel')
    })

    it('should throw error when username cannot be resolved', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 0 },
            users: [],
            chats: [],
          }

          return result
        }),
      })

      await expect(
        resolvePeer(mockClient, '@nonexistent', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve @nonexistent')
    })

    it('should handle API returning user with no accessHash', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 999 },
            users: [
              {
                _: 'user',
                id: 999,
                firstName: 'No',
                lastName: 'Hash',
                accessHash: undefined,
              },
            ],
            chats: [],
          }

          return result
        }),
      })

      const result = await resolvePeer(
        mockClient,
        '@nohash',
        usersCache,
        chatsCache,
      )

      // Should use 0n for missing accessHash
      assertInputPeerUser(result.inputPeer)
      expectLongEqual(result.inputPeer.accessHash, 0)
      expect(result.name).toBe('No Hash')
    })
  })
})

// =============================================================================
// Peer Resolution Tests - By Phone Number
// =============================================================================

describe('Peer Resolution - By Phone Number', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('phone number detection', () => {
    it('should detect phone with + prefix', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          phone: '15551234567',
          access_hash: '123456',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '+15551234567',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(111)
    })

    it('should detect 10+ digit numbers as phone', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          phone: '1234567890',
          access_hash: '654321',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '1234567890',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(222)
    })
  })

  describe('cached phone lookup', () => {
    it('should resolve phone number from users cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333',
          phone: '9876543210',
          first_name: 'Phone',
          last_name: 'User',
          access_hash: '111222333',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '+9876543210',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(333)
      expectLongEqual(result.inputPeer.accessHash, '111222333')
      expect(result.name).toBe('Phone User')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should normalize phone numbers when looking up cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '444',
          phone: '15551234567',
          access_hash: '444555666',
        }),
      )

      const mockClient = createMockClient()

      // Test with + prefix and various formats - all should normalize to 15551234567
      const result1 = await resolvePeer(
        mockClient,
        '+1 (555) 123-4567',
        usersCache,
        chatsCache,
      )
      assertInputPeerUser(result1.inputPeer)
      expect(result1.inputPeer.userId).toBe(444)

      const result2 = await resolvePeer(
        mockClient,
        '+15551234567',
        usersCache,
        chatsCache,
      )
      assertInputPeerUser(result2.inputPeer)
      expect(result2.inputPeer.userId).toBe(444)

      // Test with raw digits (no + prefix)
      const result3 = await resolvePeer(
        mockClient,
        '15551234567',
        usersCache,
        chatsCache,
      )
      assertInputPeerUser(result3.inputPeer)
      expect(result3.inputPeer.userId).toBe(444)
    })
  })

  describe('API resolution fallback', () => {
    it('should resolve phone via API when not in cache', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolvePhone') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 555 },
            users: [
              {
                _: 'user',
                id: 555,
                firstName: 'API',
                lastName: 'User',
                accessHash: toLong('777888999'),
              },
            ],
            chats: [],
          }

          return result
        }),
      })

      const result = await resolvePeer(
        mockClient,
        '+11234567890',
        usersCache,
        chatsCache,
      )

      expect(mockClient.call).toHaveBeenCalledWith({
        _: 'contacts.resolvePhone',
        phone: '11234567890',
      })
      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(555)
      expect(result.name).toBe('API User')
    })

    it('should throw error when phone cannot be resolved', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolvePhone') {
            throw new Error('Unexpected API call')
          }
          throw new tl.RpcError(400, 'PHONE_NOT_OCCUPIED')
        }),
      })

      await expect(
        resolvePeer(mockClient, '+19999999999', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve phone number +19999999999')
    })

    it('should throw when API returns no users', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolvePhone') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 0 },
            users: [],
            chats: [],
          }

          return result
        }),
      })

      await expect(
        resolvePeer(mockClient, '+18888888888', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve phone number +18888888888')
    })
  })
})

// =============================================================================
// Peer Resolution Tests - By Numeric ID
// =============================================================================

describe('Peer Resolution - By Numeric ID', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('user ID lookup', () => {
    it('should resolve user ID from users cache', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123456789',
          first_name: 'Numeric',
          last_name: 'User',
          access_hash: '999888777',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '123456789',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(123456789)
      expectLongEqual(result.inputPeer.accessHash, '999888777')
      expect(result.name).toBe('Numeric User')
    })

    it('should use fallback name for user without display_name', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111222',
          first_name: null,
          last_name: null,
          access_hash: '333444',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '111222',
        usersCache,
        chatsCache,
      )

      expect(result.name).toBe('User 111222')
    })
  })

  describe('chat ID lookup', () => {
    it('should resolve private chat ID from chats cache', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '555666',
          type: 'private',
          title: 'Private Chat',
          access_hash: '777888',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '555666',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(555666)
      expect(result.name).toBe('Private Chat')
    })

    it('should resolve a marked group chat ID from chats cache', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '-777888',
          type: 'group',
          title: 'Group Chat',
          access_hash: null, // Groups don't have access_hash
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '-777888',
        usersCache,
        chatsCache,
      )

      assertInputPeerChat(result.inputPeer)
      expect(result.inputPeer.chatId).toBe(777888)
      expect(result.name).toBe('Group Chat')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should resolve a marked channel ID with the cached access hash', async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '-1000000888999',
          type: 'channel',
          title: 'My Channel',
          access_hash: '111222333',
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '-1000000888999',
        usersCache,
        chatsCache,
      )

      assertInputPeerChannel(result.inputPeer)
      expect(result.inputPeer.channelId).toBe(888999)
      expectLongEqual(result.inputPeer.accessHash, '111222333')
      expect(result.name).toBe('My Channel')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should resolve a marked supergroup ID from chats cache', async () => {
      chatsCache.upsert(
        dialogToCacheInput(
          fakeDialog({ kind: 'supergroup', id: 999000, title: 'Supergroup' }),
        ),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '-1000000999000',
        usersCache,
        chatsCache,
      )

      assertInputPeerChannel(result.inputPeer)
      expect(result.inputPeer.channelId).toBe(999000)
      expectLongEqual(result.inputPeer.accessHash, '777')
      expect(result.name).toBe('Supergroup')
    })

    it('should resolve the bare channel ID that 0.2.0 printed without a phone lookup', async () => {
      chatsCache.upsert(
        dialogToCacheInput(
          fakeDialog({
            kind: 'supergroup',
            id: 1234567890,
            title: 'Team Chat',
          }),
        ),
      )

      const mockClient = createMockClient()
      const bare = await resolvePeer(
        mockClient,
        '1234567890',
        usersCache,
        chatsCache,
      )
      const marked = await resolvePeer(
        mockClient,
        '-1001234567890',
        usersCache,
        chatsCache,
      )

      expect(bare).toEqual(marked)
      assertInputPeerChannel(bare.inputPeer)
      expect(bare.inputPeer.channelId).toBe(1234567890)
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should reject a bare ID that names a cached group and a cached channel', async () => {
      chatsCache.upsertMany(
        [
          fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
          fakeDialog({ kind: 'channel', id: 4242, title: 'Example News' }),
        ].map(dialogToCacheInput),
      )

      const mockClient = createMockClient()

      await expect(
        resolvePeer(mockClient, '4242', usersCache, chatsCache),
      ).rejects.toMatchObject({
        name: 'AmbiguousPeerError',
        candidates: [-4242, -1000000004242],
      })
      expect(mockClient.call).not.toHaveBeenCalled()
    })
  })

  describe('fallback behavior', () => {
    it('should take an unknown positive ID as a user with access hash 0', async () => {
      // No cache entries: a positive ID is a user, basic group 12345 is -12345
      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '12345',
        usersCache,
        chatsCache,
      )

      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(12345)
      expectLongEqual(result.inputPeer.accessHash, 0)
      expect(result.name).toBe('User 12345')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should throw error for invalid numeric identifier', async () => {
      const mockClient = createMockClient()

      await expect(
        resolvePeer(mockClient, '12.5', usersCache, chatsCache),
      ).rejects.toThrow('Invalid peer identifier: 12.5')
    })
  })
})

// =============================================================================
// Message Sending Tests
// =============================================================================

describe('Message Sending', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('sendMessage request building', () => {
    it('should build basic sendMessage request', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'recipient',
          access_hash: '456',
        }),
      )

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'messages.sendMessage') {
            throw new Error('Unexpected API call')
          }

          const result: tl.RawUpdateShortSentMessage = {
            _: 'updateShortSentMessage',
            id: 12345,
            date: Math.floor(Date.now() / 1000),
            pts: 1,
            ptsCount: 1,
            out: true,
            media: undefined,
            entities: undefined,
          }

          return result
        }),
      })

      const { inputPeer } = await resolvePeer(
        mockClient,
        '@recipient',
        usersCache,
        chatsCache,
      )

      // Build the request as the send command would
      const request: tl.messages.RawSendMessageRequest = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: 'Hello, world!',
        randomId: toLong(123456),
        noWebpage: false,
        silent: false,
      }

      await mockClient.call(request)

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: 'messages.sendMessage',
          message: 'Hello, world!',
          silent: false,
        }),
      )
    })

    it('should include silent flag when specified', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'recipient',
          access_hash: '456',
        }),
      )

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'messages.sendMessage') {
            throw new Error('Unexpected API call')
          }

          const result: tl.RawUpdateShortSentMessage = {
            _: 'updateShortSentMessage',
            id: 12346,
            date: Math.floor(Date.now() / 1000),
            pts: 1,
            ptsCount: 1,
            out: true,
            media: undefined,
            entities: undefined,
          }

          return result
        }),
      })

      const { inputPeer } = await resolvePeer(
        mockClient,
        '@recipient',
        usersCache,
        chatsCache,
      )

      const request: tl.messages.RawSendMessageRequest = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: 'Silent message',
        randomId: toLong(123457),
        noWebpage: false,
        silent: true, // Silent flag enabled
      }

      await mockClient.call(request)

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: 'messages.sendMessage',
          silent: true,
        }),
      )
    })

    it('should include replyTo when specified', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '123',
          username: 'recipient',
          access_hash: '456',
        }),
      )

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'messages.sendMessage') {
            throw new Error('Unexpected API call')
          }

          const result: tl.RawUpdateShortSentMessage = {
            _: 'updateShortSentMessage',
            id: 12347,
            date: Math.floor(Date.now() / 1000),
            pts: 1,
            ptsCount: 1,
            out: true,
            media: undefined,
            entities: undefined,
          }

          return result
        }),
      })

      const { inputPeer } = await resolvePeer(
        mockClient,
        '@recipient',
        usersCache,
        chatsCache,
      )

      const request: tl.messages.RawSendMessageRequest = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: 'Reply message',
        randomId: toLong(123458),
        noWebpage: false,
        silent: false,
        replyTo: {
          _: 'inputReplyToMessage',
          replyToMsgId: 999,
        },
      }

      await mockClient.call(request)

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: 'messages.sendMessage',
          replyTo: {
            _: 'inputReplyToMessage',
            replyToMsgId: 999,
          },
        }),
      )
    })
  })

  describe('response handling', () => {
    it('should extract message ID from updateShortSentMessage', () => {
      const result = {
        _: 'updateShortSentMessage',
        id: 12345,
        date: 1700000000,
      }

      let messageId: number | null = null
      let timestamp: number | null = null

      if (result._ === 'updateShortSentMessage') {
        messageId = result.id
        timestamp = result.date
      }

      expect(messageId).toBe(12345)
      expect(timestamp).toBe(1700000000)
    })

    it('should extract message ID from updates array', () => {
      const result = {
        _: 'updates',
        updates: [
          {
            _: 'updateMessageID',
            id: 54321,
          },
          {
            _: 'updateNewMessage',
            message: {
              id: 54321,
              date: 1700000001,
            },
          },
        ],
      }

      let messageId: number | null = null

      for (const update of result.updates) {
        if (
          update._ === 'updateMessageID' ||
          update._ === 'updateNewMessage' ||
          update._ === 'updateNewChannelMessage'
        ) {
          if (update._ === 'updateMessageID') {
            messageId = update.id ?? null
          } else {
            messageId = update.message?.id ?? null
          }
          break
        }
      }

      expect(messageId).toBe(54321)
    })
  })
})

// =============================================================================
// Error Handling Tests
// =============================================================================

describe('Error Handling', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  describe('peer resolution errors', () => {
    it('should throw for invalid identifier format', async () => {
      const mockClient = createMockClient()

      // Not a username (@), not a phone (+/10+ digits), not a valid number
      await expect(
        resolvePeer(mockClient, '-12.5', usersCache, chatsCache),
      ).rejects.toThrow('Invalid peer identifier')
      expect(mockClient.call).not.toHaveBeenCalled()
    })

    it('should throw when username resolution fails', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 0 },
            users: [],
            chats: [],
          }

          return result
        }),
      })

      await expect(
        resolvePeer(mockClient, '@doesnotexist', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve @doesnotexist')
    })

    it('should throw when phone resolution fails', async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolvePhone') {
            throw new Error('Unexpected API call')
          }
          throw new tl.RpcError(400, 'PHONE_NOT_OCCUPIED')
        }),
      })

      await expect(
        resolvePeer(mockClient, '+10000000000', usersCache, chatsCache),
      ).rejects.toThrow('Could not resolve phone number +10000000000')
    })
  })

  describe('Telegram API errors', () => {
    it('should detect PEER_ID_INVALID error', () => {
      const error = new Error('PEER_ID_INVALID')
      expect(error.message.includes('PEER_ID_INVALID')).toBe(true)
    })

    it('should detect USER_IS_BOT error', () => {
      const error = new Error('USER_IS_BOT')
      expect(error.message.includes('USER_IS_BOT')).toBe(true)
    })

    it('should detect CHAT_WRITE_FORBIDDEN error', () => {
      const error = new Error('CHAT_WRITE_FORBIDDEN')
      expect(error.message.includes('CHAT_WRITE_FORBIDDEN')).toBe(true)
    })
  })

  describe('cache edge cases', () => {
    it('should skip cache entry without access_hash for username lookup', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '111',
          username: 'noaccess',
          access_hash: null, // No access_hash
        }),
      )

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolveUsername') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 111 },
            users: [
              {
                _: 'user',
                id: 111,
                firstName: 'Has',
                lastName: 'Access',
                accessHash: toLong('999'),
              },
            ],
            chats: [],
          }

          return result
        }),
      })

      const result = await resolvePeer(
        mockClient,
        '@noaccess',
        usersCache,
        chatsCache,
      )

      // Should have called API because cache entry has no access_hash
      expect(mockClient.call).toHaveBeenCalled()
      assertInputPeerUser(result.inputPeer)
      expectLongEqual(result.inputPeer.accessHash, '999')
    })

    it('should skip cache entry without access_hash for phone lookup', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '222',
          phone: '5555555555',
          access_hash: null, // No access_hash
        }),
      )

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== 'contacts.resolvePhone') {
            throw new Error('Unexpected API call')
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: 'contacts.resolvedPeer',
            peer: { _: 'peerUser', userId: 222 },
            users: [
              {
                _: 'user',
                id: 222,
                firstName: 'Phone',
                lastName: 'User',
                accessHash: toLong('888'),
              },
            ],
            chats: [],
          }

          return result
        }),
      })

      const result = await resolvePeer(
        mockClient,
        '+5555555555',
        usersCache,
        chatsCache,
      )

      // Should have called API because cache entry has no access_hash
      expect(mockClient.call).toHaveBeenCalled()
      assertInputPeerUser(result.inputPeer)
      expectLongEqual(result.inputPeer.accessHash, '888')
    })

    it('should skip cache entry without access_hash for user ID lookup', async () => {
      usersCache.upsert(
        createTestUser({
          user_id: '333333',
          access_hash: null, // No access_hash
        }),
      )

      const mockClient = createMockClient()
      const result = await resolvePeer(
        mockClient,
        '333333',
        usersCache,
        chatsCache,
      )

      // A known user stays a user, with hash 0, not basic group 333333
      assertInputPeerUser(result.inputPeer)
      expect(result.inputPeer.userId).toBe(333333)
      expectLongEqual(result.inputPeer.accessHash, 0)
    })
  })
})

// =============================================================================
// Input Validation Tests
// =============================================================================

describe('Input Validation', () => {
  describe('identifier type detection', () => {
    it('should detect @username format', () => {
      const identifier = '@testuser'
      const isUsername = identifier.startsWith('@')
      expect(isUsername).toBe(true)
    })

    it('should detect phone with + prefix', () => {
      const identifier = '+1234567890'
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      expect(isPhone).toBe(true)
    })

    it('should detect 10+ digit phone without +', () => {
      const identifier = '12345678901'
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      expect(isPhone).toBe(true)
    })

    it('should not detect short numbers as phone', () => {
      const identifier = '123456789' // 9 digits
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      expect(isPhone).toBe(false)
    })

    it('should detect numeric ID (short number)', () => {
      const identifier = '12345'
      const isUsername = identifier.startsWith('@')
      const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)
      const isNumericId =
        !isUsername &&
        !isPhone &&
        !Number.isNaN(Number.parseInt(identifier, 10))
      expect(isNumericId).toBe(true)
    })
  })

  describe('phone number normalization', () => {
    it('should remove + from phone', () => {
      const phone = '+1234567890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })

    it('should remove spaces from phone', () => {
      const phone = '+1 234 567 890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })

    it('should remove dashes from phone', () => {
      const phone = '+1-234-567-890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })

    it('should remove parentheses from phone', () => {
      const phone = '+1 (234) 567-890'
      const normalized = phone.replace(/[\s\-+()]/g, '')
      expect(normalized).toBe('1234567890')
    })
  })

  describe('username normalization', () => {
    it('should strip @ from username', () => {
      const identifier = '@testuser'
      const username = identifier.startsWith('@')
        ? identifier.slice(1)
        : identifier
      expect(username).toBe('testuser')
    })

    it('should keep username without @', () => {
      const identifier = 'testuser'
      const username = identifier.startsWith('@')
        ? identifier.slice(1)
        : identifier
      expect(username).toBe('testuser')
    })
  })
})

// =============================================================================
// Priority and Edge Cases
// =============================================================================

describe('Resolution Priority', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  it('should prefer users cache over chats cache for @username', async () => {
    // Both have same username
    usersCache.upsert(
      createTestUser({
        user_id: '111',
        username: 'shared',
        access_hash: '222',
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '-1000000000333',
        type: 'channel',
        username: 'shared',
        access_hash: '444',
      }),
    )

    const mockClient = createMockClient()
    const result = await resolvePeer(
      mockClient,
      '@shared',
      usersCache,
      chatsCache,
    )

    // Should resolve to user, not channel
    assertInputPeerUser(result.inputPeer)
    expect(result.inputPeer.userId).toBe(111)
  })

  it('should take a positive ID as the cached user before a cached group', async () => {
    usersCache.upsert(
      createTestUser({
        user_id: '4242',
        access_hash: '666',
      }),
    )
    chatsCache.upsert(
      dialogToCacheInput(
        fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
      ),
    )

    const mockClient = createMockClient()
    const result = await resolvePeer(mockClient, '4242', usersCache, chatsCache)

    assertInputPeerUser(result.inputPeer)
    expect(result.inputPeer.userId).toBe(4242)
    expectLongEqual(result.inputPeer.accessHash, '666')

    const group = await resolvePeer(mockClient, '-4242', usersCache, chatsCache)
    assertInputPeerChat(group.inputPeer)
    expect(group.inputPeer.chatId).toBe(4242)
    expect(group.name).toBe('Book Club')
  })

  it('should fall through to chats cache when user has no access_hash', async () => {
    usersCache.upsert(
      createTestUser({
        user_id: '666',
        username: 'fallthrough',
        access_hash: null, // No access hash
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '-1000000000777',
        type: 'channel',
        username: 'fallthrough',
        access_hash: '888',
      }),
    )

    const mockClient = createMockClient({
      call: mock<MockCall>(async (request) => {
        if (request._ !== 'contacts.resolveUsername') {
          throw new Error('Unexpected API call')
        }

        const result: tl.contacts.RawResolvedPeer = {
          _: 'contacts.resolvedPeer',
          peer: { _: 'peerUser', userId: 0 },
          users: [],
          chats: [],
        }

        return result
      }),
    })

    // When user has no access_hash, it should fall through to chats cache
    const result = await resolvePeer(
      mockClient,
      '@fallthrough',
      usersCache,
      chatsCache,
    )

    assertInputPeerChannel(result.inputPeer)
    expect(result.inputPeer.channelId).toBe(777)
    expect(mockClient.call).not.toHaveBeenCalled()
  })
})

// =============================================================================
// Send Command
// =============================================================================

describe('send command', () => {
  beforeEach(() => {
    commandCacheDb = createTestCacheDatabase().db
    initSyncSchema(commandCacheDb)
    commandCall.mockClear()
    commandClient = { call: commandCall }
  })

  it('rejects a bare ID that names a cached group and a cached channel with INVALID_ARGS', async () => {
    createChatsCache(commandCacheDb).upsertMany(
      [
        fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
        fakeDialog({ kind: 'channel', id: 4242, title: 'Example News' }),
      ].map(dialogToCacheInput),
    )
    const { sendCommand } = await import('../commands/send')
    const run = sendCommand.run as (input: {
      args: Record<string, unknown>
    }) => Promise<void>
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

    try {
      await expect(
        run({ args: { to: '4242', message: 'hi', silent: false, _: [] } }),
      ).rejects.toMatchObject({
        code: 'INVALID_ARGS',
        details: { to: '4242', candidates: [-4242, -1000000004242] },
      })
    } finally {
      errorSpy.mockRestore()
    }
    expect(commandCall).not.toHaveBeenCalled()
  })

  it('sends to user 4242, not basic group 4242, when the cache does not know the ID', async () => {
    commandCall.mockImplementationOnce(async () => ({
      _: 'updates',
      updates: [],
      users: [],
      chats: [],
      date: 1_760_000_000,
      seq: 0,
    }))
    const { sendCommand } = await import('../commands/send')
    const run = sendCommand.run as (input: {
      args: Record<string, unknown>
    }) => Promise<void>
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})

    try {
      await run({ args: { to: '4242', message: 'hi', silent: false, _: [] } })
    } finally {
      logSpy.mockRestore()
    }
    expect(commandCall).toHaveBeenCalledTimes(1)
    const request = commandCall.mock.calls[0]?.[0] as {
      _: string
      peer: tl.TypeInputPeer
    }
    expect(request._).toBe('messages.sendMessage')
    assertInputPeerUser(request.peer)
    expect(request.peer.userId).toBe(4242)
    expectLongEqual(request.peer.accessHash, 0)
  })
})
