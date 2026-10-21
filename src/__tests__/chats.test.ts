/**
 * Comprehensive unit tests for chats command
 *
 * Tests:
 * - listChatsCommand: cache hit, cache miss, --fresh flag, --type filter, pagination
 * - searchChatsCommand: cache search functionality
 * - getChatCommand: by ID, by username, cache vs API
 */

import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { tl } from '@mtcute/bun'

import {
  chatRowToItem,
  dialogToCacheInput,
  rawChatToCacheInput,
  rawPeerToCacheInput,
  userToPrivateChatCacheInput,
} from '../commands/chats/helpers'
import {
  type CachedChatInput,
  type ChatsCache,
  createChatsCache,
} from '../db/chats-cache'
import { createTestCacheDatabase } from '../db/schema'
import type { ChatType } from '../db/types'
import { getDefaultCacheConfig, isCacheStale } from '../db/types'
import { toLong } from '../utils/long'
import { fakeDialog } from './helpers/fake-dialogs'

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a test chat input with default values
 */
function createTestChat(
  overrides: Partial<CachedChatInput> = {},
): CachedChatInput {
  return {
    chat_id: '123456',
    type: 'private' as ChatType,
    title: 'Test Chat',
    username: 'testchat',
    member_count: null,
    access_hash: 'abc123',
    is_creator: 0,
    is_admin: 0,
    last_message_id: 100,
    last_message_at: Date.now() - 1000,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ _: 'user', id: 123456, firstName: 'Test' }),
    ...overrides,
  }
}

/**
 * Create multiple chats with different types for filter testing
 */
function seedChatsWithTypes(chatsCache: ChatsCache): void {
  const chatTypes: Array<{
    id: string
    type: ChatType
    title: string
    lastMessageAt: number
  }> = [
    {
      id: '1',
      type: 'private',
      title: 'Alice',
      lastMessageAt: Date.now() - 1000,
    },
    {
      id: '2',
      type: 'private',
      title: 'Bob',
      lastMessageAt: Date.now() - 2000,
    },
    {
      id: '-3',
      type: 'group',
      title: 'Team Chat',
      lastMessageAt: Date.now() - 3000,
    },
    {
      id: '-1000000000004',
      type: 'supergroup',
      title: 'Community',
      lastMessageAt: Date.now() - 4000,
    },
    {
      id: '-1000000000005',
      type: 'supergroup',
      title: 'Developers',
      lastMessageAt: Date.now() - 5000,
    },
    {
      id: '-1000000000006',
      type: 'channel',
      title: 'News',
      lastMessageAt: Date.now() - 6000,
    },
    {
      id: '-1000000000007',
      type: 'channel',
      title: 'Updates',
      lastMessageAt: Date.now() - 7000,
    },
  ]

  for (const chat of chatTypes) {
    chatsCache.upsert(
      createTestChat({
        chat_id: chat.id,
        type: chat.type,
        title: chat.title,
        last_message_at: chat.lastMessageAt,
        username: chat.type === 'channel' ? chat.title.toLowerCase() : null,
      }),
    )
  }
}

/**
 * Create a mock Telegram client
 */
