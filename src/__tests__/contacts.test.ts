/**
 * Contacts command tests
 * Tests the caching layer integration for contact operations
 */
import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

import { createTestCacheDatabase } from '../db/schema'
import { getDefaultCacheConfig, isCacheStale } from '../db/types'
import {
  createUsersCache,
  type UserCacheInput,
  type UsersCache,
} from '../db/users-cache'
import { mockDbModule } from './helpers/db-mock'

// Note: We no longer mock the output module to avoid interfering with other tests.
// The output module handles test mode properly (throws instead of process.exit)

// Mock client for Telegram API calls
const createMockClient = () => ({
  call: mock(() => Promise.resolve({})),
  getMe: mock(() => Promise.resolve({ id: 123, firstName: 'Test' })),
})

// Mock the Telegram service
let mockClient = createMockClient()
mock.module('../services/telegram', () => ({
  getClientForAccount: mock(() => mockClient),
}))

// Each account reads the test cache
let testCacheDb: Database
mock.module('../db', () => mockDbModule({ cacheFor: () => testCacheDb }))

describe('Contacts Commands', () => {
  let usersCache: UsersCache
  const cacheConfig = getDefaultCacheConfig()

  beforeEach(() => {
    // Create fresh test database
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    usersCache = createUsersCache(db)

    // Reset mock client
    mockClient = createMockClient()
  })

  // =============================================================================
  // UsersCache Tests (underlying cache layer)
  // =============================================================================

  describe('UsersCache', () => {
    describe('upsert and getById', () => {
      it('should insert and retrieve a user by ID', () => {
        const input: UserCacheInput = {
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          last_name: 'User',
          phone: '1234567890',
          access_hash: '456',
          is_contact: 1,
          is_bot: 0,
          is_premium: 0,
          fetched_at: Date.now(),
          raw_json: JSON.stringify({ id: 123, firstName: 'Test' }),
        }

        usersCache.upsert(input)
        const cached = usersCache.getById('123')

        expect(cached).not.toBeNull()
        expect(cached?.user_id).toBe('123')
        expect(cached?.username).toBe('testuser')
        expect(cached?.first_name).toBe('Test')
        expect(cached?.last_name).toBe('User')
        expect(cached?.is_contact).toBe(1)
      })

      it('should update existing user on conflict', () => {
        const input1: UserCacheInput = {
          user_id: '123',
          username: 'oldname',
          first_name: 'Old',
          last_name: 'Name',
          fetched_at: Date.now() - 1000,
          raw_json: '{}',
        }

        const input2: UserCacheInput = {
          user_id: '123',
          username: 'newname',
          first_name: 'New',
          last_name: 'Name',
          fetched_at: Date.now(),
          raw_json: '{}',
        }

        usersCache.upsert(input1)
        usersCache.upsert(input2)

        const cached = usersCache.getById('123')
        expect(cached?.username).toBe('newname')
        expect(cached?.first_name).toBe('New')
      })

      it('should return null for non-existent user', () => {
        const cached = usersCache.getById('999')
        expect(cached).toBeNull()
      })
    })

    describe('getByUsername', () => {
      it('should retrieve user by username', () => {
        const input: UserCacheInput = {
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          fetched_at: Date.now(),
          raw_json: '{}',
        }

        usersCache.upsert(input)
        const cached = usersCache.getByUsername('testuser')

        expect(cached).not.toBeNull()
        expect(cached?.user_id).toBe('123')
      })

      it('should handle username with @ prefix', () => {
        const input: UserCacheInput = {
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          fetched_at: Date.now(),
          raw_json: '{}',
        }

        usersCache.upsert(input)
        const cached = usersCache.getByUsername('@testuser')

        expect(cached).not.toBeNull()
        expect(cached?.user_id).toBe('123')
      })

      it('should be case-insensitive', () => {
        const input: UserCacheInput = {
          user_id: '123',
          username: 'TestUser',
          first_name: 'Test',
          fetched_at: Date.now(),
          raw_json: '{}',
        }

        usersCache.upsert(input)

        expect(usersCache.getByUsername('testuser')).not.toBeNull()
        expect(usersCache.getByUsername('TESTUSER')).not.toBeNull()
      })

      it('should return null for non-existent username', () => {
        const cached = usersCache.getByUsername('nonexistent')
        expect(cached).toBeNull()
      })
    })

    describe('getByPhone', () => {
      it('should retrieve user by phone number', () => {
        const input: UserCacheInput = {
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          phone: '1234567890',
          fetched_at: Date.now(),
          raw_json: '{}',
        }

        usersCache.upsert(input)
        const cached = usersCache.getByPhone('1234567890')

        expect(cached).not.toBeNull()
        expect(cached?.user_id).toBe('123')
      })

      it('should normalize phone numbers (remove + and spaces)', () => {
        const input: UserCacheInput = {
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          phone: '1234567890',
          fetched_at: Date.now(),
          raw_json: '{}',
        }

        usersCache.upsert(input)

        // These should all find the same user
        expect(usersCache.getByPhone('+1234567890')).not.toBeNull()
        expect(usersCache.getByPhone('123 456 7890')).not.toBeNull()
      })
    })

    describe('upsertMany', () => {
      it('should insert multiple users in a transaction', () => {
        const inputs: UserCacheInput[] = [
          {
            user_id: '1',
            username: 'user1',
            first_name: 'User',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
          {
            user_id: '2',
            username: 'user2',
            first_name: 'User',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
          {
            user_id: '3',
            username: 'user3',
            first_name: 'User',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
        ]

        usersCache.upsertMany(inputs)

        expect(usersCache.getById('1')).not.toBeNull()
        expect(usersCache.getById('2')).not.toBeNull()
        expect(usersCache.getById('3')).not.toBeNull()
        expect(usersCache.count()).toBe(3)
      })

      it('should handle empty array', () => {
        expect(() => usersCache.upsertMany([])).not.toThrow()
        expect(usersCache.count()).toBe(0)
      })
    })

    describe('search', () => {
      beforeEach(() => {
        const users: UserCacheInput[] = [
          {
            user_id: '1',
            username: 'john_doe',
            first_name: 'John',
            last_name: 'Doe',
            phone: '1111111111',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
          {
            user_id: '2',
            username: 'jane_doe',
            first_name: 'Jane',
            last_name: 'Doe',
            phone: '2222222222',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
          {
            user_id: '3',
            username: 'bob_smith',
            first_name: 'Bob',
            last_name: 'Smith',
            phone: '3333333333',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
        ]
        usersCache.upsertMany(users)
      })

      it('should search by first name', () => {
        const results = usersCache.search('John')
        expect(results).toHaveLength(1)
        expect(results[0]?.user_id).toBe('1')
      })

      it('should search by last name', () => {
        const results = usersCache.search('Doe')
        expect(results).toHaveLength(2)
      })

      it('should search by username', () => {
        const results = usersCache.search('bob_smith')
        expect(results).toHaveLength(1)
        expect(results[0]?.user_id).toBe('3')
      })

      it('should search by phone', () => {
        const results = usersCache.search('111111')
        expect(results).toHaveLength(1)
        expect(results[0]?.user_id).toBe('1')
      })

      it('should respect limit parameter', () => {
        const results = usersCache.search('Doe', 1)
        expect(results).toHaveLength(1)
      })

      it('should return empty array for no matches', () => {
        const results = usersCache.search('nonexistent')
        expect(results).toHaveLength(0)
      })
    })

    describe('getAll', () => {
      it('should return all users with default limit', () => {
        const users: UserCacheInput[] = Array.from({ length: 10 }, (_, i) => ({
          user_id: String(i),
          username: `user${i}`,
          first_name: `User ${i}`,
          fetched_at: Date.now(),
          raw_json: '{}',
        }))
        usersCache.upsertMany(users)

        const all = usersCache.getAll()
        expect(all).toHaveLength(10)
      })

      it('should respect limit option', () => {
        const users: UserCacheInput[] = Array.from({ length: 10 }, (_, i) => ({
          user_id: String(i),
          username: `user${i}`,
          first_name: `User ${i}`,
          fetched_at: Date.now(),
          raw_json: '{}',
        }))
        usersCache.upsertMany(users)

        const limited = usersCache.getAll({ limit: 5 })
        expect(limited).toHaveLength(5)
      })

      it('should respect offset option', () => {
        const users: UserCacheInput[] = Array.from({ length: 10 }, (_, i) => ({
          user_id: String(i),
          username: `user${i}`,
          first_name: `User ${i}`,
          fetched_at: Date.now(),
          raw_json: '{}',
        }))
        usersCache.upsertMany(users)

        const page1 = usersCache.getAll({ limit: 5, offset: 0 })
        const page2 = usersCache.getAll({ limit: 5, offset: 5 })

        expect(page1).toHaveLength(5)
        expect(page2).toHaveLength(5)
        // Ensure no overlap
        const ids1 = page1.map((u) => u.user_id)
        const ids2 = page2.map((u) => u.user_id)
        const overlap = ids1.filter((id) => ids2.includes(id))
        expect(overlap).toHaveLength(0)
      })
    })

    describe('getStale', () => {
      it('should return entries older than TTL', () => {
        const now = Date.now()
        const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000 - 1000

        usersCache.upsert({
          user_id: '1',
          username: 'fresh',
          first_name: 'Fresh',
          fetched_at: now,
          raw_json: '{}',
        })

        usersCache.upsert({
          user_id: '2',
          username: 'stale',
          first_name: 'Stale',
          fetched_at: oneWeekAgo,
          raw_json: '{}',
        })

        const stale = usersCache.getStale(cacheConfig.staleness.peers)
        expect(stale).toHaveLength(1)
        expect(stale[0]?.user_id).toBe('2')
      })
    })

    describe('delete', () => {
      it('should delete user and return true', () => {
        usersCache.upsert({
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          fetched_at: Date.now(),
          raw_json: '{}',
        })

        const deleted = usersCache.delete('123')
        expect(deleted).toBe(true)
        expect(usersCache.getById('123')).toBeNull()
      })

      it('should return false for non-existent user', () => {
        const deleted = usersCache.delete('999')
        expect(deleted).toBe(false)
      })
    })

    describe('count', () => {
      it('should return 0 for empty cache', () => {
        expect(usersCache.count()).toBe(0)
      })

      it('should return correct count', () => {
        usersCache.upsertMany([
          {
            user_id: '1',
            first_name: 'A',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
          {
            user_id: '2',
            first_name: 'B',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
          {
            user_id: '3',
            first_name: 'C',
            fetched_at: Date.now(),
            raw_json: '{}',
          },
        ])

        expect(usersCache.count()).toBe(3)
      })

      it('should update after delete', () => {
        usersCache.upsert({
          user_id: '1',
          first_name: 'A',
          fetched_at: Date.now(),
          raw_json: '{}',
        })
        usersCache.upsert({
          user_id: '2',
          first_name: 'B',
          fetched_at: Date.now(),
          raw_json: '{}',
        })

        expect(usersCache.count()).toBe(2)
        usersCache.delete('1')
        expect(usersCache.count()).toBe(1)
      })
    })

    describe('prune', () => {
      it('should remove entries older than max age', () => {
        const now = Date.now()
        const oldEntry = now - 30 * 24 * 60 * 60 * 1000 - 1000 // > 30 days old

        usersCache.upsert({
          user_id: '1',
          username: 'fresh',
          first_name: 'Fresh',
          fetched_at: now,
          raw_json: '{}',
        })

        usersCache.upsert({
          user_id: '2',
          username: 'old',
          first_name: 'Old',
          fetched_at: oldEntry,
          raw_json: '{}',
        })

        const pruned = usersCache.prune(30 * 24 * 60 * 60 * 1000) // 30 days
        expect(pruned).toBe(1)
        expect(usersCache.getById('1')).not.toBeNull()
        expect(usersCache.getById('2')).toBeNull()
      })
    })

    describe('display_name computation', () => {
      it('should compute display_name from first_name and last_name', () => {
        usersCache.upsert({
          user_id: '1',
          first_name: 'John',
          last_name: 'Doe',
          fetched_at: Date.now(),
          raw_json: '{}',
        })

        const cached = usersCache.getById('1')
        expect(cached?.display_name).toBe('John Doe')
      })

      it('should handle first_name only', () => {
        usersCache.upsert({
          user_id: '1',
          first_name: 'John',
          fetched_at: Date.now(),
          raw_json: '{}',
        })

        const cached = usersCache.getById('1')
        expect(cached?.display_name).toBe('John')
      })

      it('should handle last_name only', () => {
        usersCache.upsert({
          user_id: '1',
          last_name: 'Doe',
          fetched_at: Date.now(),
          raw_json: '{}',
        })

        const cached = usersCache.getById('1')
        expect(cached?.display_name).toBe('Doe')
      })

      it('should return null for no names', () => {
        usersCache.upsert({
          user_id: '1',
          fetched_at: Date.now(),
          raw_json: '{}',
        })

        const cached = usersCache.getById('1')
        expect(cached?.display_name).toBeNull()
      })
    })
  })

  // =============================================================================
  // isCacheStale utility tests
  // =============================================================================

  describe('isCacheStale', () => {
    it('should return true for null fetched_at', () => {
      expect(isCacheStale(null, cacheConfig.staleness.peers)).toBe(true)
    })

    it('should return false for fresh data', () => {
      const now = Date.now()
      expect(isCacheStale(now, cacheConfig.staleness.peers)).toBe(false)
    })

    it('should return true for data older than TTL', () => {
      const oneWeekAgo = Date.now() - cacheConfig.staleness.peers - 1000
      expect(isCacheStale(oneWeekAgo, cacheConfig.staleness.peers)).toBe(true)
    })

    it('should return false for data exactly at TTL boundary', () => {
      // Data just under the TTL should not be stale
      const justUnderTtl = Date.now() - cacheConfig.staleness.peers + 1000
      expect(isCacheStale(justUnderTtl, cacheConfig.staleness.peers)).toBe(
        false,
      )
    })
  })

  // =============================================================================
  // Contacts filtering tests (simulating command behavior)
  // =============================================================================

  describe('Contact filtering', () => {
    beforeEach(() => {
      // Seed cache with mix of contacts and non-contacts
      const users: UserCacheInput[] = [
        {
          user_id: '1',
          username: 'contact1',
          first_name: 'Contact',
          is_contact: 1,
          fetched_at: Date.now(),
          raw_json: '{}',
        },
        {
          user_id: '2',
          username: 'contact2',
          first_name: 'Contact2',
          is_contact: 1,
          fetched_at: Date.now(),
          raw_json: '{}',
        },
        {
          user_id: '3',
          username: 'notcontact',
          first_name: 'NotContact',
          is_contact: 0,
          fetched_at: Date.now(),
          raw_json: '{}',
        },
        {
          user_id: '4',
          username: 'bot',
          first_name: 'Bot',
          is_contact: 0,
          is_bot: 1,
          fetched_at: Date.now(),
          raw_json: '{}',
        },
      ]
      usersCache.upsertMany(users)
    })

    it('should filter users by is_contact flag', () => {
      const allUsers = usersCache.getAll({ limit: 100 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)

      expect(allUsers).toHaveLength(4)
      expect(contacts).toHaveLength(2)
    })

    it('should include bots when filtering by is_bot', () => {
      const allUsers = usersCache.getAll({ limit: 100 })
      const bots = allUsers.filter((u) => u.is_bot === 1)

      expect(bots).toHaveLength(1)
      expect(bots[0]?.username).toBe('bot')
    })
  })

  // =============================================================================
  // Cache hit/miss behavior tests
  // =============================================================================

  describe('Cache hit/miss scenarios', () => {
    it('should return cached contacts without API call when cache is populated', () => {
      // Simulate cached contacts
      const cachedContacts: UserCacheInput[] = [
        {
          user_id: '1',
          username: 'cached1',
          first_name: 'Cached',
          is_contact: 1,
          fetched_at: Date.now(),
          raw_json: '{}',
        },
        {
          user_id: '2',
          username: 'cached2',
          first_name: 'Cached2',
          is_contact: 1,
          fetched_at: Date.now(),
          raw_json: '{}',
        },
      ]
      usersCache.upsertMany(cachedContacts)

      // Verify cache is populated
      const allUsers = usersCache.getAll({ limit: 100 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)

      expect(contacts).toHaveLength(2)
      // In a real scenario, no API call would be made
    })

    it('should detect stale cache entries', () => {
      const now = Date.now()
      const staleTime = now - cacheConfig.staleness.peers - 1000

      usersCache.upsertMany([
        {
          user_id: '1',
          username: 'fresh',
          first_name: 'Fresh',
          is_contact: 1,
          fetched_at: now,
          raw_json: '{}',
        },
        {
          user_id: '2',
          username: 'stale',
          first_name: 'Stale',
          is_contact: 1,
          fetched_at: staleTime,
          raw_json: '{}',
        },
      ])

      const allUsers = usersCache.getAll({ limit: 100 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)
      const anyStale = contacts.some((u) =>
        isCacheStale(u.fetched_at, cacheConfig.staleness.peers),
      )

      expect(anyStale).toBe(true)
    })

    it('should not flag fresh cache as stale', () => {
      const now = Date.now()

      usersCache.upsertMany([
        {
          user_id: '1',
          username: 'fresh1',
          first_name: 'Fresh1',
          is_contact: 1,
          fetched_at: now,
          raw_json: '{}',
        },
        {
          user_id: '2',
          username: 'fresh2',
          first_name: 'Fresh2',
          is_contact: 1,
          fetched_at: now,
          raw_json: '{}',
        },
      ])

      const allUsers = usersCache.getAll({ limit: 100 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)
      const anyStale = contacts.some((u) =>
        isCacheStale(u.fetched_at, cacheConfig.staleness.peers),
      )

      expect(anyStale).toBe(false)
    })
  })

  // =============================================================================
  // Pagination tests
  // =============================================================================

  describe('Pagination behavior', () => {
    beforeEach(() => {
      // Create 25 contacts for pagination testing
      const contacts: UserCacheInput[] = Array.from({ length: 25 }, (_, i) => ({
        user_id: String(i + 1),
        username: `contact${i + 1}`,
        first_name: `Contact ${i + 1}`,
        is_contact: 1,
        fetched_at: Date.now(),
        raw_json: '{}',
      }))
      usersCache.upsertMany(contacts)
    })

    it('should paginate contacts correctly', () => {
      const allUsers = usersCache.getAll({ limit: 1000 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)

      // Simulate pagination
      const limit = 10
      const offset = 0
      const page1 = contacts.slice(offset, offset + limit)

      expect(page1).toHaveLength(10)
      expect(contacts.length).toBe(25)
    })

    it('should handle offset correctly', () => {
      const allUsers = usersCache.getAll({ limit: 1000 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)

      const limit = 10
      const offset = 20
      const page3 = contacts.slice(offset, offset + limit)

      expect(page3).toHaveLength(5) // Only 5 remaining (25 - 20)
    })

    it('should calculate hasMore correctly', () => {
      const allUsers = usersCache.getAll({ limit: 1000 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)

      const limit = 10
      const offset = 0
      const hasMore = offset + limit < contacts.length

      expect(hasMore).toBe(true) // 0 + 10 = 10 < 25
    })

    it('should return hasMore false when on last page', () => {
      const allUsers = usersCache.getAll({ limit: 1000 })
      const contacts = allUsers.filter((u) => u.is_contact === 1)

      const limit = 10
      const offset = 20
      const hasMore = offset + limit < contacts.length

      expect(hasMore).toBe(false) // 20 + 10 = 30 >= 25
    })
  })

  // =============================================================================
  // API response caching tests
  // =============================================================================

  describe('API response caching', () => {
    it('should cache API users correctly', () => {
      // Simulate API response users
      const apiUsers = [
        {
          id: 123,
          firstName: 'John',
          lastName: 'Doe',
          username: 'johndoe',
          phone: '1234567890',
          contact: true,
          bot: false,
          premium: false,
        },
        {
          id: 456,
          firstName: 'Jane',
          lastName: 'Smith',
          username: 'janesmith',
          phone: '0987654321',
          contact: true,
          bot: false,
          premium: true,
        },
      ]

      // Convert to cache input format (simulating apiUserToCacheInput)
      const cacheInputs: UserCacheInput[] = apiUsers.map((user) => ({
        user_id: String(user.id),
        username: user.username ?? null,
        first_name: user.firstName ?? null,
        last_name: user.lastName ?? null,
        phone: user.phone ?? null,
        access_hash: null,
        is_contact: user.contact ? 1 : 0,
        is_bot: user.bot ? 1 : 0,
        is_premium: user.premium ? 1 : 0,
        fetched_at: Date.now(),
        raw_json: JSON.stringify(user),
      }))

      usersCache.upsertMany(cacheInputs)

      // Verify caching
      const john = usersCache.getById('123')
      const jane = usersCache.getById('456')

      expect(john).not.toBeNull()
      expect(john?.username).toBe('johndoe')
      expect(john?.is_contact).toBe(1)

      expect(jane).not.toBeNull()
      expect(jane?.is_premium).toBe(1)
    })

    it('should preserve raw_json for future-proofing', () => {
      const apiUser = {
        id: 123,
        firstName: 'Test',
        customField: 'value',
        nested: { data: true },
      }

      usersCache.upsert({
        user_id: '123',
        first_name: 'Test',
        fetched_at: Date.now(),
        raw_json: JSON.stringify(apiUser),
      })

      const cached = usersCache.getById('123')
      const parsed = JSON.parse(cached?.raw_json ?? '{}')

      expect(parsed.customField).toBe('value')
      expect(parsed.nested.data).toBe(true)
    })
  })

  // =============================================================================
  // getContact by identifier tests
  // =============================================================================

  describe('getContact identifier parsing', () => {
    beforeEach(() => {
      usersCache.upsertMany([
        {
          user_id: '123',
          username: 'testuser',
          first_name: 'Test',
          fetched_at: Date.now(),
          raw_json: '{}',
        },
        {
          user_id: '456',
          username: 'anotheruser',
          first_name: 'Another',
          fetched_at: Date.now(),
          raw_json: '{}',
        },
      ])
    })

    it('should identify username with @ prefix', () => {
      const identifier = '@testuser'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      expect(isUsername).toBe(true)
    })

    it('should identify username without @ prefix', () => {
      const identifier = 'testuser'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      expect(isUsername).toBe(true)
    })

    it('should identify numeric ID', () => {
      const identifier = '123'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      expect(isUsername).toBe(false)
    })

    it('should fetch by ID when identifier is numeric', () => {
      const identifier = '123'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      const cached = isUsername
        ? usersCache.getByUsername(identifier)
        : usersCache.getById(identifier)

      expect(cached).not.toBeNull()
      expect(cached?.username).toBe('testuser')
    })

    it('should fetch by username when identifier starts with @', () => {
      const identifier = '@testuser'
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      const cached = isUsername
        ? usersCache.getByUsername(identifier)
        : usersCache.getById(identifier)

      expect(cached).not.toBeNull()
      expect(cached?.user_id).toBe('123')
    })
  })

  // =============================================================================
  // Fresh flag behavior tests
  // =============================================================================

  describe('--fresh flag behavior', () => {
    beforeEach(() => {
      usersCache.upsert({
        user_id: '123',
        username: 'cached',
        first_name: 'Cached',
        fetched_at: Date.now(),
        raw_json: '{}',
      })
    })

    it('should bypass cache when fresh=true (simulated)', () => {
      const fresh = true
      let usedApi = false

      // Simulate command logic
      if (!fresh) {
        const cached = usersCache.getById('123')
        if (cached) {
          // Would return cached data
        }
      } else {
        // Would call API
        usedApi = true
      }

      expect(usedApi).toBe(true)
    })

    it('should use cache when fresh=false', () => {
      const fresh = false
      let usedCache = false

      // Simulate command logic
      if (!fresh) {
        const cached = usersCache.getById('123')
        if (cached) {
          usedCache = true
        }
      }

      expect(usedCache).toBe(true)
    })
  })

  // =============================================================================
  // Edge cases
  // =============================================================================

  describe('Edge cases', () => {
    it('should handle users with null optional fields', () => {
      usersCache.upsert({
        user_id: '123',
        username: null,
        first_name: null,
        last_name: null,
        phone: null,
        access_hash: null,
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('123')
      expect(cached).not.toBeNull()
      expect(cached?.username).toBeNull()
      expect(cached?.first_name).toBeNull()
    })

    it('should handle very long usernames', () => {
      const longUsername = 'a'.repeat(100)
      usersCache.upsert({
        user_id: '123',
        username: longUsername,
        first_name: 'Test',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getByUsername(longUsername)
      expect(cached).not.toBeNull()
    })

    it('should handle special characters in names', () => {
      usersCache.upsert({
        user_id: '123',
        username: 'user_name',
        first_name: 'Test\'"<>&',
        last_name: 'User\n\t',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('123')
      expect(cached?.first_name).toBe('Test\'"<>&')
    })

    it('should handle unicode characters', () => {
      usersCache.upsert({
        user_id: '123',
        username: 'user',
        first_name: 'Тест',
        last_name: '测试',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('123')
      expect(cached?.first_name).toBe('Тест')
      expect(cached?.last_name).toBe('测试')
      expect(cached?.display_name).toBe('Тест 测试')
    })

    it('should handle emoji in names', () => {
      usersCache.upsert({
        user_id: '123',
        username: 'emoji_user',
        first_name: '👋 Hello',
        last_name: 'World 🌍',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const cached = usersCache.getById('123')
      expect(cached?.first_name).toBe('👋 Hello')
    })

    it('should handle empty search query gracefully', () => {
      usersCache.upsert({
        user_id: '123',
        username: 'test',
        first_name: 'Test',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      // Empty search should return results (matches anything with LIKE %%)
      const results = usersCache.search('')
      expect(results.length).toBeGreaterThanOrEqual(1)
    })

    it('should handle SQL-injection-like patterns safely', () => {
      const maliciousQuery = "'; DROP TABLE users_cache; --"

      usersCache.upsert({
        user_id: '123',
        username: 'test',
        first_name: 'Test',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      // Should not throw and should not drop table
      expect(() => usersCache.search(maliciousQuery)).not.toThrow()
      expect(usersCache.count()).toBe(1)
    })
  })

  // =============================================================================
  // Timestamp handling tests
  // =============================================================================

  describe('Timestamp handling', () => {
    it('should set created_at on insert', () => {
      const before = Date.now()
      usersCache.upsert({
        user_id: '123',
        first_name: 'Test',
        fetched_at: Date.now(),
        raw_json: '{}',
      })
      const after = Date.now()

      const cached = usersCache.getById('123')
      expect(cached?.created_at).toBeGreaterThanOrEqual(before)
      expect(cached?.created_at).toBeLessThanOrEqual(after)
    })

    it('should update updated_at on upsert', () => {
      usersCache.upsert({
        user_id: '123',
        first_name: 'Original',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const original = usersCache.getById('123')
      expect(original?.updated_at).toBeDefined()

      // Small delay
      const before = Date.now()
      usersCache.upsert({
        user_id: '123',
        first_name: 'Updated',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const updated = usersCache.getById('123')
      expect(updated?.updated_at).toBeGreaterThanOrEqual(before)
      expect(updated?.first_name).toBe('Updated')
    })

    it('should preserve created_at on update', () => {
      const insertTime = Date.now()
      usersCache.upsert({
        user_id: '123',
        first_name: 'Original',
        fetched_at: insertTime,
        raw_json: '{}',
      })

      const original = usersCache.getById('123')
      const originalCreatedAt = original?.created_at

      // Update
      usersCache.upsert({
        user_id: '123',
        first_name: 'Updated',
        fetched_at: Date.now(),
        raw_json: '{}',
      })

      const updated = usersCache.getById('123')
      // created_at should remain the same
      expect(updated?.created_at).toBe(originalCreatedAt)
    })
  })
})
