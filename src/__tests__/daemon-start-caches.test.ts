/**
 * Daemon start with one cache per account: an account whose cache doesn't
 * open is left out, a shared cache that can't move stops the start, and
 * every account that ran is marked stopped on the way out
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { CacheUnavailableError } from '../db/cache-layout'
import { createDaemonStatusService } from '../db/daemon-status'
import { createAccountCacheDb } from './helpers/daemon-runtime'
import {
  createFakeAccountsDb,
  mockDbModule,
  testAccount,
} from './helpers/db-mock'

const accounts = () =>
  createFakeAccountsDb([
    testAccount({ id: 1 }),
    testAccount({ id: 2, phone: '+15550000002', is_active: 0 }),
  ])

const caches = new Map<number, Database>()
const brokenCaches = new Set<number>()
let layoutError: Error | null = null

mock.module('../db', () => ({
  ...mockDbModule({
    cacheFor: (accountId) => {
      if (brokenCaches.has(accountId)) {
        throw new CacheUnavailableError(
          'owner_mismatch',
          `accounts/${accountId}/cache.db`,
        )
      }
      const cache = caches.get(accountId)
      if (!cache) throw new Error(`No cache for account ${accountId}`)
      return cache
    },
    accountsDb: accounts(),
  }),
  ensureCacheLayout: () => {
    if (layoutError) throw layoutError
    return { state: 'none' as const }
  },
}))

const connected: number[] = []
mock.module('../daemon/daemon-accounts', () => ({
  // No account connects, so the start ends right after it
  connectAccount: async (_ctx: unknown, accountId: number) => {
    connected.push(accountId)
    return false
  },
  disconnectAllAccounts: async () => {},
  setupSignalHandlers: () => {},
  attemptReconnect: async () => {},
  scheduleReconnect: () => {},
}))

const { createDaemon } = await import('../daemon/daemon')
const { DaemonExitCode } = await import('../daemon/types')

const tempDir = join(
  process.cwd(),
  '.tmp',
  `daemon-start-caches-${process.pid}`,
)
const pidPath = join(tempDir, 'daemon.pid')

const statusOf = (accountId: number) =>
  createDaemonStatusService(caches.get(accountId)!).getAll()

beforeEach(() => {
  mkdirSync(tempDir, { recursive: true })
  caches.set(1, createAccountCacheDb())
  caches.set(2, createAccountCacheDb())
  connected.length = 0
})

afterEach(() => {
  for (const cache of caches.values()) cache.close()
  caches.clear()
  brokenCaches.clear()
  layoutError = null
  rmSync(tempDir, { recursive: true, force: true })
})

describe('daemon start with a cache per account', () => {
  it("connects only the accounts whose cache opened, and marks each one's cache stopped", async () => {
    brokenCaches.add(1)
    const daemon = createDaemon({ pidPath }, accounts())

    expect(await daemon.start()).toBe(DaemonExitCode.AllAccountsFailed)

    expect(connected).toEqual([2])
    expect(daemon.getStatus().accounts).toContainEqual(
      expect.objectContaining({
        id: 1,
        status: 'error',
        lastError: expect.stringContaining('another account'),
      }),
    )
    expect(statusOf(2)).toMatchObject({ daemon_status: 'stopped' })
    expect(statusOf(2).daemon_pid).toBeUndefined()
    expect(statusOf(1).daemon_status).toBeUndefined()
  })

  it('marks every account stopped when none connects', async () => {
    const daemon = createDaemon({ pidPath }, accounts())

    expect(await daemon.start()).toBe(DaemonExitCode.AllAccountsFailed)

    expect(connected).toEqual([1, 2])
    for (const accountId of [1, 2]) {
      expect(statusOf(accountId)).toMatchObject({
        daemon_status: 'stopped',
        connection_status: 'disconnected',
      })
    }
  })

  it('fails without connecting when no account has a cache it can open', async () => {
    brokenCaches.add(1)
    brokenCaches.add(2)
    const daemon = createDaemon({ pidPath }, accounts())

    expect(await daemon.start()).toBe(DaemonExitCode.AllAccountsFailed)
    expect(connected).toEqual([])
  })

  it('stops when the shared cache of an older version is still open', async () => {
    layoutError = new CacheUnavailableError('shared_cache_in_use', 'cache.db')
    const daemon = createDaemon({ pidPath }, accounts())

    expect(await daemon.start()).toBe(DaemonExitCode.Error)
    expect(connected).toEqual([])
    expect(statusOf(1)).toEqual({})
  })
})