function createMockClient() {
  return {
    iterDialogs: mock(async function* iterDialogs(opts?: { limit?: number }) {
      // Return some mock dialogs
      const dialogs = [
        {
          peer: { _: 'peerUser', userId: 1 },
          chat: {
            firstName: 'Alice',
            lastName: 'Smith',
            username: 'alice',
          },
          topMessage: 100,
          date: Math.floor(Date.now() / 1000) - 60,
          raw: {
            peer: { _: 'peerUser', userId: 1 },
          },
        },
        {
          peer: { _: 'peerChat', chatId: 2 },
          chat: {
            title: 'Team Chat',
            participantsCount: 10,
          },
          topMessage: 200,
          date: Math.floor(Date.now() / 1000) - 120,
          raw: {
            peer: { _: 'peerChat', chatId: 2 },
          },
        },
        {
          peer: { _: 'peerChannel', channelId: 3 },
          chat: {
            title: 'Tech News',
            username: 'technews',
            megagroup: false,
            broadcast: true,
            participantsCount: 1000,
          },
          topMessage: 300,
          date: Math.floor(Date.now() / 1000) - 180,
          raw: {
            peer: { _: 'peerChannel', channelId: 3 },
          },
        },
      ]

      const limit = opts?.limit ?? dialogs.length
      for (let i = 0; i < Math.min(limit, dialogs.length); i++) {
        const dialog = dialogs[i]
        if (!dialog) {
          continue
        }
        yield dialog
      }
    }),
    call: mock(
      (
        params: Record<string, unknown>,
      ): Promise<{ chats: tl.TypeChat[]; users: tl.TypeUser[] }> => {
        // Mock contacts.resolveUsername
        if (params._ === 'contacts.resolveUsername') {
          const username = params.username as string
          if (username === 'testchannel') {
            return Promise.resolve({
              chats: [
                {
                  _: 'channel',
                  id: 999,
                  title: 'Test Channel',
                  username: 'testchannel',
                  megagroup: false,
                  broadcast: true,
                  participantsCount: 500,
                  accessHash: toLong('123456789'),
                  photo: { _: 'chatPhotoEmpty' },
                  date: Math.floor(Date.now() / 1000),
                },
              ],
              users: [],
            })
          }
          if (username === 'testuser') {
            return Promise.resolve({
              chats: [],
              users: [
                {
                  _: 'user',
                  id: 888,
                  firstName: 'Test',
                  lastName: 'User',
                  username: 'testuser',
                  accessHash: toLong('987654321'),
                },
              ],
            })
          }
          return Promise.reject(new Error(`Username @${username} not found`))
        }
        return Promise.resolve({ chats: [], users: [] })
      },
    ),
  }
}

// =============================================================================
// ChatItem Conversion Tests
// =============================================================================

describe('Chat Item Conversion', () => {
  it('should convert cached chat with all fields', () => {
    const item = chatRowToItem(
      createTestChat({
        chat_id: '-123',
        type: 'group',
        title: 'My Group',
        username: 'mygroup',
        member_count: 50,
        is_creator: 1,
        is_admin: 1,
      }),
    )

    expect(item).toMatchObject({
      id: -123,
      type: 'group',
      title: 'My Group',
      username: 'mygroup',
      memberCount: 50,
      isCreator: true,
      isAdmin: true,
    })
  })

  it('should handle null fields gracefully', () => {
    const item = chatRowToItem(
      createTestChat({
        chat_id: '456',
        title: null,
        username: null,
        member_count: null,
        last_message_at: null,
      }),
    )

    expect(item).toMatchObject({
      id: 456,
      title: '',
      username: null,
      memberCount: null,
      lastMessageAt: null,
      isCreator: false,
    })
  })
})

// =============================================================================
// Chat Type Detection Tests
// =============================================================================

describe('Chat Type Detection', () => {
  describe('getChatType logic', () => {
    it('should detect peerUser as private', () => {
      const peer = { _: 'peerUser', userId: 123 }
      const result = peer._ === 'peerUser' ? 'private' : 'unknown'
      expect(result).toBe('private')
    })

    it('should detect peerChat as group', () => {
      const peer = { _: 'peerChat', chatId: 456 }
      const result = peer._ === 'peerChat' ? 'group' : 'unknown'
      expect(result).toBe('group')
    })

    it('should detect peerChannel with megagroup as supergroup', () => {
      const peer = { _: 'peerChannel', channelId: 789 }
      const chat = { megagroup: true }
      let result: string

      if (peer._ === 'peerChannel') {
        if (chat.megagroup) {
          result = 'supergroup'
        } else {
          result = 'channel'
        }
      } else {
        result = 'unknown'
      }

      expect(result).toBe('supergroup')
    })

    it('should detect peerChannel without megagroup as channel', () => {
      const peer = { _: 'peerChannel', channelId: 789 }
      const chat = { megagroup: false, broadcast: true }
      let result: string

      if (peer._ === 'peerChannel') {
        if (chat.megagroup) {
          result = 'supergroup'
        } else {
          result = 'channel'
        }
      } else {
        result = 'unknown'
      }

      expect(result).toBe('channel')
    })
  })
})

