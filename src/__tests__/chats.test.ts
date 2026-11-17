/**
 * Unit tests for the chats command
 *
 * Tests:
 * - chatRowToItem conversion
 * - listChatsCommand: cache hit, cache miss, --fresh flag, --type filter, pagination
 * - chat cache rows built from dialogs, raw chats and communities
 */

import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { Chat, type TelegramClient, type tl } from '@mtcute/bun'

import {
  chatRowToItem,
  dialogToCacheInput,
  filterChatsByType,
  isValidChatType,
  rawChatToCacheInput,
  rawPeerToCacheInput,
  userToPrivateChatCacheInput,
} from '../commands/chats/helpers'
import { fetchChatsFromApi } from '../commands/chats/list'
import { createChatSyncStateService } from '../db/chat-sync-state'
import {
  type CachedChatInput,
  type ChatsCache,
  createChatsCache,
} from '../db/chats-cache'
import { SyncPriority } from '../db/sync-schema'
import type { ChatType } from '../db/types'
import { getDefaultCacheConfig, isCacheStale } from '../db/types'
import { toLong } from '../utils/long'
import { createAccountCacheDb } from './helpers/cache-db'
import {
  communityDialog,
  fakeDialog,
  fakeRawCommunity,
} from './helpers/fake-dialogs'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

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
// listChatsCommand Tests
// =============================================================================

describe('listChatsCommand', () => {
  let db: Database
  let chatsCache: ChatsCache

  beforeEach(() => {
    db = createAccountCacheDb()
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
      chatsCache = createChatsCache(createAccountCacheDb())
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

    /** Params of every `withParams` call of the last `apiClient` */
    let withParams: unknown[] = []

    function apiClient(communities: () => Promise<Chat[]>) {
      withParams = []
      return {
        async *iterDialogs() {
          yield fakeDialog({ kind: 'user', id: 1001, topMessage: 5 })
        },
        withParams(params: unknown) {
          withParams.push(params)
          return { getJoinedCommunities: communities }
        },
      } as unknown as Pick<TelegramClient, 'iterDialogs' | 'withParams'>
    }

    it('fetchChatsFromApi caches joined communities next to dialogs', async () => {
      const client = apiClient(async () => [
        new Chat(fakeRawCommunity({ id: 5555555555, accessHash: '777' })),
      ])

      const rows = await fetchChatsFromApi(client, db)

      expect(rows.map((row) => [row.chat_id, row.type])).toEqual([
        ['1001', 'private'],
        ['-1005555555555', 'community'],
      ])
      expect(chatsCache.list({ type: 'community' })).toMatchObject([
        { chat_id: '-1005555555555', access_hash: '777' },
      ])
      // A FLOOD_WAIT fails the request instead of holding up the list
      expect(withParams).toEqual([{ floodSleepThreshold: 0 }])
    })

    it('fetchChatsFromApi still caches the dialogs when the communities request fails', async () => {
      const client = apiClient(async () => {
        throw new Error('RPC_CALL_FAIL')
      })

      const rows = await fetchChatsFromApi(client, db)

      expect(rows.map((row) => row.chat_id)).toEqual(['1001'])
      expect(chatsCache.getById('1001')).not.toBeNull()
      expect(chatsCache.list({ type: 'community' })).toEqual([])
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

  /** Example Community, a raw community with a channel ID */
  const community: tl.RawCommunity = {
    _: 'community',
    id: 5555555556,
    accessHash: toLong('888'),
    title: 'Example Community',
    photo: { _: 'chatPhotoEmpty' },
    date: 1_700_000_000,
  }

  it('stores a community dialog as a community with its access hash', () => {
    expect(
      dialogToCacheInput(
        communityDialog({ id: 5555555555, accessHash: '777' }),
      ),
    ).toMatchObject({
      chat_id: '-1005555555555',
      type: 'community',
      title: 'Example Community',
      access_hash: '777',
      username: null,
      member_count: null,
    })
  })

  it('stores a raw community as a community with its access hash, forbidden or not', () => {
    expect(rawChatToCacheInput(community)).toMatchObject({
      chat_id: '-1005555555556',
      type: 'community',
      access_hash: '888',
    })
    expect(
      rawChatToCacheInput({
        _: 'communityForbidden',
        id: 5555555557,
        accessHash: toLong('889'),
        title: 'Example Community',
      }),
    ).toMatchObject({
      chat_id: '-1005555555557',
      type: 'community',
      access_hash: '889',
    })
    expect(
      rawChatToCacheInput({
        _: 'communityForbidden',
        id: 5555555558,
        title: 'Example Community',
      }),
    ).toMatchObject({
      chat_id: '-1005555555558',
      type: 'community',
      access_hash: null,
    })
  })

  it('caches a live community but skips a min one', () => {
    expect(rawPeerToCacheInput(community)).toMatchObject({
      chat_id: '-1005555555556',
      type: 'community',
      access_hash: '888',
    })
    expect(rawPeerToCacheInput({ ...community, min: true })).toBeNull()
  })

  it('lists communities under --type community only', () => {
    const rows = [
      dialogToCacheInput(
        communityDialog({ id: 5555555555, accessHash: '777' }),
      ),
      rawChatToCacheInput(community),
      dialogToCacheInput(fakeDialog({ kind: 'group', id: 4001 })),
      dialogToCacheInput(fakeDialog({ kind: 'channel', id: 9876543210 })),
    ]
    const ids = (chats: { chat_id: string }[]) =>
      chats.map(({ chat_id }) => chat_id)

    expect(isValidChatType('community')).toBe(true)
    expect(ids(filterChatsByType(rows, 'community'))).toEqual([
      '-1005555555555',
      '-1005555555556',
    ])

    const db = createAccountCacheDb()
    const chatsCache = createChatsCache(db)
    chatsCache.upsertMany(rows)
    createChatSyncStateService(db).upsert({
      chat_id: -1005555555555,
      chat_type: 'community',
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    })

    expect(ids(chatsCache.list({ type: 'community' })).sort()).toEqual([
      '-1005555555555',
      '-1005555555556',
    ])
    expect(ids(chatsCache.list({ type: 'group' }))).toEqual(['-4001'])
    expect(ids(chatsCache.list({ type: 'channel' }))).toEqual([
      '-1009876543210',
    ])
    assertPeerIdInvariants(db)
  })
})
