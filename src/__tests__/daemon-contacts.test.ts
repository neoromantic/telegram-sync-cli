/**
 * The daemon's contacts sync (#8): when a check is due, what it sends and
 * what it writes. The fake client's `call` returns promises the test
 * resolves; `now` is injected, no timer runs.
 */
import type { Database } from 'bun:sqlite'
import { describe, expect, it, mock } from 'bun:test'
import { join } from 'node:path'
import {
  PeersIndex,
  RawUpdateInfo,
  type RpcCallOptions,
  type TelegramClient,
  tl,
} from '@mtcute/bun'
import {
  CONTACTS_HINT_DELAY_MS,
  CONTACTS_RETRY_MS,
  handleContactRawUpdate,
  loadContactsTtl,
  maybeSyncContacts,
  requestContactsCheckNow,
} from '../daemon/daemon-contacts'
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
import { getDefaultCacheConfig } from '../db/types'
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

  it('checks a fresh list once after a start or reconnect asked for it', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - HOUR)

    requestContactsCheckNow(ctx, 1, NOW)
    const started = maybeSyncContacts(ctx, NOW)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request.hash.toString()).toBe(contactsHash(db).toString())
    calls[0]?.resolve(notModified)
    await Promise.all(started)

    expect(maybeSyncContacts(ctx, NOW + 1)).toHaveLength(0)
    expect(calls).toHaveLength(1)
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

  it('checks at once after a reconnect, even after a failed check', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    applyContactsSnapshot(db, contactsList([1001]), NOW - WEEK)

    const started = maybeSyncContacts(ctx, NOW)
    // The connection drops: the reconnect closes the client and fails the call
    const accountState = ctx.state.accounts.get(1)
    if (accountState) accountState.status = 'reconnecting'
    calls[0]?.reject(new Error('connection closed'))
    await Promise.all(started)
    expect(ctx.logger.warn).not.toHaveBeenCalled()

    if (accountState) accountState.status = 'connected'
    requestContactsCheckNow(ctx, 1, NOW + 1000)
    maybeSyncContacts(ctx, NOW + 1000)
    expect(calls).toHaveLength(2)
  })

  it('keeps a FLOOD_WAIT through a reconnect', () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)
    createRateLimitsService(db).setFloodWait('contacts.getContacts', 600)
    ctx.runtime.contacts.retryAt.set(1, NOW + 600_000)

    requestContactsCheckNow(ctx, 1, NOW)
    expect(maybeSyncContacts(ctx, NOW)).toHaveLength(0)
    expect(calls).toHaveLength(0)
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