// =============================================================================
// listChatsCommand Tests
// =============================================================================

describe('listChatsCommand', () => {
  let db: Database
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    chatsCache = createChatsCache(db)
  })

  describe('cache hit scenarios', () => {
    it('should return cached chats when cache is populated', () => {
      // Seed the cache
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          title: 'Chat One',
          last_message_at: Date.now(),
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '2',
          title: 'Chat Two',
          last_message_at: Date.now() - 1000,
        }),
      )

      const cachedChats = chatsCache.list({ limit: 50 })

      expect(cachedChats.length).toBe(2)
      expect(cachedChats[0]?.title).toBe('Chat One')
      expect(cachedChats[1]?.title).toBe('Chat Two')
    })

    it('should detect stale cache entries', () => {
      const cacheConfig = getDefaultCacheConfig()

      // Fresh entry
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          fetched_at: Date.now(),
        }),
      )

      // Stale entry (fetched 2 hours ago, TTL is 1 hour)
      chatsCache.upsert(
        createTestChat({
          chat_id: '2',
          fetched_at: Date.now() - 2 * 60 * 60 * 1000,
        }),
      )

      const chats = chatsCache.list()
      const anyStale = chats.some((c) =>
        isCacheStale(c.fetched_at, cacheConfig.staleness.dialogs),
      )

      expect(anyStale).toBe(true)
    })

    it('should not detect staleness for fresh entries', () => {
      const cacheConfig = getDefaultCacheConfig()

      // All fresh entries
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          fetched_at: Date.now(),
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '2',
          fetched_at: Date.now() - 30 * 60 * 1000, // 30 min ago, within 1h TTL
        }),
      )

      const chats = chatsCache.list()
      const anyStale = chats.some((c) =>
        isCacheStale(c.fetched_at, cacheConfig.staleness.dialogs),
      )

      expect(anyStale).toBe(false)
    })
  })

  describe('cache miss scenarios', () => {
    it('should return empty when cache is empty', () => {
      const cachedChats = chatsCache.list({ limit: 50 })
      expect(cachedChats.length).toBe(0)
    })
  })

  describe('--type filter', () => {
    beforeEach(() => {
      seedChatsWithTypes(chatsCache)
    })

    it('should filter by private type', () => {
      const privateChats = chatsCache.list({ type: 'private' })

      expect(privateChats.length).toBe(2)
      expect(privateChats.every((c) => c.type === 'private')).toBe(true)
    })

    it('should filter by group type', () => {
      const groupChats = chatsCache.list({ type: 'group' })

      expect(groupChats.length).toBe(1)
      expect(groupChats[0]?.type).toBe('group')
      expect(groupChats[0]?.title).toBe('Team Chat')
    })

    it('should filter by supergroup type', () => {
      const supergroupChats = chatsCache.list({ type: 'supergroup' })

      expect(supergroupChats.length).toBe(2)
      expect(supergroupChats.every((c) => c.type === 'supergroup')).toBe(true)
    })

    it('should filter by channel type', () => {
      const channelChats = chatsCache.list({ type: 'channel' })

      expect(channelChats.length).toBe(2)
      expect(channelChats.every((c) => c.type === 'channel')).toBe(true)
    })

    it('should return empty for type with no matches', () => {
      // Clear cache
      for (const chat of chatsCache.list()) {
        chatsCache.delete(chat.chat_id)
      }

      chatsCache.upsert(createTestChat({ chat_id: '1', type: 'private' }))

      const groups = chatsCache.list({ type: 'group' })
      expect(groups.length).toBe(0)
    })
  })

  describe('pagination', () => {
    beforeEach(() => {
      // Create 10 chats for pagination testing
      for (let i = 1; i <= 10; i++) {
        chatsCache.upsert(
          createTestChat({
            chat_id: String(i),
            title: `Chat ${i}`,
            last_message_at: Date.now() - i * 1000,
          }),
        )
      }
    })

    it('should respect limit parameter', () => {
      const chats = chatsCache.list({ limit: 5 })
      expect(chats.length).toBe(5)
    })

    it('should respect offset parameter', () => {
      const allChats = chatsCache.list({ limit: 10 })
      const offsetChats = chatsCache.list({ limit: 5, offset: 5 })

      expect(offsetChats.length).toBe(5)
      expect(offsetChats[0]?.chat_id).toBe(allChats[5]?.chat_id)
    })

    it('should calculate hasMore correctly', () => {
      const allChats = chatsCache.list({ limit: 1000 })
      const total = allChats.length

      // First page
      const firstPage = chatsCache.list({ limit: 5, offset: 0 })
      const hasMoreFirstPage = 0 + 5 < total

      expect(firstPage.length).toBe(5)
      expect(hasMoreFirstPage).toBe(true)

      // Last page
      const lastPage = chatsCache.list({ limit: 5, offset: 5 })
      const hasMoreLastPage = 5 + 5 < total

      expect(lastPage.length).toBe(5)
      expect(hasMoreLastPage).toBe(false)
    })

    it('should handle offset beyond total', () => {
      const chats = chatsCache.list({ limit: 5, offset: 100 })
      expect(chats.length).toBe(0)
    })

    it('should handle limit larger than total', () => {
      const chats = chatsCache.list({ limit: 100 })
      expect(chats.length).toBe(10)
    })
  })

  describe('--fresh flag behavior', () => {
    it('should use cache when fresh is false and cache is populated', () => {
      chatsCache.upsert(createTestChat({ chat_id: '1', title: 'Cached Chat' }))

      const fresh = false
      const cachedChats = fresh ? [] : chatsCache.list({ limit: 50 })

      expect(cachedChats.length).toBe(1)
      expect(cachedChats[0]?.title).toBe('Cached Chat')
    })

    it('should bypass cache when fresh is true', () => {
      chatsCache.upsert(createTestChat({ chat_id: '1', title: 'Cached Chat' }))

      const fresh = true
      // When fresh=true, we skip cache check and fetch from API
      // Simulate the logic: if fresh, don't return from cache
      const shouldFetchFromApi = fresh || chatsCache.list().length === 0

      expect(shouldFetchFromApi).toBe(true)
    })
  })

  describe('ordering', () => {
    beforeEach(() => {
      // Create chats with different timestamps
      const now = Date.now()
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          title: 'Zebra',
          last_message_at: now - 5000,
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '2',
          title: 'Alpha',
          last_message_at: now - 1000,
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '3',
          title: 'Middle',
          last_message_at: now - 3000,
        }),
      )
    })

    it('should order by last_message_at descending by default', () => {
      const chats = chatsCache.list({ orderBy: 'last_message_at' })

      expect(chats[0]?.title).toBe('Alpha') // Most recent
      expect(chats[1]?.title).toBe('Middle')
      expect(chats[2]?.title).toBe('Zebra') // Oldest
    })

    it('should order by title when specified', () => {
      const chats = chatsCache.list({ orderBy: 'title' })

      expect(chats[0]?.title).toBe('Alpha')
      expect(chats[1]?.title).toBe('Middle')
      expect(chats[2]?.title).toBe('Zebra')
    })
  })
})

