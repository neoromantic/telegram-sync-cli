/**
 * Comprehensive tests for the cache system
 *
 * Tests:
 * - Duration parsing (parseDuration)
 * - Staleness checking (isCacheStale)
 * - UsersCache operations
 * - ChatsCache operations
 */

import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'

import { ChatsCache, createChatsCache } from '../db/chats-cache'
import type { ChatType, DurationString } from '../db/types'
import { isCacheStale, parseDuration } from '../db/types'
import { createUsersCache, UsersCache } from '../db/users-cache'
import { createAccountCacheDb } from './helpers/cache-db'

// =============================================================================
// Duration Parsing Tests
// =============================================================================

describe('parseDuration', () => {
  describe('valid durations', () => {
    it('should parse seconds ("30s" -> 30000)', () => {
      expect(parseDuration('30s')).toBe(30000)
    })

    it('should parse minutes ("5m" -> 300000)', () => {
      expect(parseDuration('5m')).toBe(300000)
    })

    it('should parse hours ("1h" -> 3600000)', () => {
      expect(parseDuration('1h')).toBe(3600000)
    })

    it('should parse days ("7d" -> 604800000)', () => {
      expect(parseDuration('7d')).toBe(604800000)
    })

    it('should parse weeks ("2w" -> 1209600000)', () => {
      expect(parseDuration('2w')).toBe(1209600000)
    })

    it('should parse single unit values ("1s" -> 1000)', () => {
      expect(parseDuration('1s')).toBe(1000)
    })

    it('should parse large values ("365d")', () => {
      expect(parseDuration('365d')).toBe(365 * 24 * 60 * 60 * 1000)
    })

    it('should parse zero values ("0s" -> 0)', () => {
      expect(parseDuration('0s')).toBe(0)
    })
  })

  describe('invalid durations', () => {
    it('should throw for missing unit', () => {
      expect(() => parseDuration('30' as DurationString)).toThrow(
        'Invalid duration: 30',
      )
    })

    it('should throw for missing value', () => {
      expect(() => parseDuration('s' as DurationString)).toThrow(
        'Invalid duration: s',
      )
    })

    it('should throw for invalid unit', () => {
      expect(() => parseDuration('30x' as DurationString)).toThrow(
        'Invalid duration: 30x',
      )
    })

    it('should throw for negative values', () => {
      expect(() => parseDuration('-5m' as DurationString)).toThrow(
        'Invalid duration: -5m',
      )
    })

    it('should throw for floating point values', () => {
      expect(() => parseDuration('1.5h' as DurationString)).toThrow(
        'Invalid duration: 1.5h',
      )
    })

    it('should throw for empty string', () => {
      expect(() => parseDuration('' as DurationString)).toThrow(
        'Invalid duration: ',
      )
    })

    it('should throw for space in duration', () => {
      expect(() => parseDuration('30 s' as DurationString)).toThrow(
        'Invalid duration: 30 s',
      )
    })
  })
})

// =============================================================================
// Staleness Checking Tests
// =============================================================================

