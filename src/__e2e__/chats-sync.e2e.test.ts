/**
 * E2E tests for tg chats sync: cache-only, no Telegram credentials
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { createChatSyncStateService } from '../db/chat-sync-state'
import { type CachedChatInput, createChatsCache } from '../db/chats-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'
import { runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const NO_CREDENTIALS = {
  TELEGRAM_API_ID: undefined,
  TELEGRAM_API_HASH: undefined,
}

const CHANNEL_ID = 1234567890
const CHANNEL_PEER_ID = -1001234567890

function chatRow(
  chat: Pick<CachedChatInput, 'chat_id' | 'type' | 'title'> &
    Partial<CachedChatInput>,
): CachedChatInput {
  return {
    username: null,
    member_count: null,
    access_hash: null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: '{}',
    ...chat,
  }
}

interface SyncResult {
  success: boolean
  data: {
    id: number
    peerId: number
    type: string
    title: string | null
    username: string | null
    mode: string
    syncEnabled: boolean
    historyComplete: boolean
    syncedMessages: number
    changed: boolean
  }
}

describe('E2E: chats sync', () => {
  let env: TestEnvironment
  let cacheDb: Database

  beforeEach(() => {
    env = createTestEnvironment('chats-sync')
    env.initDatabase()

    cacheDb = new Database(join(env.dataDir, 'cache.db'))
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)
    createChatsCache(cacheDb).upsertMany([
      chatRow({
        chat_id: String(CHANNEL_ID),
        type: 'channel',
        title: 'Example News',
        username: 'examplenews',
        member_count: 5000,
        access_hash: '777',
      }),
      chatRow({
        chat_id: '4001',
        type: 'group',
        title: 'Book Club',
        member_count: 50,
      }),
    ])
  })

  afterEach(() => {
    cacheDb.close()
    env.cleanup()
  })

  function options() {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
  }

  async function sync(...args: string[]) {
    const result = await runCliSuccess(['chats', 'sync', ...args], options())
    return result.json as SyncResult
  }

  function stateOf(chatId: number) {
    return createChatSyncStateService(cacheDb).get(chatId)
  }

  /** The ID `tg chats list` shows for the channel */
  async function listedId(): Promise<string> {
    const list = await runCliSuccess(['chats', 'list'], options())
    const items = (
      list.json as { data: { items: Array<{ id: number; username: string }> } }
    ).data.items
    const channel = items.find((item) => item.username === 'examplenews')
    expect(channel?.id).toBe(CHANNEL_ID)
    return String(channel?.id)
  }

  for (const [label, chat] of [
    ['@username', async () => '@examplenews'],
    ['the ID from tg chats list', listedId],
    ['a marked -100 ID', async () => String(CHANNEL_PEER_ID)],
  ] as const) {
    it(`turns sync on for ${label}`, async () => {
      const result = await sync(await chat())

      expect(result).toEqual({
        success: true,
        data: {
          id: CHANNEL_ID,
          peerId: CHANNEL_PEER_ID,
          type: 'channel',
          title: 'Example News',
          username: 'examplenews',
          mode: 'on',
          syncEnabled: true,
          historyComplete: false,
          syncedMessages: 0,
          changed: true,
        },
      })
      expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({
        chat_type: 'channel',
        member_count: 5000,
        sync_mode: 'on',
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
      })
    })
  }

  it('reports no change for a second identical run', async () => {
    await sync('@examplenews')
    const again = await sync('@examplenews')

    expect(again.data).toMatchObject({ mode: 'on', changed: false })
  })

  it('turns sync off and drops the chat pending jobs', async () => {
    await sync('-4001')
    const jobs = createSyncJobsService(cacheDb)
    jobs.create({
      chat_id: -4001,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.Realtime,
    })

    const result = await sync('4001', '--off')

    expect(result.data).toMatchObject({
      id: 4001,
      peerId: -4001,
      type: 'group',
      mode: 'off',
      syncEnabled: false,
      changed: true,
    })
    expect(stateOf(-4001)).toMatchObject({ sync_mode: 'off', sync_enabled: 0 })
    expect(jobs.getPendingJobs()).toEqual([])
  })

  it('goes back to the default policy with --auto', async () => {
    await sync('@examplenews')
    await sync('-4001', '--off')

    const channel = await sync('@examplenews', '--auto')
    const group = await sync('4001', '--auto')

    expect(channel.data).toMatchObject({ mode: 'auto', syncEnabled: false })
    expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({
      sync_mode: 'auto',
      sync_enabled: 0,
      sync_priority: SyncPriority.Low,
    })
    expect(group.data).toMatchObject({ mode: 'auto', syncEnabled: true })
    expect(stateOf(-4001)).toMatchObject({
      sync_enabled: 1,
      sync_priority: SyncPriority.Medium,
    })
  })

  it('finds a chat the daemon saw only live', async () => {
    createChatSyncStateService(cacheDb).upsert({
      chat_id: -1009876543210,
      chat_type: 'supergroup',
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    })

    const result = await sync('-1009876543210')

    expect(result.data).toMatchObject({
      id: 9876543210,
      peerId: -1009876543210,
      type: 'supergroup',
      title: null,
      mode: 'on',
      syncEnabled: true,
    })
  })

  it('rejects --off together with --auto', async () => {
    const result = await runCliFailure(
      ['chats', 'sync', '@examplenews', '--off', '--auto'],
      3,
      options(),
    )

    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS' },
    })
    expect(stateOf(CHANNEL_PEER_ID)).toBeNull()
  })

  it('rejects an account that does not exist', async () => {
    const result = await runCliFailure(
      ['chats', 'sync', '@examplenews', '--account', '99'],
      6,
      options(),
    )

    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'ACCOUNT_NOT_FOUND' },
    })
    expect(stateOf(CHANNEL_PEER_ID)).toBeNull()
  })

  for (const args of [[], ['--off']]) {
    it(`rejects a missing chat${args.length ? ` with ${args.join(' ')}` : ''}`, async () => {
      const result = await runCliFailure(
        ['chats', 'sync', ...args],
        3,
        options(),
      )

      expect(result.json).toMatchObject({
        success: false,
        error: {
          code: 'INVALID_ARGS',
          message: 'Missing chat: pass @username or a chat ID',
        },
      })
    })
  }

  it('rejects a chat that is not in the cache', async () => {
    const result = await runCliFailure(
      ['chats', 'sync', '@unknownchat'],
      3,
      options(),
    )

    expect(result.json).toEqual({
      success: false,
      error: {
        code: 'INVALID_ARGS',
        message: 'Chat not found in the cache: @unknownchat',
        details: { chat: '@unknownchat' },
        suggestion: 'Run tg chats list --fresh or start the daemon, then retry',
      },
    })
  })

  it('is listed in tg chats --help', async () => {
    const result = await runCliSuccess(['chats', '--help'], options())

    expect(result.stdout).toContain('sync')
  })
})