describe('handleContactRawUpdate', () => {
  const USER = 4242

  function fullUser(contact: boolean, extra: Partial<tl.RawUser> = {}) {
    return {
      _: 'user',
      id: USER,
      firstName: 'Robin',
      contact,
      ...extra,
    } as tl.RawUser
  }

  function peerSettings(users: tl.TypeUser[] = []): RawUpdateInfo {
    return new RawUpdateInfo(
      {
        _: 'updatePeerSettings',
        peer: { _: 'peerUser', userId: USER },
        settings: { _: 'peerSettings' },
      },
      PeersIndex.from({ users }),
    )
  }

  function userUpdate(users: tl.TypeUser[] = []): RawUpdateInfo {
    return new RawUpdateInfo(
      { _: 'updateUser', userId: USER },
      PeersIndex.from({ users }),
    )
  }

  function cachedRow(db: Database) {
    return db
      .query('SELECT is_contact, updated_at FROM users_cache WHERE user_id = ?')
      .get(String(USER)) as { is_contact: number; updated_at: number } | null
  }

  function setup() {
    const ctx = createContext()
    const db = addAccountRuntime(ctx, 1).db
    return { ctx, db }
  }

  function seed(db: Database, isContact: boolean) {
    createUsersCache(db).upsert({
      user_id: String(USER),
      first_name: 'Robin',
      is_contact: isContact ? 1 : 0,
      fetched_at: 1000,
      raw_json: '{}',
    })
  }

  it('marks a user who became a contact, creating the row', () => {
    const { ctx, db } = setup()
    handleContactRawUpdate(ctx, 1, db, peerSettings([fullUser(true)]), NOW)
    expect(cachedRow(db)?.is_contact).toBe(1)

    // An existing non-contact row is marked too
    const other = setup()
    seed(other.db, false)
    handleContactRawUpdate(
      other.ctx,
      1,
      other.db,
      peerSettings([fullUser(true)]),
      NOW,
    )
    expect(cachedRow(other.db)?.is_contact).toBe(1)
  })

  it('unmarks a cached contact that updateUser says is no longer one', () => {
    const { ctx, db } = setup()
    seed(db, true)
    handleContactRawUpdate(ctx, 1, db, userUpdate([fullUser(false)]), NOW)
    expect(cachedRow(db)?.is_contact).toBe(0)
  })

  it('adds no row for a non-contact the cache does not have', () => {
    const { ctx, db } = setup()
    handleContactRawUpdate(ctx, 1, db, userUpdate([fullUser(false)]), NOW)
    expect(cachedRow(db)).toBeNull()
    expect(ctx.runtime.contacts.checkAt.size).toBe(0)
  })

  it('writes nothing when the flag is unchanged', () => {
    const { ctx, db } = setup()
    seed(db, true)
    const before = cachedRow(db)
    handleContactRawUpdate(ctx, 1, db, peerSettings([fullUser(true)]), NOW)
    expect(cachedRow(db)).toEqual(before)
  })

  it('asks for one hash check when the update has no full user', () => {
    const { ctx, db } = setup()
    seed(db, true)
    const before = cachedRow(db)

    handleContactRawUpdate(ctx, 1, db, userUpdate(), NOW)
    expect(ctx.runtime.contacts.checkAt.get(1)).toBe(
      NOW + CONTACTS_HINT_DELAY_MS,
    )

    // A min user is no better; a second hint keeps the first time
    handleContactRawUpdate(
      ctx,
      1,
      db,
      peerSettings([fullUser(false, { min: true })]),
      NOW + 5000,
    )
    expect(ctx.runtime.contacts.checkAt.get(1)).toBe(
      NOW + CONTACTS_HINT_DELAY_MS,
    )
    expect(cachedRow(db)).toEqual(before)
  })

  it('unmarks every contact on updateContactsReset and checks at once', () => {
    const { ctx, db } = setup()
    seed(db, true)
    handleContactRawUpdate(
      ctx,
      1,
      db,
      new RawUpdateInfo({ _: 'updateContactsReset' }, new PeersIndex()),
      NOW,
    )
    expect(cachedRow(db)?.is_contact).toBe(0)
    expect(ctx.runtime.contacts.checkAt.get(1)).toBe(NOW)
  })

  it('ignores updateUserName and unrelated updates', () => {
    const { ctx, db } = setup()
    seed(db, true)
    const before = cachedRow(db)
    for (const update of [
      {
        _: 'updateUserName',
        userId: USER,
        firstName: 'Changed',
        lastName: '',
        usernames: [],
      },
      {
        _: 'updatePeerSettings',
        peer: { _: 'peerChat', chatId: 77 },
        settings: { _: 'peerSettings' },
      },
      { _: 'updateDialogPinned', peer: { _: 'dialogPeerFolder', folderId: 1 } },
    ] as tl.TypeUpdate[]) {
      handleContactRawUpdate(
        ctx,
        1,
        db,
        new RawUpdateInfo(
          update,
          PeersIndex.from({ users: [fullUser(false)] }),
        ),
        NOW,
      )
    }
    expect(cachedRow(db)).toEqual(before)
    expect(ctx.runtime.contacts.checkAt.size).toBe(0)
  })

  it('logs a database failure instead of throwing', () => {
    const { ctx, db } = setup()
    db.close()
    expect(() =>
      handleContactRawUpdate(ctx, 1, db, peerSettings([fullUser(true)]), NOW),
    ).not.toThrow()
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('[Account 1] Error handling a contact update'),
    )
  })

  it('keeps a hint that arrived while a check ran, for a check of its own', async () => {
    // With no earlier request, and while the start check serves its own
    for (const startCheck of [false, true]) {
      const ctx = createContext()
      const { client, calls } = fakeClient()
      const db = connect(ctx, 1, client)
      if (startCheck) requestContactsCheckNow(ctx, 1, NOW)

      const started = maybeSyncContacts(ctx, NOW)
      handleContactRawUpdate(ctx, 1, db, userUpdate(), NOW)
      calls[0]?.resolve(notModified)
      await Promise.all(started)

      // The list the check got may predate the change the hint is about
      expect(ctx.runtime.contacts.checkAt.get(1)).toBe(
        NOW + CONTACTS_HINT_DELAY_MS,
      )
    }
  })

  it('checks again after a running check that may overwrite a full record', async () => {
    const ctx = createContext()
    const { client, calls } = fakeClient()
    const db = connect(ctx, 1, client)

    const started = maybeSyncContacts(ctx, NOW)
    handleContactRawUpdate(ctx, 1, db, peerSettings([fullUser(true)]), NOW)
    expect(cachedRow(db)?.is_contact).toBe(1)
    // The reply predates the change and leaves the new contact out
    calls[0]?.resolve(contactsList([]))
    await Promise.all(started)

    expect(cachedRow(db)?.is_contact).toBe(0)
    expect(ctx.runtime.contacts.checkAt.get(1)).toBe(
      NOW + CONTACTS_HINT_DELAY_MS,
    )
  })
})
describe('loadContactsTtl', () => {
  let dirs = 0
  // A fresh data dir under the test data dir, with this config.json
  async function withConfig(config: string): Promise<
    DaemonContext & {
      logger: ReturnType<typeof createLogger>
    }
  > {
    const ctx = createContext()
    ctx.dataDir = join(
      process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? '.tmp',
      `contacts-ttl-${process.pid}-${++dirs}`,
    )
    await Bun.write(join(ctx.dataDir, 'config.json'), config)
    return ctx
  }

  it('reads the peer TTL from cache.staleness.peers', async () => {
    const ctx = await withConfig('{"cache":{"staleness":{"peers":"1h"}}}')
    await loadContactsTtl(ctx)
    expect(ctx.runtime.contacts.peersTtlMs).toBe(HOUR)
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('keeps the default and warns when the config is invalid', async () => {
    const ctx = await withConfig('{"cache":{"staleness":{"peers":"soon"}}}')
    await loadContactsTtl(ctx)
    expect(ctx.runtime.contacts.peersTtlMs).toBe(
      getDefaultCacheConfig().staleness.peers,
    )
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })
})