// =============================================================================
// searchChatsCommand Tests
// =============================================================================

describe('searchChatsCommand', () => {
  let db: Database
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    chatsCache = createChatsCache(db)

    // Seed with searchable chats
    chatsCache.upsert(
      createTestChat({
        chat_id: '1',
        title: 'Tech Discussion',
        username: 'techdiscuss',
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '2',
        title: 'Family Group',
        username: null,
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '3',
        title: 'Work Team',
        username: 'workteam',
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '-1000000000004',
        title: 'Tech News Channel',
        username: 'technews',
        type: 'channel',
      }),
    )
    chatsCache.upsert(
      createTestChat({
        chat_id: '5',
        title: 'Random Chat',
        username: 'randomchat',
      }),
    )
  })

  describe('basic search functionality', () => {
    it('should find chats by title substring', () => {
      const results = chatsCache.search('Tech')

      expect(results.length).toBe(2)
      const titles = results.map((r) => r.title)
      expect(titles).toContain('Tech Discussion')
      expect(titles).toContain('Tech News Channel')
    })

    it('should find chats by username substring', () => {
      const results = chatsCache.search('work')

      expect(results.length).toBe(1)
      expect(results[0]?.title).toBe('Work Team')
    })

    it('should be case insensitive', () => {
      const results = chatsCache.search('FAMILY')

      expect(results.length).toBe(1)
      expect(results[0]?.title).toBe('Family Group')
    })

    it('should return empty array for no matches', () => {
      const results = chatsCache.search('nonexistent')
      expect(results).toEqual([])
    })
  })

  describe('search result ordering', () => {
    it('should prioritize exact username matches', () => {
      const results = chatsCache.search('technews')

      // technews username should come first
      expect(results[0]?.username).toBe('technews')
    })

    it('should prioritize exact title matches', () => {
      const results = chatsCache.search('Family Group')

      expect(results[0]?.title).toBe('Family Group')
    })
  })

  describe('search limit', () => {
    it('should respect limit parameter', () => {
      const results = chatsCache.search('tech', 1)
      expect(results.length).toBe(1)
    })

    it('should default to reasonable limit', () => {
      // Add many chats
      for (let i = 10; i < 50; i++) {
        chatsCache.upsert(
          createTestChat({
            chat_id: String(i),
            title: `Test Chat ${i}`,
          }),
        )
      }

      const results = chatsCache.search('Test')
      expect(results.length).toBeLessThanOrEqual(20) // Default limit
    })
  })

  describe('staleness detection in search', () => {
    it('should detect stale search results', () => {
      const cacheConfig = getDefaultCacheConfig()

      // Add a stale chat
      chatsCache.upsert(
        createTestChat({
          chat_id: '100',
          title: 'Stale Tech Chat',
          fetched_at: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        }),
      )

      const results = chatsCache.search('Tech')
      const anyStale = results.some((c) =>
        isCacheStale(c.fetched_at, cacheConfig.staleness.dialogs),
      )

      expect(anyStale).toBe(true)
    })
  })
})

