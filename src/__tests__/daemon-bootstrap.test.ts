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
import type { AccountsDbInterface } from '../db'
import {
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../db/chat-sync-state'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema, SyncPriority } from '../db/sync-schema'
import { type FakeDialogInput, fakeDialogClient } from './helpers/fake-dialogs'

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

  async function runPass(dialogs: FakeDialogInput[]) {
    const { bootstrapDialogs } = await import('../daemon/daemon-bootstrap')
    const fake = fakeDialogClient(dialogs)
    connect(ctx, 1, fake.client)
    await bootstrapDialogs(ctx)
    return fake
  }

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
