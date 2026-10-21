/**
 * E2E tests for tg chats sync: cache-only, no Telegram credentials
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { assertPeerIdInvariants } from '../__tests__/helpers/peer-id-invariants'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'
import { runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

const NO_CREDENTIALS = {
  TELEGRAM_API_ID: undefined,
  TELEGRAM_API_HASH: undefined,
}

/** Bare IDs, as 0.2.0 printed them, and the marked IDs tg prints now */
const CHANNEL_ID = 1234567890
const CHANNEL_PEER_ID = -1001234567890
const GROUP_ID = 4001
const GROUP_PEER_ID = -4001

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
    clearedFailedJobs: number
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
    createChatsCache(cacheDb).upsertMany(
      [
        fakeDialog({
          kind: 'channel',
          id: CHANNEL_ID,
          title: 'Example News',
          username: 'examplenews',
          membersCount: 5000,
        }),
        fakeDialog({
          kind: 'group',
          id: GROUP_ID,
          title: 'Book Club',
          membersCount: 50,
        }),
      ].map(dialogToCacheInput),
    )
  })

  afterEach(() => {
    assertPeerIdInvariants(cacheDb)
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
    expect(channel?.id).toBe(CHANNEL_PEER_ID)
    return String(channel?.id)
  }

  for (const [label, chat] of [
    ['@username', async () => '@examplenews'],
    ['the ID from tg chats list', listedId],
    ['the bare ID that 0.2.0 printed', async () => String(CHANNEL_ID)],
  ] as const) {
    it(`turns sync on for ${label}`, async () => {
      const result = await sync(await chat())

      expect(result).toEqual({
        success: true,
        data: {
          id: CHANNEL_PEER_ID,
          peerId: CHANNEL_PEER_ID,
          type: 'channel',
          title: 'Example News',
          username: 'examplenews',
          mode: 'on',
          syncEnabled: true,
          historyComplete: false,
          syncedMessages: 0,
          changed: true,
          clearedFailedJobs: 0,
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
    await sync(String(GROUP_PEER_ID))
    const jobs = createSyncJobsService(cacheDb)
    jobs.create({
      chat_id: GROUP_PEER_ID,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.Realtime,
    })

    // The bare ID from 0.2.0 names the same group
    const result = await sync(String(GROUP_ID), '--off')

    expect(result.data).toMatchObject({
      id: GROUP_PEER_ID,
      peerId: GROUP_PEER_ID,
      type: 'group',
      mode: 'off',
      syncEnabled: false,
      changed: true,
    })
    expect(stateOf(GROUP_PEER_ID)).toMatchObject({
      sync_mode: 'off',
      sync_enabled: 0,
    })
    expect(jobs.getPendingJobs()).toEqual([])
  })

  describe('a chat whose sync jobs failed', () => {
    function failJobs(chatId: number, count: number) {
      const jobs = createSyncJobsService(cacheDb)
      for (let i = 0; i < count; i++) {
        const job = jobs.create({
          chat_id: chatId,
          job_type:
            i === 0 ? SyncJobType.InitialLoad : SyncJobType.BackwardHistory,
          priority: SyncPriority.High,
        })
        jobs.markRunning(job.id)
        jobs.markFailed(job.id, 'Telegram API error 400: CHANNEL_PRIVATE')
      }
    }

    const failedOf = (chatId: number) =>
      createSyncJobsService(cacheDb)
        .getFailedJobs(10)
        .filter((job) => job.chat_id === chatId)

    for (const [label, before, args] of [
      ['when the mode changes', [], []],
      ["when the mode didn't change", ['@examplenews'], []],
      ['with --off', ['@examplenews'], ['--off']],
    ] as const) {
      it(`deletes them ${label}, so the daemon retries them`, async () => {
        if (before.length > 0) await sync(...before)
        failJobs(CHANNEL_PEER_ID, 2)
        failJobs(GROUP_PEER_ID, 1)

        const result = await sync('@examplenews', ...args)

        expect(result.data.clearedFailedJobs).toBe(2)
        expect(result.data.changed).toBe(before.length === 0 || args.length > 0)
        expect(failedOf(CHANNEL_PEER_ID)).toEqual([])
        // Another chat's failed jobs stay
        expect(failedOf(GROUP_PEER_ID)).toHaveLength(1)
      })
    }
  })

  it('goes back to the default policy with --auto', async () => {
    await sync('@examplenews')
    await sync(String(GROUP_PEER_ID), '--off')

    const channel = await sync('@examplenews', '--auto')
    const group = await sync(String(GROUP_PEER_ID), '--auto')

    expect(channel.data).toMatchObject({ mode: 'auto', syncEnabled: false })
    expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({
      sync_mode: 'auto',
      sync_enabled: 0,
      sync_priority: SyncPriority.Low,
    })
    expect(group.data).toMatchObject({ mode: 'auto', syncEnabled: true })
    expect(stateOf(GROUP_PEER_ID)).toMatchObject({
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
      id: -1009876543210,
      peerId: -1009876543210,
      type: 'supergroup',
      title: null,
      mode: 'on',
      syncEnabled: true,
    })
  })

  for (const flag of ['--format', '-f']) {
    it(`takes a marked ID from tg chats list before ${flag} pretty`, async () => {
      const result = await runCliSuccess(
        ['chats', 'sync', String(CHANNEL_PEER_ID), flag, 'pretty'],
        options(),
      )

      // Pretty output is the data without the envelope
      expect(result.json).toMatchObject({
        id: CHANNEL_PEER_ID,
        title: 'Example News',
        mode: 'on',
      })
      expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({ sync_mode: 'on' })
    })
  }

  it('takes a positive ID with DM sync state as that DM, not as the basic group', async () => {
    // User 4001's DM, seen only live: sync state, no chats_cache row
    createChatSyncStateService(cacheDb).upsert({
      chat_id: GROUP_ID,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    const result = await sync(String(GROUP_ID), '--off')

    expect(result.data).toMatchObject({
      id: GROUP_ID,
      peerId: GROUP_ID,
      type: 'private',
      mode: 'off',
    })
    expect(stateOf(GROUP_ID)).toMatchObject({ sync_mode: 'off' })
    expect(stateOf(GROUP_PEER_ID)).toBeNull()
  })

  it('runs the retry command that tg status prints for a failed channel', async () => {
    createChatSyncStateService(cacheDb).upsert({
      chat_id: CHANNEL_PEER_ID,
      chat_type: 'channel',
      member_count: 5000,
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    })
    const jobs = createSyncJobsService(cacheDb)
    const job = jobs.create({
      chat_id: CHANNEL_PEER_ID,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.Low,
    })
    jobs.markRunning(job.id)
    jobs.markFailed(job.id, 'Telegram API error 400: CHANNEL_PRIVATE')

    const status = await runCliSuccess(
      ['status', '--format', 'pretty'],
      options(),
    )
    const retry = stripAnsi(status.stdout).match(/^\s+tg (chats sync .+)$/m)
    expect(retry?.[1]).toBe(`chats sync ${CHANNEL_PEER_ID} --auto`)

    const result = await runCliSuccess(retry![1]!.split(' '), options())
    expect((result.json as SyncResult).data).toMatchObject({
      id: CHANNEL_PEER_ID,
      title: 'Example News',
      mode: 'auto',
      clearedFailedJobs: 1,
    })
  })

  it('rejects a bare ID that names a cached group and a cached channel', async () => {
    createChatsCache(cacheDb).upsert(
      dialogToCacheInput(
        fakeDialog({ kind: 'supergroup', id: GROUP_ID, title: 'Club Talk' }),
      ),
    )

    const result = await runCliFailure(
      ['chats', 'sync', String(GROUP_ID)],
      3,
      options(),
    )

    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_ARGS',
        details: {
          chat: String(GROUP_ID),
          candidates: [GROUP_PEER_ID, -1000000004001],
        },
      },
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
        suggestion:
          'Start the daemon (its dialog pass lists every chat, archived ones too) or run tg chats get --id @username, then retry',
      },
    })
  })

  it('is listed in tg chats --help', async () => {
    const result = await runCliSuccess(['chats', '--help'], options())

    expect(result.stdout).toContain('sync')
  })
})