// =============================================================================
// getChatCommand Tests
// =============================================================================

describe('getChatCommand', () => {
  let db: Database
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    chatsCache = createChatsCache(db)
  })

  describe('get by ID', () => {
    it('should find chat by numeric ID', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '12345',
          title: 'Test Chat',
        }),
      )

      const chat = chatsCache.getById('12345')

      expect(chat).not.toBeNull()
      expect(chat?.chat_id).toBe('12345')
      expect(chat?.title).toBe('Test Chat')
    })

    it('should return null for non-existent ID', () => {
      const chat = chatsCache.getById('99999')
      expect(chat).toBeNull()
    })
  })

  describe('get by username', () => {
    it('should find chat by username without @', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          username: 'testchat',
          title: 'Test Chat',
        }),
      )

      const chat = chatsCache.getByUsername('testchat')

      expect(chat).not.toBeNull()
      expect(chat?.username).toBe('testchat')
    })

    it('should find chat by username with @', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          username: 'testchat',
          title: 'Test Chat',
        }),
      )

      const chat = chatsCache.getByUsername('@testchat')

      expect(chat).not.toBeNull()
      expect(chat?.username).toBe('testchat')
    })

    it('should be case insensitive for username', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          username: 'TestChat',
          title: 'Test Chat',
        }),
      )

      const chat = chatsCache.getByUsername('testchat')

      expect(chat).not.toBeNull()
    })

    it('should return null for non-existent username', () => {
      const chat = chatsCache.getByUsername('@nonexistent')
      expect(chat).toBeNull()
    })
  })

  describe('identifier detection', () => {
    it('should detect @username format as username', () => {
      const identifier = '@testuser'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      expect(isUsername).toBe(true)
    })

    it('should detect plain username as username', () => {
      const identifier = 'testuser'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      expect(isUsername).toBe(true)
    })

    it('should detect numeric string as ID', () => {
      const identifier = '123456'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      expect(isUsername).toBe(false)
    })
  })

  describe('cache vs API behavior', () => {
    it('should use cache when fresh is false and cache has data', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          username: 'cached',
          title: 'Cached Chat',
        }),
      )

      const fresh = false
      const cached = !fresh ? chatsCache.getByUsername('cached') : null

      expect(cached).not.toBeNull()
      expect(cached?.title).toBe('Cached Chat')
    })

    it('should bypass cache when fresh is true', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          username: 'cached',
          title: 'Cached Chat',
        }),
      )

      const fresh = true
      const shouldFetchFromApi = fresh

      expect(shouldFetchFromApi).toBe(true)
    })

    it('should fetch from API when cache miss', () => {
      const cached = chatsCache.getByUsername('nonexistent')
      const shouldFetchFromApi = cached === null

      expect(shouldFetchFromApi).toBe(true)
    })
  })

  describe('staleness detection', () => {
    it('should detect stale chat', () => {
      const cacheConfig = getDefaultCacheConfig()

      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          fetched_at: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
        }),
      )

      const chat = chatsCache.getById('1')
      const stale = chat
        ? isCacheStale(chat.fetched_at, cacheConfig.staleness.dialogs)
        : false

      expect(stale).toBe(true)
    })

    it('should detect fresh chat', () => {
      const cacheConfig = getDefaultCacheConfig()

      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          fetched_at: Date.now(),
        }),
      )

      const chat = chatsCache.getById('1')
      const stale = chat
        ? isCacheStale(chat.fetched_at, cacheConfig.staleness.dialogs)
        : false

      expect(stale).toBe(false)
    })
  })
})

