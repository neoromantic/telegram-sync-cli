/**
 * Tests for the daemon's dialog pass: what it writes to chats_cache and
 * chat_sync_state.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { TelegramClient } from '@mtcute/bun'
import { fetchJoinedCommunities } from '../commands/chats/helpers'
import {
  createDaemonRuntime,
  type DaemonContext,
  requestShutdown,
} from '../daemon/daemon-context'
import { createSyncScheduler } from '../daemon/scheduler'
import type { AccountsDbInterface } from '../db'
import {
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'
import { toLong } from '../utils/long'
import {
  addAccountRuntime,
  createAccountCacheDb,
} from './helpers/daemon-runtime'
import {
  type FakeDialogInput,
  fakeDialogClient,
  fakeRawCommunity,
} from './helpers/fake-dialogs'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

let testCacheDb: Database

function createContext(): DaemonContext {
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli/daemon.pid',
    verbosity: 'normal',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 3,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: {
      info: mock(() => {}),
      debug: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
    },
    pidFile: {
      acquire: () => {},
      release: () => {},
      read: () => null,
      isRunning: () => false,
      sendSignal: () => false,
      getPath: () => '/tmp/tgcli/daemon.pid',
    },
    state: { running: true, accounts: new Map(), shutdownRequested: false },
    accountsDb: {} as AccountsDbInterface,
    runtime: createDaemonRuntime(),
  }
}

function connect(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
) {
  ctx.state.accounts.set(accountId, {
    accountId,
    phone: `+1555000000${accountId}`,
    name: null,
    status: 'connected',
    client,
  })
}

describe('bootstrapDialogs', () => {
  let chatSyncState: ChatSyncStateService
  let ctx: DaemonContext

  beforeEach(() => {
    testCacheDb = new Database(':memory:')
    initCacheSchema(testCacheDb)
    initSyncSchema(testCacheDb)
    chatSyncState = createChatSyncStateService(testCacheDb)
    ctx = createContext()
  })

  afterEach(() => {
    testCacheDb.close()
  })

  async function runPass(
    dialogs: FakeDialogInput[],
    options: Parameters<typeof fakeDialogClient>[1] = {},
  ) {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    const fake = fakeDialogClient(dialogs, options)
    connect(ctx, 1, fake.client)
    addAccountRuntime(ctx, 1, testCacheDb)
    await bootstrapDialogs(ctx)
    return fake
  }

  /** A private chat that has synced up to `cursor` */
  function seedSynced(userId: number, cursor: number, top: number | null) {
    chatSyncState.upsert({
      chat_id: userId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: cursor,
      backward_cursor: 1,
    })
    chatSyncState.markHistoryComplete(userId)
    if (top !== null) chatSyncState.raiseTopMessageId(userId, top)
  }

  async function startScheduler() {
    const scheduler = createSyncScheduler({
      db: testCacheDb,
      jobsService: createSyncJobsService(testCacheDb),
      chatSyncState,
      messagesCache: createMessagesCache(testCacheDb),
    })
    await scheduler.initializeForStartup()
    return createSyncJobsService(testCacheDb).getPendingJobs()
  }

  it('keeps the mode set with tg chats sync', async () => {
    chatSyncState.upsert({
      chat_id: -1_000_000_002_002,
      chat_type: 'channel',
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    })
    chatSyncState.setSyncMode(-1_000_000_002_002, 'on')
    seedSynced(1001, 10, 10)
    chatSyncState.setSyncMode(1001, 'off')

    await runPass([
      { kind: 'channel', id: 2002, membersCount: 5000, topMessage: 9 },
      { kind: 'user', id: 1001, topMessage: 10 },
    ])

    expect(chatSyncState.get(-1_000_000_002_002)).toMatchObject({
      sync_mode: 'on',
      sync_enabled: 1,
      sync_priority: SyncPriority.High,
      member_count: 5000,
    })
    expect(chatSyncState.get(1001)).toMatchObject({
      sync_mode: 'off',
      sync_enabled: 0,
    })
  })

  it('lists archived dialogs too', async () => {
    const fake = await runPass([{ kind: 'user', id: 1001, topMessage: 5 }])

    expect(fake.calls).toEqual([{ archived: 'keep' }])
    const infoLines = (ctx.logger.info as ReturnType<typeof mock>).mock.calls
    expect(
      infoLines.some(([line]) =>
        /Bootstrapped 1 dialogs \(0 archived\)/.test(String(line)),
      ),
    ).toBe(true)
    // An account without communities costs one request and no warning
    expect(fake.communityCalls).toHaveLength(1)
    expect(ctx.logger.warn).not.toHaveBeenCalled()
    expect(infoLines.some(([line]) => /0 communities/.test(String(line)))).toBe(
      true,
    )
  })

  it('caches joined communities with their access hash', async () => {
    const fake = await runPass([{ kind: 'user', id: 1001, topMessage: 5 }], {
      communities: [{ id: 5555555555, accessHash: '777' }],
    })

    expect(
      createChatsCache(testCacheDb).getById('-1005555555555'),
    ).toMatchObject({ type: 'community', access_hash: '777' })
    // No messages of its own: nothing to sync
    expect(chatSyncState.get(-1005555555555)).toBeNull()
    expect(fake.communityCalls).toHaveLength(1)
    expect(fake.communityCalls[0]?.abortSignal).toBe(
      ctx.runtime.shutdown.signal,
    )
    expect(
      (ctx.logger.info as ReturnType<typeof mock>).mock.calls.some(([line]) =>
        /1 communities/.test(String(line)),
      ),
    ).toBe(true)
    assertPeerIdInvariants(testCacheDb)
  })

  it('a failed communities request is a warning and the pass stays complete', async () => {
    const { markUnvisitedChats, syncAccountDialogs } = await import(
      '../daemon/daemon-bootstrap'
    )
    // Left: no longer in the dialog list
    seedSynced(1001, 1000, 1200)
    const { client } = fakeDialogClient(
      [{ kind: 'user', id: 1002, topMessage: 5 }],
      { communitiesError: new Error('RPC_CALL_FAIL') },
    )
    addAccountRuntime(ctx, 1, testCacheDb)

    const result = await syncAccountDialogs(ctx, 1, client)
    markUnvisitedChats(chatSyncState, result.visited, result.complete, true)

    expect(result).toMatchObject({ complete: true, stopped: false })
    expect(createChatsCache(testCacheDb).getById('1002')).not.toBeNull()
    // Caught up as after any complete pass
    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to list joined communities'),
    )
  })

  it('a stop during the communities request ends it', async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    const fake = fakeDialogClient([{ kind: 'user', id: 1001, topMessage: 5 }], {
      communities: [{ id: 5555555555, accessHash: '777' }],
      communitiesWaitUntilAbort: true,
      onWait: () => requestShutdown(ctx),
    })
    connect(ctx, 1, fake.client)
    addAccountRuntime(ctx, 1, testCacheDb)

    await bootstrapDialogs(ctx)

    expect(ctx.logger.warn).not.toHaveBeenCalled()
    expect(fake.communityCalls).toHaveLength(1)
    expect(createChatsCache(testCacheDb).getById('-1005555555555')).toBeNull()
    expect(createChatsCache(testCacheDb).getById('1001')).not.toBeNull()
  })

  it('fetchJoinedCommunities passes the stop signal and keeps only usable communities', async () => {
    // A real client that never connects: only its RPC call is replaced
    const client = new TelegramClient({
      apiId: 1,
      apiHash: 'test-api-hash',
      storage: ':memory:',
    })
    const signals: unknown[] = []
    const call = mock(
      async (request: { _: string }, params?: { abortSignal?: unknown }) => {
        expect(request._).toBe('communities.getJoinedCommunities')
        signals.push(params?.abortSignal)
        return {
          _: 'messages.chats',
          chats: [
            fakeRawCommunity({ id: 5555555551, accessHash: '701' }),
            fakeRawCommunity({
              id: 5555555552,
              accessHash: '702',
              forbidden: true,
            }),
            {
              ...fakeRawCommunity({ id: 5555555553, accessHash: '703' }),
              min: true,
            },
            {
              _: 'channel',
              id: 5555555554,
              accessHash: toLong('704'),
              title: 'Example Channel',
              photo: { _: 'chatPhotoEmpty' },
              date: 1_700_000_000,
            },
          ],
        }
      },
    )
    client._client.call = call as unknown as typeof client._client.call

    try {
      const { signal } = ctx.runtime.shutdown
      const rows = await fetchJoinedCommunities(
        client.withParams({ abortSignal: signal }),
      )

      expect(
        rows.map((row) => [row.chat_id, row.type, row.access_hash]),
      ).toEqual([
        ['-1005555555551', 'community', '701'],
        ['-1005555555552', 'community', '702'],
      ])
      expect(call).toHaveBeenCalledTimes(1)
      expect(signals).toEqual([signal])
    } finally {
      await client.destroy()
    }
  })

  it('raises the newest message ID and never lowers it', async () => {
    seedSynced(1001, 400, 500)
    seedSynced(1002, 300, null)
    seedSynced(1003, 300, null)

    await runPass([
      { kind: 'user', id: 1001, topMessage: 450 },
      { kind: 'user', id: 1002, topMessage: 320 },
      // No top message in the dialog: the top stays unknown
      { kind: 'user', id: 1003 },
    ])

    expect(chatSyncState.get(1001)?.top_message_id).toBe(500)
    expect(chatSyncState.get(1002)?.top_message_id).toBe(320)
    expect(chatSyncState.get(1003)?.top_message_id).toBeNull()
  })

  it('caches an archived chat without starting to sync it', async () => {
    await runPass([
      { kind: 'user', id: 1001, topMessage: 5, archived: true },
      {
        kind: 'group',
        id: 4001,
        membersCount: 5,
        topMessage: 9,
        archived: true,
      },
    ])

    const chatsCache = createChatsCache(testCacheDb)
    expect(chatsCache.getById('1001')?.access_hash).toBe('777')
    expect(chatsCache.getById('-4001')?.type).toBe('group')
    expect(chatSyncState.get(1001)).toBeNull()
    expect(chatSyncState.get(-4001)).toBeNull()
  })

  it('caches each chat under the marked ID its sync state has', async () => {
    await runPass([
      { kind: 'user', id: 1001, topMessage: 5 },
      { kind: 'group', id: 4001, membersCount: 5, topMessage: 9 },
      {
        kind: 'supergroup',
        id: 1234567890,
        title: 'Team Chat',
        membersCount: 12,
        topMessage: 7,
      },
      { kind: 'channel', id: 2002, membersCount: 5000, topMessage: 3 },
    ])

    const cachedIds = testCacheDb
      .query('SELECT chat_id FROM chats_cache ORDER BY chat_id')
      .all()
      .map((row) => Number((row as { chat_id: string }).chat_id))
    const syncedIds = testCacheDb
      .query('SELECT chat_id FROM chat_sync_state ORDER BY chat_id')
      .all()
      .map((row) => (row as { chat_id: number }).chat_id)
    expect(cachedIds.sort()).toEqual(
      [1001, -4001, -1001234567890, -1000000002002].sort(),
    )
    expect(syncedIds.sort()).toEqual(cachedIds.sort())

    const chatsCache = createChatsCache(testCacheDb)
    expect(chatsCache.getById('-4001')?.type).toBe('group')
    expect(chatsCache.getById('-1001234567890')).toMatchObject({
      type: 'supergroup',
      title: 'Team Chat',
      access_hash: '777',
    })
    // A bare ID names no chat any more
    expect(chatsCache.getById('4001')).toBeNull()
    expect(chatsCache.getById('1234567890')).toBeNull()
    assertPeerIdInvariants(testCacheDb)
  })

  it('updates an archived chat that already syncs', async () => {
    seedSynced(1001, 10, 10)

    await runPass([{ kind: 'user', id: 1001, topMessage: 20, archived: true }])

    expect(chatSyncState.get(1001)?.top_message_id).toBe(20)
    expect(await startScheduler()).toMatchObject([
      { chat_id: 1001, job_type: SyncJobType.ForwardCatchup },
    ])
  })

  it('marks unvisited chats caught up after a complete pass', async () => {
    // Left or deleted: no longer in the dialog list
    seedSynced(1001, 1000, null)
    seedSynced(1002, 1000, 1200)
    seedSynced(1003, 50, 50)

    await runPass([{ kind: 'user', id: 1003, topMessage: 50 }])

    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    expect(chatSyncState.get(1002)?.top_message_id).toBe(1000)
    expect(await startScheduler()).toEqual([])
  })

  it('checks an opted-in chat that no dialog lists on every start', async () => {
    // A public channel the user never joined, turned on with tg chats sync:
    // no dialog list shows it and no live update reaches it
    const channelId = -1_000_000_003_003
    chatSyncState.upsert({
      chat_id: channelId,
      chat_type: 'channel',
      member_count: 5000,
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
      forward_cursor: 900,
      backward_cursor: 801,
    })
    chatSyncState.setSyncMode(channelId, 'on')
    chatSyncState.raiseTopMessageId(channelId, 900)
    // Left: no longer in the dialog list
    seedSynced(1001, 1000, 1200)

    await runPass([{ kind: 'user', id: 1003, topMessage: 50 }])

    expect(chatSyncState.get(channelId)?.top_message_id).toBeNull()
    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    const catchups = (await startScheduler()).filter(
      (job) => job.job_type === SyncJobType.ForwardCatchup,
    )
    expect(catchups.map((job) => job.chat_id)).toEqual([channelId])
  })

  it('checks every unvisited chat once after a pass that failed part-way', async () => {
    seedSynced(1001, 1000, 1000)
    seedSynced(1002, 1000, 1000)
    seedSynced(1003, 1000, 1000)

    await runPass(
      [
        { kind: 'user', id: 1001, topMessage: 1000 },
        { kind: 'user', id: 1002, topMessage: 1000 },
        { kind: 'user', id: 1003, topMessage: 1000 },
      ],
      { failAfter: 1 },
    )

    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    expect(chatSyncState.get(1002)?.top_message_id).toBeNull()
    expect(chatSyncState.get(1003)?.top_message_id).toBeNull()

    const jobs = await startScheduler()
    expect(jobs.map((job) => [job.chat_id, job.job_type]).sort()).toEqual([
      [1002, SyncJobType.ForwardCatchup],
      [1003, SyncJobType.ForwardCatchup],
    ])
  })

  it("writes each account's dialogs to its own cache", async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    const otherDb = createAccountCacheDb()
    connect(ctx, 1, fakeDialogClient([{ kind: 'user', id: 1001 }]).client)
    addAccountRuntime(ctx, 1, testCacheDb)
    connect(
      ctx,
      2,
      fakeDialogClient([{ kind: 'group', id: 4001, membersCount: 5 }]).client,
    )
    addAccountRuntime(ctx, 2, otherDb)

    await bootstrapDialogs(ctx)

    const chatIds = (db: Database) =>
      db
        .query('SELECT chat_id FROM chats_cache ORDER BY chat_id')
        .all()
        .map((row) => (row as { chat_id: string }).chat_id)
    expect(chatIds(testCacheDb)).toEqual(['1001'])
    expect(chatIds(otherDb)).toEqual(['-4001'])
    expect(createChatSyncStateService(otherDb).get(1001)).toBeNull()
    otherDb.close()
  })

  it("marks an account's left chats caught up even when another account's pass fails", async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    // Account 1 left chat 1001; its pass completes
    seedSynced(1001, 1000, 1200)
    seedSynced(1003, 50, 50)
    connect(
      ctx,
      1,
      fakeDialogClient([{ kind: 'user', id: 1003, topMessage: 50 }]).client,
    )
    addAccountRuntime(ctx, 1, testCacheDb)
    // Account 2's pass fails before it lists chat 2001
    const otherDb = createAccountCacheDb()
    const otherState = createChatSyncStateService(otherDb)
    otherState.upsert({
      chat_id: 2001,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 700,
      backward_cursor: 1,
    })
    otherState.raiseTopMessageId(2001, 700)
    connect(
      ctx,
      2,
      fakeDialogClient([{ kind: 'user', id: 2001, topMessage: 700 }], {
        failAfter: 0,
      }).client,
    )
    addAccountRuntime(ctx, 2, otherDb)

    await bootstrapDialogs(ctx)

    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    expect(chatSyncState.get(1003)?.top_message_id).toBe(50)
    // Unknown after a failed pass: it gets a checking page
    expect(otherState.get(2001)?.top_message_id).toBeNull()
    otherDb.close()
  })

  it('leaves the sync state of an account that is not connected as it is', async () => {
    const otherDb = createAccountCacheDb()
    const otherState = createChatSyncStateService(otherDb)
    otherState.upsert({
      chat_id: 2001,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 1000,
      backward_cursor: 1,
    })
    otherState.raiseTopMessageId(2001, 1200)
    ctx.state.accounts.set(2, {
      accountId: 2,
      phone: '+15550000002',
      name: null,
      status: 'error',
    })
    addAccountRuntime(ctx, 2, otherDb)
    seedSynced(1001, 1000, 1000)

    await runPass([])

    expect(otherState.get(2001)?.top_message_id).toBe(1200)
    expect(otherState.get(2001)?.forward_cursor).toBe(1000)
    // Account 1's complete pass didn't list 1001: left, caught up
    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    otherDb.close()
  })

  it('a stop during the startup pass ends it at the next dialog and skips the other accounts', async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    // A synced chat the pass doesn't reach before the stop
    seedSynced(1005, 1000, 1200)
    const first = fakeDialogClient(
      [
        { kind: 'user', id: 1001, topMessage: 10 },
        { kind: 'user', id: 1002, topMessage: 10 },
        { kind: 'user', id: 1003, topMessage: 10 },
      ],
      {
        onListed: (count) => {
          if (count === 1) ctx.state.shutdownRequested = true
        },
      },
    )
    connect(ctx, 1, first.client)
    addAccountRuntime(ctx, 1, testCacheDb)
    const otherDb = createAccountCacheDb()
    const second = fakeDialogClient([{ kind: 'user', id: 2001 }])
    connect(ctx, 2, second.client)
    addAccountRuntime(ctx, 2, otherDb)

    await bootstrapDialogs(ctx)

    const cachedIds = testCacheDb
      .query('SELECT chat_id FROM chats_cache')
      .all()
      .map((row) => (row as { chat_id: string }).chat_id)
    expect(cachedIds).toEqual(['1001'])
    expect(ctx.logger.warn).not.toHaveBeenCalled()
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      '[Account 1] Dialog pass stopped after 1 dialogs: the daemon is stopping',
    )
    expect(second.calls).toEqual([])
    // Neither caught up nor unknown: the stop tells nothing about it
    expect(chatSyncState.get(1005)).toMatchObject({
      forward_cursor: 1000,
      top_message_id: 1200,
    })
    otherDb.close()
  })

  it('a stop during a FLOOD_WAIT in the startup pass ends the wait at once', async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    // A synced chat the pass doesn't reach before the stop
    seedSynced(1005, 1000, 1200)
    const first = fakeDialogClient(
      [
        { kind: 'user', id: 1001, topMessage: 10 },
        { kind: 'user', id: 1002, topMessage: 10 },
      ],
      { waitAfter: 1, onWait: () => requestShutdown(ctx) },
    )
    connect(ctx, 1, first.client)
    addAccountRuntime(ctx, 1, testCacheDb)
    const otherDb = createAccountCacheDb()
    const second = fakeDialogClient([{ kind: 'user', id: 2001 }])
    connect(ctx, 2, second.client)
    addAccountRuntime(ctx, 2, otherDb)

    const started = performance.now()
    await bootstrapDialogs(ctx)

    expect(performance.now() - started).toBeLessThan(1000)
    expect(first.params).toEqual([{ abortSignal: ctx.runtime.shutdown.signal }])
    expect(first.params[0]?.abortSignal).toBe(ctx.runtime.shutdown.signal)
    expect(
      testCacheDb
        .query('SELECT chat_id FROM chats_cache')
        .all()
        .map((row) => (row as { chat_id: string }).chat_id),
    ).toEqual(['1001'])
    // Neither caught up nor unknown: the stop tells nothing about it
    expect(chatSyncState.get(1005)).toMatchObject({
      forward_cursor: 1000,
      top_message_id: 1200,
    })
    expect(second.calls).toEqual([])
    expect(ctx.logger.warn).not.toHaveBeenCalled()
    expect(ctx.logger.error).not.toHaveBeenCalled()
    const debugLines = (
      ctx.logger.debug as ReturnType<typeof mock>
    ).mock.calls.map(([line]) => String(line))
    expect(debugLines).toContain(
      '[Account 1] Dialog pass stopped after 1 dialogs: the daemon is stopping',
    )
    expect(
      debugLines.some((line) =>
        line.includes('Dialog page failed during the stop'),
      ),
    ).toBe(false)
    otherDb.close()
  })

  it("passes the stop signal to every page request of mtcute's iterDialogs", async () => {
    // A real client that never connects: only its RPC call is replaced
    const client = new TelegramClient({
      apiId: 1,
      apiHash: 'test-api-hash',
      storage: ':memory:',
    })
    const signals: unknown[] = []
    const call = mock(
      async (request: { _: string }, params?: { abortSignal?: unknown }) => {
        expect(request._).toBe('messages.getDialogs')
        signals.push(params?.abortSignal)
        return {
          _: 'messages.dialogs',
          dialogs: [],
          messages: [],
          chats: [],
          users: [],
        }
      },
    )
    client._client.call = call as unknown as typeof client._client.call

    try {
      const { signal } = ctx.runtime.shutdown
      const listed = []
      for await (const dialog of client
        .withParams({ abortSignal: signal })
        .iterDialogs({ archived: 'keep' })) {
        listed.push(dialog)
      }

      expect(listed).toEqual([])
      expect(call).toHaveBeenCalledTimes(1)
      expect(signals).toHaveLength(1)
      expect(signals[0]).toBe(signal)
    } finally {
      await client.destroy()
    }
  })

  it('a stop right after a complete pass still marks unvisited chats', async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    // Left: no longer in the dialog list
    seedSynced(1001, 1000, 1200)
    const dialogs: FakeDialogInput[] = [
      { kind: 'user', id: 1002, topMessage: 10 },
      { kind: 'user', id: 1003, topMessage: 10 },
    ]
    const first = fakeDialogClient(dialogs, {
      onListed: (count) => {
        if (count === dialogs.length) ctx.state.shutdownRequested = true
      },
    })
    connect(ctx, 1, first.client)
    addAccountRuntime(ctx, 1, testCacheDb)
    const otherDb = createAccountCacheDb()
    const second = fakeDialogClient([{ kind: 'user', id: 2001 }])
    connect(ctx, 2, second.client)
    addAccountRuntime(ctx, 2, otherDb)

    await bootstrapDialogs(ctx)

    expect(chatSyncState.get(1001)?.top_message_id).toBe(1000)
    expect(createChatsCache(testCacheDb).getById('1003')).not.toBeNull()
    // The stop skips the communities request
    expect(first.communityCalls).toEqual([])
    expect(second.calls).toEqual([])
    otherDb.close()
  })

  it('a dialog page that fails during a stop is logged at debug and marks nothing', async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    seedSynced(1005, 1000, 1200)
    // The page after the stop signal fails
    const first = fakeDialogClient(
      [
        { kind: 'user', id: 1001, topMessage: 10 },
        { kind: 'user', id: 1002, topMessage: 10 },
      ],
      {
        failAfter: 1,
        onListed: () => {
          ctx.state.shutdownRequested = true
        },
      },
    )
    connect(ctx, 1, first.client)
    addAccountRuntime(ctx, 1, testCacheDb)
    const otherDb = createAccountCacheDb()
    const second = fakeDialogClient([{ kind: 'user', id: 2001 }])
    connect(ctx, 2, second.client)
    addAccountRuntime(ctx, 2, otherDb)

    await bootstrapDialogs(ctx)

    expect(ctx.logger.warn).not.toHaveBeenCalled()
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        '[Account 1] Dialog page failed during the stop: Error: FLOOD_WAIT_600',
      ),
    )
    // Not unknown: a pass the stop ended tells nothing about it
    expect(chatSyncState.get(1005)?.top_message_id).toBe(1200)
    expect(second.calls).toEqual([])
    otherDb.close()
  })

  it('a cache write that fails during a stop is still a warning', async () => {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    // The stop closes nothing under the startup pass, so a failed save
    // after it is a cache fault
    testCacheDb.run(
      `CREATE TRIGGER fail_chat_save BEFORE INSERT ON chats_cache
       BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    )
    const first = fakeDialogClient(
      [
        { kind: 'user', id: 1001, topMessage: 10 },
        { kind: 'user', id: 1002, topMessage: 10 },
      ],
      {
        onListed: () => {
          ctx.state.shutdownRequested = true
        },
      },
    )
    connect(ctx, 1, first.client)
    addAccountRuntime(ctx, 1, testCacheDb)
    const otherDb = createAccountCacheDb()
    const second = fakeDialogClient([{ kind: 'user', id: 2001 }])
    connect(ctx, 2, second.client)
    addAccountRuntime(ctx, 2, otherDb)

    await bootstrapDialogs(ctx)

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[Account 1\] Failed to bootstrap dialogs: .*database or disk is full/,
      ),
    )
    expect(second.calls).toEqual([])
    otherDb.close()
  })

  it('leaves a supergroup without a member count off', async () => {
    await runPass([{ kind: 'supergroup', id: 2001, topMessage: 50 }])

    const state = chatSyncState.get(-1_000_000_002_001)
    expect(state?.chat_type).toBe('supergroup')
    expect(state?.sync_priority).toBe(SyncPriority.Low)
    expect(state?.sync_enabled).toBe(0)
  })

  it('keeps the stored member count when a dialog has none', async () => {
    chatSyncState.upsert({
      chat_id: -4001,
      chat_type: 'group',
      member_count: 50,
      sync_priority: SyncPriority.Medium,
      sync_enabled: true,
    })

    await runPass([{ kind: 'group', id: 4001, topMessage: 50 }])

    const state = chatSyncState.get(-4001)
    expect(state?.member_count).toBe(50)
    expect(state?.sync_priority).toBe(SyncPriority.Medium)
    expect(state?.sync_enabled).toBe(1)
  })
})
