/**
 * The daemon's contacts sync (#8): when a check is due, what it sends and
 * what it writes. The fake client's `call` returns promises the test
 * resolves; `now` is injected, no timer runs.
 */
import type { Database } from 'bun:sqlite'
import { describe, expect, it, mock } from 'bun:test'
import { type RpcCallOptions, type TelegramClient, tl } from '@mtcute/bun'
import { CONTACTS_RETRY_MS, maybeSyncContacts } from '../daemon/daemon-contacts'
import {
  createDaemonRuntime,
  type DaemonContext,
  requestShutdown,
} from '../daemon/daemon-context'
import { DaemonStopError } from '../daemon/daemon-utils'
import type { AccountConnectionState } from '../daemon/types'
import {
  applyContactsSnapshot,
  contactsHash,
  getContactsSyncedAt,
} from '../db/contacts-sync'
import { createRateLimitsService } from '../db/rate-limits'
import { createUsersCache } from '../db/users-cache'
import { addAccountRuntime } from './helpers/daemon-runtime'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const WEEK = 7 * 24 * HOUR

function createLogger() {
  return {
    info: mock((_m: string) => {}),
    debug: mock((_m: string) => {}),
    warn: mock((_m: string) => {}),
    error: mock((_m: string) => {}),
  }
}

function createContext(): DaemonContext & {
  logger: ReturnType<typeof createLogger>
} {
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli/daemon.pid',
    verbosity: 'quiet',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 2,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: createLogger(),
    pidFile: {} as DaemonContext['pidFile'],
    state: { running: true, accounts: new Map(), shutdownRequested: false },
    accountsDb: {} as DaemonContext['accountsDb'],
    runtime: createDaemonRuntime(),
  }
}

interface PendingCall {
  request: { _: string; hash: tl.Long }
  params: RpcCallOptions
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

/** A client whose every call waits until the test settles it */
function fakeClient() {
  const calls: PendingCall[] = []
  const withParams = mock((params: RpcCallOptions) => ({
    call: (request: PendingCall['request']) =>
      new Promise((resolve, reject) => {
        calls.push({ request, params, resolve, reject })
      }),
  }))
  return { client: { withParams } as unknown as TelegramClient, calls }
}

function connect(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
  status: AccountConnectionState['status'] = 'connected',
): Database {
  const rt = addAccountRuntime(ctx, accountId)
  ctx.state.accounts.set(accountId, {
    accountId,
    phone: `+1555000000${accountId}`,
    name: null,
    status,
    client,
  })
  return rt.db
}

function contactsList(ids: number[]): tl.contacts.RawContacts {
  return {
    _: 'contacts.contacts',
    contacts: ids.map((userId) => ({ _: 'contact', userId, mutual: false })),
    savedCount: ids.length,
    users: ids.map(
      (id) =>
        ({
          _: 'user',
          id,
          firstName: `User ${id}`,
          contact: true,
        }) as tl.RawUser,
    ),
  }
}

const notModified = { _: 'contacts.contactsNotModified' }

function contactIds(db: Database): string[] {
  return createUsersCache(db)
    .getContacts()
    .map((u) => u.user_id)
    .sort()
}

describe('maybeSyncContacts', () => {
  it('fetches the full list with hash 0 when no list is recorded', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)

    const started = maybeSyncContacts(ctx, NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request._).toBe('contacts.getContacts')
    expect(calls[0]?.request.hash.toString()).toBe('0')
    expect(calls[0]?.params.abortSignal).toBe(ctx.runtime.shutdown.signal)

    calls[0]?.resolve(contactsList([1001, 1002]))
    await Promise.all(started)

    expect(contactIds(db)).toEqual(['1001', '1002'])
    expect(getContactsSyncedAt(db)).toBe(NOW)
    expect(ctx.logger.info).toHaveBeenCalledWith(
      '[Account 1] Contacts synced: 2 (0 no longer contacts)',
    )
  })

  it('makes no call while the list is younger than the peer TTL', () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - WEEK + 1)