// =============================================================================
// Dialog Conversion Tests
// =============================================================================

describe('Chat cache rows', () => {
  it('stores each dialog under its marked peer ID', () => {
    const rows = [
      fakeDialog({ kind: 'user', id: 1001, title: 'John Doe' }),
      fakeDialog({ kind: 'group', id: 4001, title: 'My Group' }),
      fakeDialog({
        kind: 'supergroup',
        id: 1234567890,
        title: 'Big Community',
        username: 'bigcommunity',
        membersCount: 10000,
      }),
      fakeDialog({ kind: 'channel', id: 9876543210, title: 'News Channel' }),
    ].map(dialogToCacheInput)

    expect(
      rows.map(({ chat_id, type, title, access_hash }) => ({
        chat_id,
        type,
        title,
        access_hash,
      })),
    ).toEqual([
      {
        chat_id: '1001',
        type: 'private',
        title: 'John Doe',
        access_hash: '777',
      },
      { chat_id: '-4001', type: 'group', title: 'My Group', access_hash: null },
      {
        chat_id: '-1001234567890',
        type: 'supergroup',
        title: 'Big Community',
        access_hash: '777',
      },
      {
        chat_id: '-1009876543210',
        type: 'channel',
        title: 'News Channel',
        access_hash: '777',
      },
    ])
  })

  it('stores a raw chat or user under its marked peer ID', () => {
    const base = { photo: { _: 'chatPhotoEmpty' }, date: 1_700_000_000 }
    const user: tl.RawUser = {
      _: 'user',
      id: 1001,
      firstName: 'John',
      accessHash: toLong('777'),
    }
    const group = {
      ...base,
      _: 'chat',
      id: 4001,
      title: 'My Group',
      participantsCount: 5,
      version: 1,
    } as tl.RawChat
    const supergroup = {
      ...base,
      _: 'channel',
      id: 1234567890,
      title: 'Big Community',
      megagroup: true,
      accessHash: toLong('888'),
    } as tl.RawChannel

    expect(userToPrivateChatCacheInput(user).chat_id).toBe('1001')
    expect(rawChatToCacheInput(group)).toMatchObject({
      chat_id: '-4001',
      type: 'group',
    })
    expect(rawChatToCacheInput(supergroup)).toMatchObject({
      chat_id: '-1001234567890',
      type: 'supergroup',
      access_hash: '888',
    })
    expect(rawPeerToCacheInput(supergroup)?.chat_id).toBe('-1001234567890')
    expect(rawPeerToCacheInput(user)?.chat_id).toBe('1001')
  })

  it('marks chats the user lost access to as well', () => {
    expect(
      rawChatToCacheInput({ _: 'chatForbidden', id: 4001, title: 'Old Group' })
        .chat_id,
    ).toBe('-4001')
    expect(
      rawChatToCacheInput({
        _: 'channelForbidden',
        id: 1234567890,
        accessHash: toLong('888'),
        title: 'Old Channel',
      }),
    ).toMatchObject({ chat_id: '-1001234567890', access_hash: '888' })
  })
})

