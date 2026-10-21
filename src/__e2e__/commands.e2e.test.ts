/**
 * E2E tests for contacts and chats commands
 *
 * Tests contacts list, search, get and chats list, search, get commands
 * using an isolated database environment with seeded cache data.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCliFailure, runCliSuccess } from './helpers/cli'

const E2E_TEST_BASE = join(tmpdir(), 'telegram-sync-cli-e2e-tests')

/**
 * Extended test environment that includes cache database
 */
interface ExtendedTestEnvironment {
  dataDir: string
  initDatabase(): Database
  initCacheDatabase(): Database
  seedAccounts(
    accounts: Array<{
      phone: string
      user_id?: number | null
      name?: string
      username?: string | null
      label?: string | null
      is_active?: boolean
      session_data?: string
    }>,
  ): void
  seedUsers(
    users: Array<{
      user_id: string
      username?: string | null
      first_name?: string | null
      last_name?: string | null
      phone?: string | null
      is_contact?: number
      is_bot?: number
      is_premium?: number
    }>,
  ): void
  seedChats(
    chats: Array<{
      chat_id: string
      type: 'private' | 'group' | 'supergroup' | 'channel'
      title?: string | null
      username?: string | null
      member_count?: number | null
      is_creator?: number
      is_admin?: number
      last_message_at?: number | null
    }>,
  ): void
  cleanup(): void
  getCliOptions(): { env: Record<string, string> }
}

/**
 * Initialize accounts schema
 */
function initAccountsSchema(db: Database): void {
  db.run('PRAGMA journal_mode = WAL')

  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      name TEXT,
      username TEXT,
      label TEXT,
      session_data TEXT NOT NULL DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_phone ON accounts(phone)')
  db.run(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username)',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_accounts_label ON accounts(label)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active)',
  )
}

/**
 * Initialize cache schema
 */
