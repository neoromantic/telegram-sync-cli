/**
 * Daemon start with one cache per account: an account whose cache doesn't
 * open is left out, a shared cache that can't move stops the start, and
 * every account that ran is marked stopped on the way out
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TelegramClient } from '@mtcute/bun'

import type { DaemonContext } from '../daemon/daemon-context'
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
/** Accounts that connect; by default none does, so the start ends there */
const connecting = new Set<number>()
mock.module('../daemon/daemon-accounts', () => ({
  connectAccount: async (
    ctx: DaemonContext,
    accountId: number,
    phone: string,
    name: string | null,
  ) => {
    connected.push(accountId)
    // As the real one: a failed connect leaves the account in error
    const ok = connecting.has(accountId)
    ctx.state.accounts.set(accountId, {
      accountId,
      phone,
      name,
      status: ok ? 'connected' : 'error',
      ...(ok ? { client: {} as TelegramClient } : { lastError: 'timeout' }),
    })
    return ok
  },
  disconnectAllAccounts: async () => {},
  setupSignalHandlers: () => {},
  attemptReconnect: async () => {},
  scheduleReconnect: () => {},
}))

/** Runs as the dialog pass, after the connections */
let onDialogPass: (() => void) | null = null
mock.module('../daemon/daemon-bootstrap', () => ({
  bootstrapDialogs: async () => onDialogPass?.(),
  refreshDialogsAfterReconnect: async () => {},
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
  connecting.clear()
  onDialogPass = null
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

  it("writes each account's connection before the dialog pass", async () => {
    // Account 1's rows from a run that crashed: connected, a full queue
    const previous = createDaemonStatusService(caches.get(1)!)
    previous.setDaemonRunning(1111, '0.3.9')
    previous.writeTick({
      connectionStatus: 'connected',
      lastError: null,
      messagesSynced: 40,
      pendingJobs: 7,
      runningJobs: 1,
    })
    connecting.add(2)
    const daemon = createDaemon({ pidPath }, accounts())
    const seen: Record<number, Record<string, string>> = {}
    onDialogPass = () => {
      seen[1] = statusOf(1)
      seen[2] = statusOf(2)
      daemon.stop()
    }

    expect(await daemon.start()).toBe(DaemonExitCode.Success)

    const pid = String(process.pid)
    expect(seen[1]).toMatchObject({
      daemon_pid: pid,
      connection_status: 'error',
      pending_jobs: '0',
      running_jobs: '0',
    })
    expect(seen[2]).toMatchObject({
      daemon_pid: pid,
      connection_status: 'connected',
      pending_jobs: '0',
    })
    expect(statusOf(2)).toMatchObject({ daemon_status: 'stopped' })
  })

  it('stops when the shared cache of an older version is still open', async () => {
    layoutError = new CacheUnavailableError('shared_cache_in_use', 'cache.db')
    const daemon = createDaemon({ pidPath }, accounts())

    expect(await daemon.start()).toBe(DaemonExitCode.Error)
    expect(connected).toEqual([])
    expect(statusOf(1)).toEqual({})
  })
})