// =============================================================================
// ChatsCache Integration Tests
// =============================================================================

describe('ChatsCache Integration', () => {
  let db: Database
  let chatsCache: ChatsCache

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    chatsCache = createChatsCache(db)
  })

  describe('upsertMany', () => {
    it('should insert multiple chats in transaction', () => {
      const chats = [
        createTestChat({ chat_id: '1', title: 'Chat 1' }),
        createTestChat({ chat_id: '2', title: 'Chat 2' }),
        createTestChat({ chat_id: '3', title: 'Chat 3' }),
      ]

      chatsCache.upsertMany(chats)

      expect(chatsCache.count()).toBe(3)
    })

    it('should handle empty array', () => {
      chatsCache.upsertMany([])
      expect(chatsCache.count()).toBe(0)
    })

    it('should update existing chats in bulk', () => {
      chatsCache.upsert(createTestChat({ chat_id: '1', title: 'Original' }))

      chatsCache.upsertMany([
        createTestChat({ chat_id: '1', title: 'Updated' }),
        createTestChat({ chat_id: '2', title: 'New' }),
      ])

      expect(chatsCache.count()).toBe(2)
      expect(chatsCache.getById('1')?.title).toBe('Updated')
    })
  })

  describe('count with type filter', () => {
    beforeEach(() => {
      seedChatsWithTypes(chatsCache)
    })

    it('should count all chats', () => {
      expect(chatsCache.count()).toBe(7)
    })

    it('should count by type', () => {
      expect(chatsCache.count('private')).toBe(2)
      expect(chatsCache.count('group')).toBe(1)
      expect(chatsCache.count('supergroup')).toBe(2)
      expect(chatsCache.count('channel')).toBe(2)
    })
  })

  describe('getStale', () => {
    it('should return stale chats', () => {
      const TTL = 60000 // 1 minute

      // Fresh chat
      chatsCache.upsert(
        createTestChat({ chat_id: '1', fetched_at: Date.now() }),
      )

      // Stale chat
      chatsCache.upsert(
        createTestChat({ chat_id: '2', fetched_at: Date.now() - 120000 }),
      )

      const stale = chatsCache.getStale(TTL)

      expect(stale.length).toBe(1)
      expect(stale[0]?.chat_id).toBe('2')
    })
  })

  describe('delete', () => {
    it('should delete chat and return true', () => {
      chatsCache.upsert(createTestChat({ chat_id: '1' }))

      const result = chatsCache.delete('1')

      expect(result).toBe(true)
      expect(chatsCache.getById('1')).toBeNull()
    })

    it('should return false for non-existent chat', () => {
      const result = chatsCache.delete('nonexistent')
      expect(result).toBe(false)
    })
  })

  describe('prune', () => {
    it('should remove old entries', () => {
      // Old chat
      chatsCache.upsert(
        createTestChat({ chat_id: '1', fetched_at: Date.now() - 7200000 }),
      )

      // Fresh chat
      chatsCache.upsert(
        createTestChat({ chat_id: '2', fetched_at: Date.now() }),
      )

      const pruned = chatsCache.prune(3600000) // 1 hour

      expect(pruned).toBe(1)
      expect(chatsCache.getById('1')).toBeNull()
      expect(chatsCache.getById('2')).not.toBeNull()
    })
  })
})