function initCacheSchema(db: Database): void {
  db.run('PRAGMA journal_mode = WAL')

  // Users cache table
  db.run(`
    CREATE TABLE IF NOT EXISTS users_cache (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      display_name TEXT,
      phone TEXT,
      access_hash TEXT,
      is_contact INTEGER DEFAULT 0,
      is_bot INTEGER DEFAULT 0,
      is_premium INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  // Users cache indexes
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_users_cache_username ON users_cache(username) WHERE username IS NOT NULL',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_users_cache_phone ON users_cache(phone) WHERE phone IS NOT NULL',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_users_cache_fetched_at ON users_cache(fetched_at)',
  )

  // Chats cache table
  db.run(`
    CREATE TABLE IF NOT EXISTS chats_cache (
      chat_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      username TEXT,
      member_count INTEGER,
      access_hash TEXT,
      is_creator INTEGER DEFAULT 0,
      is_admin INTEGER DEFAULT 0,
      last_message_id INTEGER,
      last_message_at INTEGER,
      fetched_at INTEGER NOT NULL,
      raw_json TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    )
  `)

  // Chats cache indexes
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_chats_cache_username ON chats_cache(username) WHERE username IS NOT NULL',
  )
  db.run('CREATE INDEX IF NOT EXISTS idx_chats_cache_type ON chats_cache(type)')
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_chats_cache_fetched_at ON chats_cache(fetched_at)',
  )
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_chats_cache_last_message_at ON chats_cache(last_message_at DESC)',
  )
}

/**
 * Create an extended test environment with cache support
 */
function createExtendedTestEnvironment(
  testName: string,
): ExtendedTestEnvironment {
  const timestamp = Date.now()
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  const dataDir = join(
    E2E_TEST_BASE,
    `${testName}-${timestamp}-${randomSuffix}`,
  )

  mkdirSync(dataDir, { recursive: true })

  let db: Database | null = null
  let cacheDb: Database | null = null

  return {
    dataDir,

    initDatabase(): Database {
      const dbPath = join(dataDir, 'data.db')
      db = new Database(dbPath)
      initAccountsSchema(db)
      return db
    },

    initCacheDatabase(): Database {
      const cacheDbPath = join(dataDir, 'cache.db')
      cacheDb = new Database(cacheDbPath)
      initCacheSchema(cacheDb)
      return cacheDb
    },

    seedAccounts(accounts): void {
      if (!db) {
        this.initDatabase()
      }

      const stmt = db!.prepare(`
        INSERT INTO accounts (phone, user_id, name, username, label, session_data, is_active)
        VALUES ($phone, $user_id, $name, $username, $label, $session_data, $is_active)
      `)

      for (const account of accounts) {
        stmt.run({
          $phone: account.phone,
          $user_id: account.user_id ?? null,
          $name: account.name ?? null,
          $username: account.username ?? null,
          $label: account.label ?? null,
          $session_data: account.session_data ?? '',
          $is_active: account.is_active ? 1 : 0,
        })
      }
    },

    seedUsers(users): void {
      if (!cacheDb) {
        this.initCacheDatabase()
      }

      const stmt = cacheDb!.prepare(`
        INSERT INTO users_cache (
          user_id, username, first_name, last_name, display_name, phone,
          access_hash, is_contact, is_bot, is_premium, fetched_at, raw_json
        ) VALUES (
          $user_id, $username, $first_name, $last_name, $display_name, $phone,
          $access_hash, $is_contact, $is_bot, $is_premium, $fetched_at, $raw_json
        )
      `)

      const now = Date.now()

      for (const user of users) {
        const displayName = [user.first_name, user.last_name]
          .filter(Boolean)
          .join(' ')

        stmt.run({
          $user_id: user.user_id,
          $username: user.username ?? null,
          $first_name: user.first_name ?? null,
          $last_name: user.last_name ?? null,
          $display_name: displayName || null,
          $phone: user.phone ?? null,
          $access_hash: null,
          $is_contact: user.is_contact ?? 0,
          $is_bot: user.is_bot ?? 0,
          $is_premium: user.is_premium ?? 0,
          $fetched_at: now,
          $raw_json: JSON.stringify(user),
        })
      }
    },

    seedChats(chats): void {
      if (!cacheDb) {
        this.initCacheDatabase()
      }

      const stmt = cacheDb!.prepare(`
        INSERT INTO chats_cache (
          chat_id, type, title, username, member_count, access_hash,
          is_creator, is_admin, last_message_id, last_message_at,
          fetched_at, raw_json
        ) VALUES (
          $chat_id, $type, $title, $username, $member_count, $access_hash,
          $is_creator, $is_admin, $last_message_id, $last_message_at,
          $fetched_at, $raw_json
        )
      `)

      const now = Date.now()

      for (const chat of chats) {
        stmt.run({
          $chat_id: chat.chat_id,
          $type: chat.type,
          $title: chat.title ?? null,
          $username: chat.username ?? null,
          $member_count: chat.member_count ?? null,
          $access_hash: null,
          $is_creator: chat.is_creator ?? 0,
          $is_admin: chat.is_admin ?? 0,
          $last_message_id: null,
          $last_message_at: chat.last_message_at ?? null,
          $fetched_at: now,
          $raw_json: JSON.stringify(chat),
        })
      }
    },

    cleanup(): void {
      if (db) {
        db.close()
        db = null
      }
      if (cacheDb) {
        cacheDb.close()
        cacheDb = null
      }
      if (existsSync(dataDir)) {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },

    getCliOptions(): { env: Record<string, string> } {
      return {
        env: {
          TELEGRAM_SYNC_CLI_DATA_DIR: dataDir,
        },
      }
    },
  }
}

// ============================================================================
// Contacts Commands Tests
// ============================================================================

describe('E2E: Contacts Commands', () => {
  let env: ExtendedTestEnvironment

  beforeEach(() => {
    env = createExtendedTestEnvironment('contacts')
    env.initDatabase()
    env.initCacheDatabase()
    // Seed an active account (required for most commands)
    env.seedAccounts([
      { phone: '+1111111111', name: 'Test Account', is_active: true },
    ])
  })

  afterEach(() => {
    env.cleanup()
  })

  describe('contacts list', () => {
    it('should try to fetch from API when no contacts in cache', async () => {
      // When no cached contacts exist, the command tries to fetch from API
      // Since we don't have a real Telegram client, it fails with TELEGRAM_ERROR
      const result = await runCliFailure(
        ['contacts', 'list'],
        5, // TELEGRAM_ERROR exit code
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        error: {
          code: string
          message: string
        }
      }

      expect(response.success).toBe(false)
      expect(response.error.code).toBe('TELEGRAM_ERROR')
    })

    it('should return cached contacts', async () => {
      // Seed contacts in cache
      env.seedUsers([
        {
          user_id: '100',
          username: 'alice',
          first_name: 'Alice',
          last_name: 'Smith',
          phone: '+1234567890',
          is_contact: 1,
        },
        {
          user_id: '101',
          username: 'bob',
          first_name: 'Bob',
          last_name: 'Jones',
          phone: '+0987654321',
          is_contact: 1,
        },
        {
          user_id: '102',
          username: 'charlie',
          first_name: 'Charlie',
          is_contact: 1,
        },
      ])

      const result = await runCliSuccess(
        ['contacts', 'list'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{
            id: number
            firstName: string
            lastName: string | null
            username: string | null
            phone: string | null
          }>
          total: number
          source: string
          stale: boolean
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(3)
      expect(response.data.total).toBe(3)
      expect(response.data.source).toBe('cache')

      // Check first contact
      const alice = response.data.items.find((c) => c.username === 'alice')
      expect(alice).toBeDefined()
      expect(alice?.firstName).toBe('Alice')
      expect(alice?.lastName).toBe('Smith')
    })

    it('should respect limit and offset parameters', async () => {
      // Seed 5 contacts
      env.seedUsers([
        { user_id: '100', first_name: 'Contact1', is_contact: 1 },
        { user_id: '101', first_name: 'Contact2', is_contact: 1 },
        { user_id: '102', first_name: 'Contact3', is_contact: 1 },
        { user_id: '103', first_name: 'Contact4', is_contact: 1 },
        { user_id: '104', first_name: 'Contact5', is_contact: 1 },
      ])

      // Request with limit 2 and offset 1
      const result = await runCliSuccess(
        ['contacts', 'list', '--limit', '2', '--offset', '1'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ firstName: string }>
          total: number
          offset: number
          limit: number
          hasMore: boolean
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(2)
      expect(response.data.total).toBe(5)
      expect(response.data.offset).toBe(1)
      expect(response.data.limit).toBe(2)
      expect(response.data.hasMore).toBe(true)
    })

    it('should not return non-contact users', async () => {
      env.seedUsers([
        { user_id: '100', first_name: 'Contact', is_contact: 1 },
        { user_id: '101', first_name: 'NotContact', is_contact: 0 },
        { user_id: '102', first_name: 'Bot', is_contact: 0, is_bot: 1 },
      ])

      const result = await runCliSuccess(
        ['contacts', 'list'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ firstName: string }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(1)
      expect(response.data.items[0]?.firstName).toBe('Contact')
    })

    it('should return contacts behind more than 1000 cached users', async () => {
      env.seedUsers([
        ...Array.from({ length: 1001 }, (_, i) => ({
          user_id: String(1000 + i),
          first_name: `Aaron ${i}`,
          is_contact: 0,
        })),
        { user_id: '9999', first_name: 'Zed', is_contact: 1 },
      ])

      const result = await runCliSuccess(
        ['contacts', 'list'],
        env.getCliOptions(),
      )

      expect(result.json).toMatchObject({
        success: true,
        data: { items: [{ firstName: 'Zed' }], total: 1 },
      })
    })
  })

  describe('contacts search', () => {
    beforeEach(() => {
      env.seedUsers([
        {
          user_id: '100',
          username: 'alice_wonder',
          first_name: 'Alice',
          last_name: 'Wonderland',
          is_contact: 1,
        },
        {
          user_id: '101',
          username: 'bob_builder',
          first_name: 'Bob',
          last_name: 'Builder',
          is_contact: 1,
        },
        {
          user_id: '102',
          username: 'alice_springs',
          first_name: 'Alice',
          last_name: 'Springs',
          is_contact: 1,
        },
      ])
    })

    it('should search contacts by first name', async () => {
      const result = await runCliSuccess(
        ['contacts', 'search', '--query', 'Alice'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          query: string
          results: Array<{ firstName: string; username: string | null }>
          total: number
          source: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.query).toBe('Alice')
      expect(response.data.results).toHaveLength(2)
      expect(response.data.source).toBe('cache')

      const names = response.data.results.map((r) => r.firstName)
      expect(names).toContain('Alice')
    })

    it('should search contacts by username', async () => {
      const result = await runCliSuccess(
        ['contacts', 'search', '--query', 'bob_builder'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          results: Array<{ username: string | null }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.results).toHaveLength(1)
      expect(response.data.results[0]?.username).toBe('bob_builder')
    })

    it('should try to fetch from API when no matching results in cache', async () => {
      // When no matching results exist in cache, the command tries to fetch from API
      // Since we don't have a real Telegram client, it fails with TELEGRAM_ERROR
      const result = await runCliFailure(
        ['contacts', 'search', '--query', 'nonexistent'],
        5, // TELEGRAM_ERROR exit code
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        error: {
          code: string
          message: string
        }
      }

      expect(response.success).toBe(false)
      expect(response.error.code).toBe('TELEGRAM_ERROR')
    })

    it('should respect limit parameter', async () => {
      const result = await runCliSuccess(
        ['contacts', 'search', '--query', 'alice', '--limit', '1'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          results: unknown[]
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.results).toHaveLength(1)
    })
  })

  describe('contacts get', () => {
    beforeEach(() => {
      env.seedUsers([
        {
          user_id: '12345',
          username: 'testuser',
          first_name: 'Test',
          last_name: 'User',
          phone: '+1234567890',
          is_contact: 1,
          is_bot: 0,
          is_premium: 1,
        },
      ])
    })

    it('should get contact by user ID', async () => {
      const result = await runCliSuccess(
        ['contacts', 'get', '--id', '12345'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          id: number
          firstName: string
          lastName: string | null
          username: string | null
          phone: string | null
          isBot: boolean
          isPremium: boolean
          isContact: boolean
          source: string
          stale: boolean
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.id).toBe(12345)
      expect(response.data.firstName).toBe('Test')
      expect(response.data.lastName).toBe('User')
      expect(response.data.username).toBe('testuser')
      expect(response.data.source).toBe('cache')
    })

    it('should get contact by username', async () => {
      const result = await runCliSuccess(
        ['contacts', 'get', '--id', '@testuser'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          id: number
          username: string | null
          source: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.username).toBe('testuser')
      expect(response.data.source).toBe('cache')
    })

    it('should get contact by username without @ prefix', async () => {
      const result = await runCliSuccess(
        ['contacts', 'get', '--id', 'testuser'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          username: string | null
          source: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.username).toBe('testuser')
    })
  })
})

// ============================================================================
// Chats Commands Tests
// ============================================================================

describe('E2E: Chats Commands', () => {
  let env: ExtendedTestEnvironment

  beforeEach(() => {
    env = createExtendedTestEnvironment('chats')
    env.initDatabase()
    env.initCacheDatabase()
    // Seed an active account
    env.seedAccounts([
      { phone: '+1111111111', name: 'Test Account', is_active: true },
    ])
  })

  afterEach(() => {
    env.cleanup()
  })

  describe('chats list', () => {
    it('should try to fetch from API when no chats in cache', async () => {
      // When no cached chats exist, the command tries to fetch from API
      // Since we don't have a real Telegram client, it fails with TELEGRAM_ERROR
      const result = await runCliFailure(
        ['chats', 'list'],
        5, // TELEGRAM_ERROR exit code
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        error: {
          code: string
          message: string
        }
      }

      expect(response.success).toBe(false)
      expect(response.error.code).toBe('TELEGRAM_ERROR')
    })

    it('should return cached chats', async () => {
      const now = Date.now()

      env.seedChats([
        {
          chat_id: '100',
          type: 'private',
          title: 'Alice',
          username: 'alice',
          last_message_at: now - 1000,
        },
        {
          chat_id: '-200',
          type: 'group',
          title: 'Friends Group',
          member_count: 15,
          last_message_at: now - 2000,
        },
        {
          chat_id: '-1000000000300',
          type: 'channel',
          title: 'News Channel',
          username: 'newschannel',
          member_count: 1000,
          last_message_at: now - 3000,
        },
      ])

      const result = await runCliSuccess(['chats', 'list'], env.getCliOptions())

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{
            id: number
            type: string
            title: string
            username: string | null
            memberCount: number | null
          }>
          total: number
          source: string
          stale: boolean
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(3)
      expect(response.data.total).toBe(3)
      expect(response.data.source).toBe('cache')

      // Should be sorted by last_message_at descending
      expect(response.data.items[0]?.title).toBe('Alice')
      expect(response.data.items[1]?.title).toBe('Friends Group')
      expect(response.data.items[2]?.title).toBe('News Channel')
    })

    it('should filter by chat type - private', async () => {
      env.seedChats([
        { chat_id: '100', type: 'private', title: 'Private Chat' },
        { chat_id: '-200', type: 'group', title: 'Group Chat' },
        { chat_id: '-1000000000300', type: 'channel', title: 'Channel' },
      ])

      const result = await runCliSuccess(
        ['chats', 'list', '--type', 'private'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ type: string; title: string }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(1)
      expect(response.data.items[0]?.type).toBe('private')
      expect(response.data.items[0]?.title).toBe('Private Chat')
    })

    it('should filter by chat type - group', async () => {
      env.seedChats([
        { chat_id: '100', type: 'private', title: 'Private Chat' },
        { chat_id: '-200', type: 'group', title: 'Group Chat' },
        {
          chat_id: '-1000000000300',
          type: 'supergroup',
          title: 'Supergroup Chat',
        },
      ])

      const result = await runCliSuccess(
        ['chats', 'list', '--type', 'group'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ type: string; title: string }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(1)
      expect(response.data.items[0]?.type).toBe('group')
    })

    it('should filter by chat type - channel', async () => {
      env.seedChats([
        { chat_id: '-1000000000100', type: 'channel', title: 'Channel 1' },
        { chat_id: '-1000000000200', type: 'channel', title: 'Channel 2' },
        { chat_id: '-300', type: 'group', title: 'Group Chat' },
      ])

      const result = await runCliSuccess(
        ['chats', 'list', '--type', 'channel'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ type: string }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(2)
      expect(response.data.items.every((c) => c.type === 'channel')).toBe(true)
    })

    it('should filter by chat type - supergroup', async () => {
      env.seedChats([
        {
          chat_id: '-1000000000100',
          type: 'supergroup',
          title: 'Supergroup 1',
        },
        { chat_id: '-200', type: 'group', title: 'Group Chat' },
        {
          chat_id: '-1000000000300',
          type: 'supergroup',
          title: 'Supergroup 2',
        },
      ])

      const result = await runCliSuccess(
        ['chats', 'list', '--type', 'supergroup'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ type: string }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(2)
      expect(response.data.items.every((c) => c.type === 'supergroup')).toBe(
        true,
      )
    })

    it('should fail for invalid chat type', async () => {
      const result = await runCliFailure(
        ['chats', 'list', '--type', 'invalid'],
        undefined, // Any non-zero exit code
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        error: { code: string; message: string }
      }

      expect(response.success).toBe(false)
      expect(response.error.code).toBe('INVALID_ARGS')
      expect(response.error.message).toContain('invalid')
    })

    it('should respect limit and offset parameters', async () => {
      const now = Date.now()

      env.seedChats([
        {
          chat_id: '100',
          type: 'private',
          title: 'Chat1',
          last_message_at: now - 1000,
        },
        {
          chat_id: '101',
          type: 'private',
          title: 'Chat2',
          last_message_at: now - 2000,
        },
        {
          chat_id: '102',
          type: 'private',
          title: 'Chat3',
          last_message_at: now - 3000,
        },
        {
          chat_id: '103',
          type: 'private',
          title: 'Chat4',
          last_message_at: now - 4000,
        },
        {
          chat_id: '104',
          type: 'private',
          title: 'Chat5',
          last_message_at: now - 5000,
        },
      ])

      const result = await runCliSuccess(
        ['chats', 'list', '--limit', '2', '--offset', '2'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          items: Array<{ title: string }>
          total: number
          offset: number
          limit: number
          hasMore: boolean
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.items).toHaveLength(2)
      expect(response.data.total).toBe(5)
      expect(response.data.offset).toBe(2)
      expect(response.data.limit).toBe(2)
      expect(response.data.hasMore).toBe(true)

      // Should get Chat3 and Chat4 (offset 2, sorted by last_message_at desc)
      expect(response.data.items[0]?.title).toBe('Chat3')
      expect(response.data.items[1]?.title).toBe('Chat4')
    })
  })

  describe('chats search', () => {
    beforeEach(() => {
      env.seedChats([
        {
          chat_id: '100',
          type: 'private',
          title: 'Alice Smith',
          username: 'alice',
        },
        { chat_id: '-200', type: 'group', title: 'Developers Club' },
        {
          chat_id: '-1000000000300',
          type: 'channel',
          title: 'Tech News',
          username: 'technews',
        },
        {
          chat_id: '-1000000000400',
          type: 'supergroup',
          title: 'Alice Fans Club',
        },
      ])
    })

    it('should search chats by title', async () => {
      const result = await runCliSuccess(
        ['chats', 'search', '--query', 'Alice'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          query: string
          results: Array<{ title: string }>
          total: number
          source: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.query).toBe('Alice')
      expect(response.data.results).toHaveLength(2)
      expect(response.data.source).toBe('cache')

      const titles = response.data.results.map((r) => r.title)
      expect(titles).toContain('Alice Smith')
      expect(titles).toContain('Alice Fans Club')
    })

    it('should search chats by username', async () => {
      const result = await runCliSuccess(
        ['chats', 'search', '--query', 'technews'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          results: Array<{ username: string | null; title: string }>
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.results).toHaveLength(1)
      expect(response.data.results[0]?.username).toBe('technews')
      expect(response.data.results[0]?.title).toBe('Tech News')
    })

    it('should return empty results for non-matching query', async () => {
      const result = await runCliSuccess(
        ['chats', 'search', '--query', 'nonexistent'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          results: unknown[]
          total: number
          message?: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.results).toHaveLength(0)
      expect(response.data.total).toBe(0)
    })

    it('should respect limit parameter', async () => {
      // Seed more chats with similar names
      env.seedChats([
        { chat_id: '-500', type: 'group', title: 'Test Group 1' },
        { chat_id: '-501', type: 'group', title: 'Test Group 2' },
        { chat_id: '-502', type: 'group', title: 'Test Group 3' },
      ])

      const result = await runCliSuccess(
        ['chats', 'search', '--query', 'Test', '--limit', '2'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          results: unknown[]
          total: number
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.results).toHaveLength(2)
    })
  })

  describe('chats get', () => {
    beforeEach(() => {
      env.seedChats([
        {
          chat_id: '-1000000012345',
          type: 'channel',
          title: 'Test Channel',
          username: 'testchannel',
          member_count: 5000,
          is_creator: 0,
          is_admin: 1,
        },
        {
          chat_id: '67890',
          type: 'private',
          title: 'John Doe',
          username: 'johndoe',
        },
      ])
    })

    type ChatData = {
      id: number
      type: string
      title: string
      username: string | null
      memberCount: number | null
      isCreator: boolean
      isAdmin: boolean
      source: string
      stale: boolean
    }

    it('should get chat by the marked ID tg chats list prints', async () => {
      const result = await runCliSuccess(
        ['chats', 'get', '--id=-1000000012345'],
        env.getCliOptions(),
      )

      const response = result.json as { success: boolean; data: ChatData }

      expect(response.success).toBe(true)
      expect(response.data.id).toBe(-1000000012345)
      expect(response.data.type).toBe('channel')
      expect(response.data.title).toBe('Test Channel')
      expect(response.data.username).toBe('testchannel')
      expect(response.data.memberCount).toBe(5000)
      expect(response.data.isAdmin).toBe(true)
      expect(response.data.source).toBe('cache')
    })

    it('should get chat by the bare ID that 0.2.0 printed', async () => {
      const bare = await runCliSuccess(
        ['chats', 'get', '--id', '12345'],
        env.getCliOptions(),
      )
      const marked = await runCliSuccess(
        ['chats', 'get', '--id', '-1000000012345'],
        env.getCliOptions(),
      )

      expect((bare.json as { data: ChatData }).data).toEqual(
        (marked.json as { data: ChatData }).data,
      )
    })

    it('should get chat by username', async () => {
      const result = await runCliSuccess(
        ['chats', 'get', '--id', '@johndoe'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          type: string
          title: string
          username: string | null
          source: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.type).toBe('private')
      expect(response.data.title).toBe('John Doe')
      expect(response.data.username).toBe('johndoe')
      expect(response.data.source).toBe('cache')
    })

    it('should get chat by username without @ prefix', async () => {
      const result = await runCliSuccess(
        ['chats', 'get', '--id', 'testchannel'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          username: string | null
          source: string
        }
      }

      expect(response.success).toBe(true)
      expect(response.data.username).toBe('testchannel')
    })
  })
})

// ============================================================================
// Cross-command Integration Tests
// ============================================================================

describe('E2E: Cross-command Integration', () => {
  let env: ExtendedTestEnvironment

  beforeEach(() => {
    env = createExtendedTestEnvironment('integration')
    env.initDatabase()
    env.initCacheDatabase()
    env.seedAccounts([
      { phone: '+1111111111', name: 'Test Account', is_active: true },
    ])
  })

  afterEach(() => {
    env.cleanup()
  })

  it('should handle user as both contact and private chat', async () => {
    // Seed user in users_cache (contact)
    env.seedUsers([
      {
        user_id: '12345',
        username: 'testuser',
        first_name: 'Test',
        last_name: 'User',
        is_contact: 1,
      },
    ])

    // Seed same user as private chat
    env.seedChats([
      {
        chat_id: '12345',
        type: 'private',
        title: 'Test User',
        username: 'testuser',
      },
    ])

    // Get via contacts
    const contactResult = await runCliSuccess(
      ['contacts', 'get', '--id', '@testuser'],
      env.getCliOptions(),
    )

    const contactResponse = contactResult.json as {
      success: boolean
      data: { id: number; firstName: string }
    }

    expect(contactResponse.success).toBe(true)
    expect(contactResponse.data.id).toBe(12345)
    expect(contactResponse.data.firstName).toBe('Test')

    // Get via chats
    const chatResult = await runCliSuccess(
      ['chats', 'get', '--id', '@testuser'],
      env.getCliOptions(),
    )

    const chatResponse = chatResult.json as {
      success: boolean
      data: { id: number; type: string; title: string }
    }

    expect(chatResponse.success).toBe(true)
    expect(chatResponse.data.id).toBe(12345)
    expect(chatResponse.data.type).toBe('private')
  })

  it('should handle multiple chat types in a single environment', async () => {
    env.seedChats([
      { chat_id: '1', type: 'private', title: 'DM 1' },
      { chat_id: '2', type: 'private', title: 'DM 2' },
      { chat_id: '-3', type: 'group', title: 'Group 1' },
      { chat_id: '-1000000000004', type: 'supergroup', title: 'Supergroup 1' },
      { chat_id: '-1000000000005', type: 'channel', title: 'Channel 1' },
    ])

    // Count all chats
    const allResult = await runCliSuccess(
      ['chats', 'list'],
      env.getCliOptions(),
    )

    const allResponse = allResult.json as {
      success: boolean
      data: { total: number }
    }
    expect(allResponse.data.total).toBe(5)

    // Count by type
    const privateResult = await runCliSuccess(
      ['chats', 'list', '--type', 'private'],
      env.getCliOptions(),
    )
    const groupResult = await runCliSuccess(
      ['chats', 'list', '--type', 'group'],
      env.getCliOptions(),
    )
    const supergroupResult = await runCliSuccess(
      ['chats', 'list', '--type', 'supergroup'],
      env.getCliOptions(),
    )
    const channelResult = await runCliSuccess(
      ['chats', 'list', '--type', 'channel'],
      env.getCliOptions(),
    )

    type ChatsListPayload = { data: { total: number } }
    const privatePayload = privateResult.json as ChatsListPayload
    const groupPayload = groupResult.json as ChatsListPayload
    const supergroupPayload = supergroupResult.json as ChatsListPayload
    const channelPayload = channelResult.json as ChatsListPayload

    expect(privatePayload.data.total).toBe(2)
    expect(groupPayload.data.total).toBe(1)
    expect(supergroupPayload.data.total).toBe(1)
    expect(channelPayload.data.total).toBe(1)
  })
})
