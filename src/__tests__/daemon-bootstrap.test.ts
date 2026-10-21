/**
 * Tests for the daemon's dialog pass: what it writes to chats_cache and
 * chat_sync_state.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import {
  createDaemonRuntime,
  type DaemonContext,
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
import { type FakeDialogInput, fakeDialogClient } from './helpers/fake-dialogs'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

let testCacheDb: Database

mock.module('../db', () => ({
  getCacheDb: () => testCacheDb,
}))

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
    expect(
      (ctx.logger.info as ReturnType<typeof mock>).mock.calls.some(([line]) =>
        /Bootstrapped 1 dialogs \(0 archived\)/.test(String(line)),
      ),
    ).toBe(true)
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

  it('checks unvisited chats when an account is not connected', async () => {
    seedSynced(1001, 1000, 1000)
    ctx.state.accounts.set(2, {
      accountId: 2,
      phone: '+15550000002',
      name: null,
      status: 'error',
    })

    await runPass([])

    expect(chatSyncState.get(1001)?.top_message_id).toBeNull()
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