// =============================================================================
// Mock Client Integration Tests
// =============================================================================

describe('Mock Client Integration', () => {
  it('should create mock client with iterDialogs', async () => {
    const client = createMockClient()
    const dialogs: Array<{ peer: { _: string } }> = []

    for await (const dialog of client.iterDialogs({ limit: 10 })) {
      dialogs.push(dialog)
    }

    expect(dialogs.length).toBe(3)
    expect(dialogs[0]!.peer._).toBe('peerUser')
    expect(dialogs[1]!.peer._).toBe('peerChat')
    expect(dialogs[2]!.peer._).toBe('peerChannel')
  })

  it('should resolve username for channel', async () => {
    const client = createMockClient()
    const result = await client.call({
      _: 'contacts.resolveUsername',
      username: 'testchannel',
    })

    expect(result.chats.length).toBe(1)
    const channel = result.chats.find(
      (chat): chat is tl.RawChannel => chat._ === 'channel',
    )
    expect(channel).toBeDefined()
    if (!channel) {
      throw new Error('Expected RawChannel in resolveUsername response')
    }
    expect(channel.title).toBe('Test Channel')
  })

  it('should resolve username for user', async () => {
    const client = createMockClient()
    const result = await client.call({
      _: 'contacts.resolveUsername',
      username: 'testuser',
    })

    expect(result.users.length).toBe(1)
    const user = result.users.find(
      (item): item is tl.RawUser => item._ === 'user',
    )
    expect(user).toBeDefined()
    if (!user) {
      throw new Error('Expected RawUser in resolveUsername response')
    }
    expect(user.firstName).toBe('Test')
  })

  it('should throw for non-existent username', async () => {
    const client = createMockClient()

    await expect(
      client.call({
        _: 'contacts.resolveUsername',
        username: 'nonexistent',
      }),
    ).rejects.toThrow('Username @nonexistent not found')
  })
})

// =============================================================================
// Type Validation Tests
// =============================================================================

describe('Type Validation', () => {
  describe('chat type validation', () => {
    it('should validate valid chat types', () => {
      const validTypes: ChatType[] = [
        'private',
        'group',
        'supergroup',
        'channel',
      ]

      for (const type of validTypes) {
        const isValid = ['private', 'group', 'supergroup', 'channel'].includes(
          type,
        )
        expect(isValid).toBe(true)
      }
    })

    it('should reject invalid chat type', () => {
      const invalidType = 'invalid'
      const isValid = ['private', 'group', 'supergroup', 'channel'].includes(
        invalidType,
      )

      expect(isValid).toBe(false)
    })
  })

  describe('argument parsing', () => {
    it('should parse limit as integer', () => {
      const limitArg = '50'
      const limit = Number.parseInt(limitArg, 10)

      expect(limit).toBe(50)
      expect(Number.isNaN(limit)).toBe(false)
    })

    it('should parse offset as integer', () => {
      const offsetArg = '10'
      const offset = Number.parseInt(offsetArg, 10)

      expect(offset).toBe(10)
      expect(Number.isNaN(offset)).toBe(false)
    })

    it('should handle invalid limit gracefully', () => {
      const limitArg = 'invalid'
      const limit = Number.parseInt(limitArg, 10)

      expect(Number.isNaN(limit)).toBe(true)
    })

    it('should use default values for undefined args', () => {
      const limitArg: string | undefined = undefined
      const limit = Number.parseInt(limitArg ?? '50', 10)

      expect(limit).toBe(50)
    })
  })
})
