/**
 * Catch-up after mtcute reconnects on its own or the computer wakes (#124),
 * with fake clients and injected clocks
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  CATCH_UP_MIN_INTERVAL_MS,
  CATCH_UP_SETTLE_MS,
  createConnectionWatch,
  detectWake,
  noteConnectionState,
  runDueCatchUps,
} from '../daemon/daemon-catch-up'
import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import { createSyncScheduler } from '../daemon/scheduler'
import type { AccountConnectionState } from '../daemon/types'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createTestDatabase } from '../db/index.ts'
import { createMessagesCache } from '../db/messages-cache'
import { createSyncJobsService } from '../db/sync-jobs'
import { SyncJobType, SyncPriority } from '../db/sync-schema'
import {
  addAccountRuntime,
  createAccountCacheDb,
} from './helpers/daemon-runtime'
import { fakeDialogClient } from './helpers/fake-dialogs'

const T0 = Date.UTC(2026, 0, 1)
const HOUR = 3_600_000

function createContext(): DaemonContext {
  const { accountsDb } = createTestDatabase()
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
    accountsDb,
    runtime: createDaemonRuntime(),
  }
}

describe('noteConnectionState', () => {
  it('asks for a catch-up after more than 5 s offline, once the connection settles', () => {
    const watch = createConnectionWatch()
    noteConnectionState(watch, 'connecting', T0)
    noteConnectionState(watch, 'offline', T0 + 1_000)
    noteConnectionState(watch, 'connected', T0 + 20_000)

    expect(watch.pending).toEqual({
      reason: 'reconnect',
      offlineMs: 20_000,
      dueAt: T0 + 20_000 + CATCH_UP_SETTLE_MS,
    })
  })

  it('ignores a short blip, such as a reconnect after a ping timeout', () => {
    const watch = createConnectionWatch()
    noteConnectionState(watch, 'connecting', T0)
    noteConnectionState(watch, 'connected', T0 + 3_000)
    // mtcute fetching what it missed is online too
    noteConnectionState(watch, 'updating', T0 + 3_500)
    noteConnectionState(watch, 'connected', T0 + 4_000)

    expect(watch.pending).toBeUndefined()
    expect(watch.online).toBe(true)
  })

  it('debounces a flapping connection: one pass in 5 minutes', () => {
    const watch = createConnectionWatch()
    watch.lastCatchUpAt = T0
    noteConnectionState(watch, 'offline', T0 + 60_000)
    noteConnectionState(watch, 'connected', T0 + 90_000)
    expect(watch.pending?.dueAt).toBe(T0 + CATCH_UP_MIN_INTERVAL_MS)

    // Another drop meanwhile: the longer outage, and the wait settles again
    noteConnectionState(watch, 'offline', T0 + 100_000)
    noteConnectionState(watch, 'connected', T0 + 102_000)
    expect(watch.pending).toMatchObject({
      offlineMs: 30_000,
      dueAt: T0 + CATCH_UP_MIN_INTERVAL_MS,
    })
  })
})

describe('catch-up after a reconnect or a wake', () => {
  let cacheDb: Database
  let jobsService: ReturnType<typeof createSyncJobsService>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>

  beforeEach(() => {
    cacheDb = createAccountCacheDb()
    jobsService = createSyncJobsService(cacheDb)
    chatSyncState = createChatSyncStateService(cacheDb)
    // Two synced chats, both caught up to message 1000
    for (const userId of [1001, 1002]) {
      chatSyncState.upsert({
        chat_id: userId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 1,
      })
      chatSyncState.markHistoryComplete(userId)
      chatSyncState.raiseTopMessageId(userId, 1000)
    }
  })

  afterEach(() => {
    cacheDb.close()
  })

  /** A connected account whose client lists 1002 with a newer message */
  function connectedAccount() {
    const ctx = createContext()
    const rt = addAccountRuntime(ctx, 1, cacheDb, {
      scheduler: createSyncScheduler({
        db: cacheDb,
        jobsService,
        chatSyncState,
        messagesCache: createMessagesCache(cacheDb),
      }),
    })
    const fake = fakeDialogClient([
      { kind: 'user', id: 1001, topMessage: 1000 },
      { kind: 'user', id: 1002, topMessage: 1004 },
    ])
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'connected',
      client: fake.client,
      watch: createConnectionWatch(),
    }
    ctx.state.accounts.set(1, accountState)
    return { ctx, rt, fake, accountState }
  }

  const pendingCatchUps = () =>
    jobsService
      .getPendingJobs()
      .filter((job) => job.job_type === SyncJobType.ForwardCatchup)
      .map((job) => job.chat_id)

  it('queues catch-up on the same client after mtcute reconnected on its own', async () => {
    const { ctx, rt, fake, accountState } = connectedAccount()
    const watch = accountState.watch!
    noteConnectionState(watch, 'connecting', T0)
    noteConnectionState(watch, 'connected', T0 + 9 * HOUR)

    // Not before the connection settled
    expect(runDueCatchUps(ctx, T0 + 9 * HOUR + 1_000)).toEqual([])
    const started = runDueCatchUps(ctx, T0 + 9 * HOUR + CATCH_UP_SETTLE_MS)
    expect(started).toHaveLength(1)
    await Promise.all(started)

    expect(fake.calls).toEqual([{ archived: 'keep' }])
    expect(accountState.client).toBe(fake.client)
    expect(chatSyncState.get(1002)?.top_message_id).toBe(1004)
    expect(pendingCatchUps()).toEqual([1002])
    expect((ctx.logger.info as ReturnType<typeof mock>).mock.calls).toEqual([
      [
        '[Account 1] Reconnected after 9 h offline: dialog pass, 1 chat(s) to catch up',
      ],
    ])
    expect(rt.statusService.getDaemonInfo().lastCatchUp).toMatchObject({
      reason: 'reconnect',
      offlineMs: 9 * HOUR,
      chats: 1,
    })

    // Done: nothing runs again until the next reconnect
    expect(runDueCatchUps(ctx, T0 + 10 * HOUR)).toEqual([])
  })

  it('queues catch-up after a jump of the wall clock between loop ticks (a wake)', async () => {
    const { ctx, rt, fake } = connectedAccount()
    ctx.runtime.sleepStartedAt = T0
    expect(detectWake(ctx, T0 + 1_000)).toBeNull()

    ctx.runtime.sleepStartedAt = T0 + 2_000
    const woke = T0 + 2_000 + 7 * HOUR
    expect(detectWake(ctx, woke)).toBe(7 * HOUR)

    await Promise.all(runDueCatchUps(ctx, woke + CATCH_UP_SETTLE_MS))

    expect(fake.calls).toHaveLength(1)
    expect(pendingCatchUps()).toEqual([1002])
    expect(ctx.logger.info).toHaveBeenCalledWith(
      '[Account 1] Woke after 7 h asleep: dialog pass, 1 chat(s) to catch up',
    )
    expect(rt.statusService.getDaemonInfo().lastCatchUp?.reason).toBe('wake')
  })

  it('waits while the connection is still down after a wake', async () => {
    const { ctx, fake, accountState } = connectedAccount()
    ctx.runtime.sleepStartedAt = T0
    detectWake(ctx, T0 + HOUR)
    noteConnectionState(accountState.watch!, 'connecting', T0 + HOUR + 1_000)

    expect(runDueCatchUps(ctx, T0 + HOUR + 60_000)).toEqual([])

    noteConnectionState(accountState.watch!, 'connected', T0 + HOUR + 62_000)
    await Promise.all(
      runDueCatchUps(ctx, T0 + HOUR + 62_000 + CATCH_UP_SETTLE_MS),
    )
    expect(fake.calls).toHaveLength(1)
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Woke after 1 h asleep'),
    )
  })

  it('skips an account that is reconnecting, and every account while the daemon stops', () => {
    const { ctx, accountState } = connectedAccount()
    noteConnectionState(accountState.watch!, 'offline', T0)
    noteConnectionState(accountState.watch!, 'connected', T0 + HOUR)

    accountState.status = 'reconnecting'
    expect(runDueCatchUps(ctx, T0 + 2 * HOUR)).toEqual([])

    accountState.status = 'connected'
    ctx.state.shutdownRequested = true
    expect(runDueCatchUps(ctx, T0 + 2 * HOUR)).toEqual([])
    expect(accountState.watch?.pending).toBeDefined()
  })
})
