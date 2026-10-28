/**
 * A stand-in for `src/db` in unit tests that `mock.module('../db', …)`:
 * accounts in memory, and each account's cache from a callback, so a test
 * can give every account its own in-memory database.
 */
import { Database } from 'bun:sqlite'
import {
  accountMediaPath,
  CacheUnavailableError,
  isCacheUnavailableError,
} from '../../db/cache-layout'
import type { AccountsDbInterface } from '../../db/index'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'
import type { Account } from '../../types'

export function testAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    phone: '+15550000001',
    user_id: null,
    name: 'Test User',
    username: null,
    label: null,
    session_data: '',
    is_active: 1,
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  }
}

/** An in-memory AccountsDbInterface over the given accounts */
export function createFakeAccountsDb(
  seed: Account[] = [testAccount()],
): AccountsDbInterface {
  const accounts = new Map(seed.map((account) => [account.id, { ...account }]))
  let nextId = Math.max(0, ...accounts.keys()) + 1
  const all = () => [...accounts.values()].sort((a, b) => a.id - b.id)

  return {
    getAll: () => all(),
    getById: (id) => accounts.get(id) ?? null,
    getByPhone: (phone) => all().find((a) => a.phone === phone) ?? null,
    getByUserId: (userId) => all().find((a) => a.user_id === userId) ?? null,
    getByUsername: (username) =>
      all().find(
        (a) => a.username === username.replace(/^@/, '').toLowerCase(),
      ) ?? null,
    getAllByLabel: (label) => all().filter((a) => a.label === label.trim()),
    getActive: () => all().find((a) => a.is_active === 1) ?? null,
    create(data) {
      const account = testAccount({
        id: nextId++,
        phone: data.phone,
        user_id: data.user_id ?? null,
        name: data.name ?? null,
        username: data.username ?? null,
        label: data.label ?? null,
        session_data: data.session_data ?? '',
        is_active: data.is_active ? 1 : 0,
      })
      accounts.set(account.id, account)
      return account
    },
    update(id, data) {
      const current = accounts.get(id)
      if (!current) return null
      const next = { ...current }
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined) {
          ;(next as Record<string, unknown>)[key] = value
        }
      }
      accounts.set(id, next)
      return next
    },
    updateSession(id, sessionData) {
      const current = accounts.get(id)
      if (current) current.session_data = sessionData
    },
    setActive(id) {
      for (const account of accounts.values()) {
        account.is_active = account.id === id ? 1 : 0
      }
    },
    delete: (id) => accounts.delete(id),
    count: () => accounts.size,
  }
}

/**
 * The exports of `src/db` that commands and the daemon use. `cacheFor`
 * returns the account's cache; it is called on every lookup, so a test can
 * swap databases between cases.
 */
export function mockDbModule(options: {
  cacheFor: (accountId: number) => Database
  accountsDb?: AccountsDbInterface | (() => AccountsDbInterface)
}) {
  const defaultAccounts = createFakeAccountsDb()
  const accounts = () =>
    typeof options.accountsDb === 'function'
      ? options.accountsDb()
      : (options.accountsDb ?? defaultAccounts)
  const accountsDb = new Proxy({} as AccountsDbInterface, {
    get: (_target, key) => {
      const target = accounts() as unknown as Record<string | symbol, unknown>
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const requireAccount = (accountId: number) => {
    if (!accounts().getById(accountId)) {
      throw new Error(`Account with ID ${accountId} not found`)
    }
    return options.cacheFor(accountId)
  }

  return {
    accountsDb,
    getAccountCacheDb: requireAccount,
    openExistingAccountCacheDb: requireAccount,
    openReadOnlyAccountCacheDb: requireAccount,
    closeAccountCacheDbs: () => {},
    ensureCacheLayout: () => ({ state: 'none' as const }),
    createSchemaOnlyDb: () => {
      const db = new Database(':memory:')
      initCacheSchema(db)
      initSyncSchema(db)
      return db
    },
    getDataDir: () => process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? '',
    getAccountMediaDir: (accountId: number) =>
      accountMediaPath(process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? '', accountId),
    getLegacyCachePath: () =>
      `${process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? ''}/cache.db`,
    listSharedCaches: () => [],
    CacheUnavailableError,
    isCacheUnavailableError,
  }
}