describe('isCacheStale', () => {
  const TTL_MS = 60000 // 1 minute

  describe('fresh data', () => {
    it('should return false for freshly fetched data', () => {
      const now = Date.now()
      expect(isCacheStale(now, TTL_MS)).toBe(false)
    })

    it('should return false for data fetched 30s ago (within 1min TTL)', () => {
      const fetchedAt = Date.now() - 30000 // 30 seconds ago
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(false)
    })

    it('should return false for data at 59s (just under TTL)', () => {
      const fetchedAt = Date.now() - 59000 // 59 seconds ago
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(false)
    })
  })

  describe('stale data', () => {
    it('should return true for data fetched beyond TTL', () => {
      const fetchedAt = Date.now() - 120000 // 2 minutes ago
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(true)
    })

    it('should return true for very old data', () => {
      const fetchedAt = Date.now() - 86400000 // 1 day ago
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(true)
    })

    it('should return true for data at 61s (just over TTL)', () => {
      const fetchedAt = Date.now() - 61000 // 61 seconds ago
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('should return true for null fetched_at', () => {
      expect(isCacheStale(null, TTL_MS)).toBe(true)
    })

    it('should handle zero TTL (always stale except exact moment)', () => {
      const now = Date.now()
      // Data from 1ms ago is stale with 0 TTL
      expect(isCacheStale(now - 1, 0)).toBe(true)
    })

    it('should handle very large TTL', () => {
      const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000
      const twoYearsTTL = 2 * 365 * 24 * 60 * 60 * 1000
      expect(isCacheStale(yearAgo, twoYearsTTL)).toBe(false)
    })

    it('should return true at exactly TTL boundary', () => {
      // At exactly TTL, Date.now() - fetchedAt === TTL, so > is false
      // But due to timing, we test slightly over
      const fetchedAt = Date.now() - TTL_MS - 1
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(true)
    })

    it('should return false at exactly TTL boundary minus 1ms', () => {
      const fetchedAt = Date.now() - TTL_MS + 1
      expect(isCacheStale(fetchedAt, TTL_MS)).toBe(false)
    })
  })
})

// =============================================================================
// UsersCache Tests
// =============================================================================

describe('UsersCache', () => {
  let db: Database
  let usersCache: UsersCache

  const createTestUser = (overrides = {}) => ({
    user_id: '123456',
    username: 'testuser',
    first_name: 'Test',
    last_name: 'User',
    phone: '1234567890',
    access_hash: 'abc123',
    is_contact: 1,
    is_bot: 0,
    is_premium: 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 123456, first_name: 'Test' }),
    ...overrides,
  })

  beforeEach(() => {
    db = createAccountCacheDb()
    usersCache = createUsersCache(db)
  })

  describe('upsert and getById', () => {
    it('should insert and retrieve user by ID', () => {
      const user = createTestUser()
      usersCache.upsert(user)

      const retrieved = usersCache.getById('123456')

      expect(retrieved).not.toBeNull()
      expect(retrieved?.user_id).toBe('123456')
      expect(retrieved?.username).toBe('testuser')
      expect(retrieved?.first_name).toBe('Test')
      expect(retrieved?.last_name).toBe('User')
    })

    it('should update existing user', () => {
      usersCache.upsert(createTestUser())
      usersCache.upsert(createTestUser({ first_name: 'Updated' }))

      const retrieved = usersCache.getById('123456')

      expect(retrieved?.first_name).toBe('Updated')
      expect(usersCache.count()).toBe(1)
    })

    it('should return null for non-existent user', () => {
      expect(usersCache.getById('nonexistent')).toBeNull()
    })

    it('should compute display_name from first and last name', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getById('123456')

      expect(retrieved?.display_name).toBe('Test User')
    })

    it('should handle user with only first name', () => {
      usersCache.upsert(createTestUser({ last_name: null }))

      const retrieved = usersCache.getById('123456')

      expect(retrieved?.display_name).toBe('Test')
    })

    it('should handle user with only last name', () => {
      usersCache.upsert(createTestUser({ first_name: null }))

      const retrieved = usersCache.getById('123456')

      expect(retrieved?.display_name).toBe('User')
    })

    it('should handle user with no names', () => {
      usersCache.upsert(createTestUser({ first_name: null, last_name: null }))

      const retrieved = usersCache.getById('123456')

      expect(retrieved?.display_name).toBeNull()
    })
  })

  describe('getByUsername', () => {
    it('should find user by username', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getByUsername('testuser')

      expect(retrieved).not.toBeNull()
      expect(retrieved?.user_id).toBe('123456')
    })

    it('should find user with @ prefix', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getByUsername('@testuser')

      expect(retrieved).not.toBeNull()
      expect(retrieved?.user_id).toBe('123456')
    })

    it('should be case insensitive', () => {
      usersCache.upsert(createTestUser())

      expect(usersCache.getByUsername('TESTUSER')).not.toBeNull()
      expect(usersCache.getByUsername('TestUser')).not.toBeNull()
    })

    it('should return null for non-existent username', () => {
      expect(usersCache.getByUsername('nonexistent')).toBeNull()
    })

    it('should handle user without username', () => {
      usersCache.upsert(createTestUser({ username: null }))

      expect(usersCache.getByUsername('testuser')).toBeNull()
    })
  })

  describe('getByPhone', () => {
    it('should find user by phone number', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getByPhone('1234567890')

      expect(retrieved).not.toBeNull()
      expect(retrieved?.user_id).toBe('123456')
    })

    it('should normalize phone number (remove +)', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getByPhone('+1234567890')

      expect(retrieved).not.toBeNull()
    })

    it('should normalize phone number (remove spaces)', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getByPhone('123 456 7890')

      expect(retrieved).not.toBeNull()
    })

    it('should normalize phone number (remove dashes and parentheses)', () => {
      usersCache.upsert(createTestUser())

      const retrieved = usersCache.getByPhone('(123) 456-7890')

      expect(retrieved).not.toBeNull()
    })

    it('should return null for non-existent phone', () => {
      expect(usersCache.getByPhone('9999999999')).toBeNull()
    })

    it('should return null for user without phone', () => {
      usersCache.upsert(createTestUser({ phone: null }))

      expect(usersCache.getByPhone('1234567890')).toBeNull()
    })
  })

  describe('search', () => {
    beforeEach(() => {
      usersCache.upsert(
        createTestUser({
          user_id: '1',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
        }),
      )
      usersCache.upsert(
        createTestUser({
          user_id: '2',
          username: 'bob',
          first_name: 'Bob',
          last_name: 'Jones',
        }),
      )
      usersCache.upsert(
        createTestUser({
          user_id: '3',
          username: 'charlie',
          first_name: 'Charlie',
          last_name: 'Brown',
        }),
      )
      usersCache.upsert(
        createTestUser({
          user_id: '4',
          username: null,
          first_name: 'David',
          last_name: 'Alice',
        }),
      )
    })

    it('should find users by username', () => {
      const results = usersCache.search('alice')

      expect(results.length).toBeGreaterThanOrEqual(1)
      expect(results.some((u) => u.username === 'alice')).toBe(true)
    })

    it('should find users by first name', () => {
      const results = usersCache.search('Bob')

      expect(results.length).toBe(1)
      expect(results[0]?.first_name).toBe('Bob')
    })

    it('should find users by last name', () => {
      const results = usersCache.search('Brown')

      expect(results.length).toBe(1)
      expect(results[0]?.last_name).toBe('Brown')
    })

    it('should find users by phone', () => {
      usersCache.upsert(createTestUser({ user_id: '5', phone: '5550001111' }))

      const results = usersCache.search('555000')

      expect(results.map((u) => u.user_id)).toEqual(['5'])
    })

    it('should find users by display name', () => {
      const results = usersCache.search('Alice Smith')

      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('should return empty array for no matches', () => {
      const results = usersCache.search('nonexistent')

      expect(results).toEqual([])
    })

    it('should respect limit parameter', () => {
      const results = usersCache.search('a', 2) // Alice, Charlie, David all have 'a'

      expect(results.length).toBeLessThanOrEqual(2)
    })

    it('should handle partial matches', () => {
      const results = usersCache.search('li') // Alice, Charlie

      expect(results.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('upsertMany', () => {
    it('should insert multiple users', () => {
      const users = [
        createTestUser({ user_id: '1', username: 'user1' }),
        createTestUser({ user_id: '2', username: 'user2' }),
        createTestUser({ user_id: '3', username: 'user3' }),
      ]

      usersCache.upsertMany(users)

      expect(usersCache.count()).toBe(3)
      expect(usersCache.getById('1')).not.toBeNull()
      expect(usersCache.getById('2')).not.toBeNull()
      expect(usersCache.getById('3')).not.toBeNull()
    })

    it('should handle empty array', () => {
      usersCache.upsertMany([])

      expect(usersCache.count()).toBe(0)
    })

    it('should update existing users in bulk', () => {
      usersCache.upsert(
        createTestUser({ user_id: '1', first_name: 'Original' }),
      )

      usersCache.upsertMany([
        createTestUser({ user_id: '1', first_name: 'Updated' }),
        createTestUser({ user_id: '2', first_name: 'New' }),
      ])

      expect(usersCache.count()).toBe(2)
      expect(usersCache.getById('1')?.first_name).toBe('Updated')
    })
  })

  describe('getAll', () => {
    beforeEach(() => {
      for (let i = 1; i <= 10; i++) {
        usersCache.upsert(
          createTestUser({ user_id: String(i), username: `user${i}` }),
        )
      }
    })

    it('should return all users with default pagination', () => {
      const users = usersCache.getAll()

      expect(users.length).toBe(10)
    })

    it('should respect limit parameter', () => {
      const users = usersCache.getAll({ limit: 5 })

      expect(users.length).toBe(5)
    })

    it('should respect offset parameter', () => {
      const users = usersCache.getAll({ limit: 5, offset: 5 })

      expect(users.length).toBe(5)
    })

    it('should handle offset beyond total', () => {
      const users = usersCache.getAll({ offset: 100 })

      expect(users.length).toBe(0)
    })
  })

  describe('count', () => {
    it('should return 0 for empty cache', () => {
      expect(usersCache.count()).toBe(0)
    })

    it('should return correct count', () => {
      usersCache.upsert(createTestUser({ user_id: '1' }))
      usersCache.upsert(createTestUser({ user_id: '2' }))
      usersCache.upsert(createTestUser({ user_id: '3' }))

      expect(usersCache.count()).toBe(3)
    })

    it('should not double count on upsert', () => {
      usersCache.upsert(createTestUser({ user_id: '1' }))
      usersCache.upsert(createTestUser({ user_id: '1', first_name: 'Updated' }))

      expect(usersCache.count()).toBe(1)
    })
  })

  describe('timestamps', () => {
    it('should set created_at and updated_at on insert', () => {
      const beforeInsert = Date.now()
      usersCache.upsert(createTestUser())
      const afterInsert = Date.now()

      const user = usersCache.getById('123456')

      expect(user?.created_at).toBeGreaterThanOrEqual(beforeInsert)
      expect(user?.created_at).toBeLessThanOrEqual(afterInsert)
      expect(user?.updated_at).toBeGreaterThanOrEqual(beforeInsert)
      expect(user?.updated_at).toBeLessThanOrEqual(afterInsert)
    })

    it('should update updated_at on upsert but preserve created_at', () => {
      usersCache.upsert(createTestUser())
      const original = usersCache.getById('123456')
      const originalCreatedAt = original?.created_at

      // Small delay
      usersCache.upsert(createTestUser({ first_name: 'Updated' }))
      const updated = usersCache.getById('123456')

      expect(updated?.created_at).toBe(originalCreatedAt)
      expect(updated?.updated_at).toBeGreaterThanOrEqual(
        updated?.created_at ?? 0,
      )
    })
  })
})

// =============================================================================
// ChatsCache Tests
// =============================================================================

describe('ChatsCache', () => {
  let db: Database
  let chatsCache: ChatsCache

  const createTestChat = (overrides = {}) => ({
    chat_id: '123456',
    type: 'group' as ChatType,
    title: 'Test Group',
    username: 'testgroup',
    member_count: 10,
    access_hash: 'abc123',
    is_creator: 0,
    is_admin: 1,
    last_message_id: 100,
    last_message_at: Date.now() - 1000,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 123456, title: 'Test Group' }),
    ...overrides,
  })

  beforeEach(() => {
    db = createAccountCacheDb()
    chatsCache = createChatsCache(db)
  })

  describe('upsert and getById', () => {
    it('should insert and retrieve chat by ID', () => {
      const chat = createTestChat()
      chatsCache.upsert(chat)

      const retrieved = chatsCache.getById('123456')

      expect(retrieved).not.toBeNull()
      expect(retrieved?.chat_id).toBe('123456')
      expect(retrieved?.title).toBe('Test Group')
      expect(retrieved?.type).toBe('group')
    })

    it('should update existing chat', () => {
      chatsCache.upsert(createTestChat())
      chatsCache.upsert(createTestChat({ title: 'Updated Group' }))

      const retrieved = chatsCache.getById('123456')

      expect(retrieved?.title).toBe('Updated Group')
      expect(chatsCache.count()).toBe(1)
    })

    it('should return null for non-existent chat', () => {
      expect(chatsCache.getById('nonexistent')).toBeNull()
    })

    it('should handle all chat types', () => {
      const types: ChatType[] = ['private', 'group', 'supergroup', 'channel']

      for (const type of types) {
        chatsCache.upsert(createTestChat({ chat_id: type, type }))
      }

      for (const type of types) {
        const chat = chatsCache.getById(type)
        expect(chat?.type).toBe(type)
      }
    })
  })

  describe('getByUsername', () => {
    it('should find chat by username', () => {
      chatsCache.upsert(createTestChat())

      const retrieved = chatsCache.getByUsername('testgroup')

      expect(retrieved).not.toBeNull()
      expect(retrieved?.chat_id).toBe('123456')
    })

    it('should find chat with @ prefix', () => {
      chatsCache.upsert(createTestChat())

      const retrieved = chatsCache.getByUsername('@testgroup')

      expect(retrieved).not.toBeNull()
    })

    it('should be case insensitive', () => {
      chatsCache.upsert(createTestChat())

      expect(chatsCache.getByUsername('TESTGROUP')).not.toBeNull()
      expect(chatsCache.getByUsername('TestGroup')).not.toBeNull()
    })

    it('should return null for non-existent username', () => {
      expect(chatsCache.getByUsername('nonexistent')).toBeNull()
    })

    it('should handle chat without username', () => {
      chatsCache.upsert(createTestChat({ username: null }))

      expect(chatsCache.getByUsername('testgroup')).toBeNull()
    })
  })

  describe('list', () => {
    beforeEach(() => {
      // Create chats with different types and timestamps
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          type: 'private',
          title: 'Alice',
          last_message_at: Date.now() - 1000,
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '2',
          type: 'group',
          title: 'Team Chat',
          last_message_at: Date.now() - 5000,
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '3',
          type: 'supergroup',
          title: 'Community',
          last_message_at: Date.now() - 2000,
        }),
      )
      chatsCache.upsert(
        createTestChat({
          chat_id: '4',
          type: 'channel',
          title: 'News',
          last_message_at: Date.now() - 10000,
        }),
      )
    })

    it('should list all chats', () => {
      const chats = chatsCache.list()

      expect(chats.length).toBe(4)
    })

    it('should filter by type', () => {
      const groups = chatsCache.list({ type: 'group' })

      expect(groups.length).toBe(1)
      expect(groups[0]?.title).toBe('Team Chat')
    })

    it('should order by last_message_at by default (newest first)', () => {
      const chats = chatsCache.list()

      // Alice should be first (most recent)
      expect(chats[0]?.title).toBe('Alice')
    })

    it('should order by title when specified', () => {
      const chats = chatsCache.list({ orderBy: 'title' })

      expect(chats[0]?.title).toBe('Alice')
      expect(chats[1]?.title).toBe('Community')
      expect(chats[2]?.title).toBe('News')
      expect(chats[3]?.title).toBe('Team Chat')
    })

    it('should respect limit', () => {
      const chats = chatsCache.list({ limit: 2 })

      expect(chats.length).toBe(2)
    })

    it('should respect offset', () => {
      const chats = chatsCache.list({ limit: 2, offset: 2 })

      expect(chats.length).toBe(2)
    })

    it('should combine type filter with ordering', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '5',
          type: 'group',
          title: 'Another Group',
          last_message_at: Date.now(),
        }),
      )

      const groups = chatsCache.list({ type: 'group', orderBy: 'title' })

      expect(groups.length).toBe(2)
      expect(groups[0]?.title).toBe('Another Group')
      expect(groups[1]?.title).toBe('Team Chat')
    })
  })

  describe('search', () => {
    beforeEach(() => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '1',
          title: 'Tech Discussion',
          username: 'techdiscuss',
        }),
      )
      chatsCache.upsert(
        createTestChat({ chat_id: '2', title: 'Family Group', username: null }),
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
          chat_id: '4',
          title: 'News Channel',
          username: 'technews',
        }),
      )
    })

    it('should find chats by title', () => {
      const results = chatsCache.search('Tech')

      expect(results.length).toBe(2) // Tech Discussion and technews
    })

    it('should find chats by username', () => {
      const results = chatsCache.search('workteam')

      expect(results.length).toBe(1)
      expect(results[0]?.title).toBe('Work Team')
    })

    it('should be case insensitive', () => {
      const results = chatsCache.search('FAMILY')

      expect(results.length).toBe(1)
      expect(results[0]?.title).toBe('Family Group')
    })

    it('should prioritize exact username matches', () => {
      const results = chatsCache.search('technews')

      expect(results[0]?.username).toBe('technews')
    })

    it('should rank an exact title match above newer partial matches', () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: '5',
          title: 'Work Team Archive',
          username: null,
          last_message_at: Date.now(),
        }),
      )

      const results = chatsCache.search('work team')

      expect(results.map((c) => c.title)).toEqual([
        'Work Team',
        'Work Team Archive',
      ])
    })

    it('should return empty array for no matches', () => {
      const results = chatsCache.search('nonexistent')

      expect(results).toEqual([])
    })

    it('should respect limit parameter', () => {
      const results = chatsCache.search('tech', 1)

      expect(results.length).toBe(1)
    })
  })

  describe('upsertMany', () => {
    it('should insert multiple chats', () => {
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

  describe('count', () => {
    it('should return 0 for empty cache', () => {
      expect(chatsCache.count()).toBe(0)
    })

    it('should return correct count', () => {
      chatsCache.upsert(createTestChat({ chat_id: '1' }))
      chatsCache.upsert(createTestChat({ chat_id: '2' }))

      expect(chatsCache.count()).toBe(2)
    })

    it('should count by type', () => {
      chatsCache.upsert(createTestChat({ chat_id: '1', type: 'group' }))
      chatsCache.upsert(createTestChat({ chat_id: '2', type: 'group' }))
      chatsCache.upsert(createTestChat({ chat_id: '3', type: 'channel' }))

      expect(chatsCache.count('group')).toBe(2)
      expect(chatsCache.count('channel')).toBe(1)
      expect(chatsCache.count('private')).toBe(0)
    })
  })

  describe('timestamps', () => {
    it('should set created_at and updated_at on insert', () => {
      const beforeInsert = Date.now()
      chatsCache.upsert(createTestChat())
      const afterInsert = Date.now()

      const chat = chatsCache.getById('123456')

      expect(chat?.created_at).toBeGreaterThanOrEqual(beforeInsert)
      expect(chat?.created_at).toBeLessThanOrEqual(afterInsert)
      expect(chat?.updated_at).toBeGreaterThanOrEqual(beforeInsert)
      expect(chat?.updated_at).toBeLessThanOrEqual(afterInsert)
    })
  })

  describe('edge cases', () => {
    it('should handle null last_message_at', () => {
      chatsCache.upsert(createTestChat({ last_message_at: null }))

      const chat = chatsCache.getById('123456')

      expect(chat?.last_message_at).toBeNull()
    })

    it('should handle null member_count', () => {
      chatsCache.upsert(createTestChat({ member_count: null }))

      const chat = chatsCache.getById('123456')

      expect(chat?.member_count).toBeNull()
    })

    it('should preserve raw_json', () => {
      const rawJson = JSON.stringify({ complex: { nested: { data: true } } })
      chatsCache.upsert(createTestChat({ raw_json: rawJson }))

      const chat = chatsCache.getById('123456')

      expect(chat?.raw_json).toBe(rawJson)
    })
  })
})

// =============================================================================
// Factory Function Tests
// =============================================================================

describe('Factory Functions', () => {
  describe('createUsersCache', () => {
    it('should create UsersCache instance', () => {
      const db = createAccountCacheDb()
      const cache = createUsersCache(db)

      expect(cache).toBeInstanceOf(UsersCache)
    })
  })

  describe('createChatsCache', () => {
    it('should create ChatsCache instance', () => {
      const db = createAccountCacheDb()
      const cache = createChatsCache(db)

      expect(cache).toBeInstanceOf(ChatsCache)
    })
  })
})