    expect(maybeSyncContacts(ctx, NOW)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('checks an older list with the cached hash; unchanged moves only the check time', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - WEEK)
    const user = db
      .query("SELECT * FROM users_cache WHERE user_id = '1001'")
      .get()

    const started = maybeSyncContacts(ctx, NOW)
    expect(calls[0]?.request.hash.toString()).toBe(contactsHash(db).toString())
    expect(calls[0]?.request.hash.toString()).not.toBe('0')
    calls[0]?.resolve(notModified)
    await Promise.all(started)

    expect(getContactsSyncedAt(db)).toBe(NOW)
    expect(
      db.query("SELECT * FROM users_cache WHERE user_id = '1001'").get(),
    ).toEqual(user)
  })

  it('respects a custom peer TTL', () => {
    const ctx = createContext()
    ctx.runtime.contacts.peersTtlMs = HOUR
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - HOUR + 1)

    maybeSyncContacts(ctx, NOW)
    expect(calls).toHaveLength(0)
    maybeSyncContacts(ctx, NOW + 1)
    expect(calls).toHaveLength(1)
  })

  it('checks before the TTL when an update asked for it', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - HOUR)
    ctx.runtime.contacts.checkAt.set(1, NOW + 10)

    maybeSyncContacts(ctx, NOW)
    expect(calls).toHaveLength(0)

    const started = maybeSyncContacts(ctx, NOW + 10)
    expect(calls).toHaveLength(1)
    calls[0]?.resolve(notModified)
    await Promise.all(started)
    expect(ctx.runtime.contacts.checkAt.has(1)).toBe(false)
  })

  it('skips an account that is not connected', () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    connect(ctx, 1, client, 'reconnecting')

    expect(maybeSyncContacts(ctx, NOW)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('makes no second call while the first one runs', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    connect(ctx, 1, client)

    const started = maybeSyncContacts(ctx, NOW)
    expect(maybeSyncContacts(ctx, NOW + 1)).toHaveLength(0)
    expect(calls).toHaveLength(1)

    calls[0]?.resolve(contactsList([]))
    await Promise.all(started)
    expect(ctx.runtime.contacts.inFlight.size).toBe(0)
  })

  it("writes each account's list only to its own cache", async () => {
    const ctx = createContext()
    const first = fakeClient()
    const second = fakeClient()
    const firstDb = connect(ctx, 1, first.client)
    const secondDb = connect(ctx, 2, second.client)

    const started = maybeSyncContacts(ctx, NOW)
    first.calls[0]?.resolve(contactsList([1001]))
    second.calls[0]?.resolve(contactsList([2001, 2002]))
    await Promise.all(started)

    expect(contactIds(firstDb)).toEqual(['1001'])
    expect(contactIds(secondDb)).toEqual(['2001', '2002'])
  })

  it('waits 15 minutes after a failed check, keeping the check time', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - WEEK)

    const started = maybeSyncContacts(ctx, NOW)
    calls[0]?.reject(new Error('connection reset'))
    await Promise.all(started)

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[Account 1] Contacts check failed'),
    )
    expect(getContactsSyncedAt(db)).toBe(NOW - WEEK)
    expect(ctx.runtime.contacts.retryAt.get(1)).toBe(NOW + CONTACTS_RETRY_MS)

    maybeSyncContacts(ctx, NOW + CONTACTS_RETRY_MS - 1)
    expect(calls).toHaveLength(1)
    maybeSyncContacts(ctx, NOW + CONTACTS_RETRY_MS)
    expect(calls).toHaveLength(2)
  })

  it('records a FLOOD_WAIT and waits it out', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)

    const started = maybeSyncContacts(ctx, NOW)
    calls[0]?.reject(
      tl.RpcError.fromTl({
        _: 'rpc_error',
        errorCode: 420,
        errorMessage: 'FLOOD_WAIT_600',
      }),
    )
    await Promise.all(started)

    expect(createRateLimitsService(db).isBlocked('contacts.getContacts')).toBe(
      true,
    )
    expect(ctx.runtime.contacts.retryAt.get(1)).toBe(NOW + 600_000)
    expect(getContactsSyncedAt(db)).toBeNull()
  })

  it('makes no call while the method is blocked by a FLOOD_WAIT', () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    createRateLimitsService(db).setFloodWait('contacts.getContacts', 600)

    expect(maybeSyncContacts(ctx, NOW)).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('writes nothing when the daemon stops during the call', async () => {
    for (const settle of ['resolve', 'reject'] as const) {
      const ctx = createContext()
      const { client, calls } = fakeClient()
      const db = connect(ctx, 1, client)

      const started = maybeSyncContacts(ctx, NOW)
      requestShutdown(ctx)
      if (settle === 'resolve') calls[0]?.resolve(contactsList([1001]))
      else calls[0]?.reject(new DaemonStopError())
      await Promise.all(started)

      expect(getContactsSyncedAt(db)).toBeNull()
      expect(contactIds(db)).toEqual([])
      expect(ctx.logger.warn).not.toHaveBeenCalled()
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        '[Account 1] Contacts check ended by the daemon stop',
      )
      expect(maybeSyncContacts(ctx, NOW + WEEK)).toHaveLength(0)
    }
  })
})
