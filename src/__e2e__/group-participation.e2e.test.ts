/**
 * E2E: a group the account doesn't take part in adds no messages to the
 * cache, yet `tg messages list --fresh` still shows Telegram's page. The
 * page is a replay fixture recorded with a stub client, so no network is
 * used. Made-up data only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { TelegramClient } from '@mtcute/bun'

import { fetchMessagesRaw } from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createGroupParticipation } from '../db/group-participation'
import { wrapClientCallWithRecordReplay } from '../utils/telegram-record-replay'
import { runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

/** Basic group 4101 */
const GROUP_ID = -4101
const ALICE_ID = 7101

describe('E2E: groups the account does not take part in', () => {
  let env: TestEnvironment
  let fixturesDir: string

  beforeEach(() => {
    env = createTestEnvironment('group-participation')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000000', is_active: true }])
    fixturesDir = join(env.dataDir, 'fixtures')
    createChatsCache(env.openCacheDb(1)).upsert({
      chat_id: String(GROUP_ID),
      type: 'group',
      title: 'Made-up Hiking Club',
      username: null,
      member_count: 12,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: Date.now(),
      raw_json: '{}',
    })
  })

  afterEach(() => {
    env.cleanup()
  })

  /** Record the newest page of the group as the CLI asks for it */
  async function recordNewestPage(): Promise<void> {
    const now = Math.floor(Date.now() / 1000)
    const messages = [3, 2, 1].map((id) => ({
      _: 'message',
      id,
      date: now - 60 * id,
      peerId: { _: 'peerChat', chatId: -GROUP_ID },
      fromId: { _: 'peerUser', userId: ALICE_ID },
      message: `made-up trail note ${id}`,
    }))
    const client = wrapClientCallWithRecordReplay(
      {
        call: async () => ({
          _: 'messages.messages',
          messages,
          chats: [],
          users: [],
        }),
      } as unknown as TelegramClient,
      { accountId: 1, config: { mode: 'record', fixturesDir } },
    )
    await fetchMessagesRaw(
      client,
      { _: 'inputPeerChat', chatId: -GROUP_ID },
      { limit: 20 },
    )
  }

  function replayOptions() {
    return {
      env: {
        ...env.getCliOptions().env,
        TELEGRAM_API_REPLAY: '1',
        TELEGRAM_API_FIXTURES_DIR: fixturesDir,
        MTCUTE_LOG_LEVEL: undefined,
        VERBOSE: undefined,
      },
    }
  }

  function cachedCount(): number {
    return (
      env
        .openCacheDb(1)
        .query('SELECT COUNT(*) AS n FROM messages_cache')
        .get() as { n: number }
    ).n
  }

  it('shows the page with --fresh and caches none of it', async () => {
    await recordNewestPage()

    const result = await runCliSuccess(
      ['messages', 'list', '--chat', String(GROUP_ID), '--fresh'],
      replayOptions(),
    )

    const data = (
      result.json as {
        data: {
          source: string
          items: Array<{ messageId: number; text: string; chat: unknown }>
        }
      }
    ).data
    expect(data.source).toBe('api')
    expect(data.items.map((item) => item.messageId)).toEqual([3, 2, 1])
    expect(data.items[0]).toMatchObject({
      text: 'made-up trail note 3',
      chat: { id: GROUP_ID, title: 'Made-up Hiking Club', type: 'group' },
    })
    expect(cachedCount()).toBe(0)

    const chats = await runCliSuccess(
      ['chats', 'list', '--type', 'group'],
      env.getCliOptions(),
    )
    expect(
      (chats.json as { data: { items: unknown[] } }).data.items[0],
    ).toMatchObject({
      id: GROUP_ID,
      syncEnabled: false,
      syncReason: 'group_participation_unknown',
      lastOwnMessageAt: null,
    })
  })

  it('caches the page once the account took part in the last 90 days', async () => {
    await recordNewestPage()
    createGroupParticipation(env.openCacheDb(1)).observeOwnMessage(
      GROUP_ID,
      Math.floor(Date.now() / 1000) - 24 * 60 * 60,
    )

    await runCliSuccess(
      ['messages', 'list', '--chat', String(GROUP_ID), '--fresh'],
      replayOptions(),
    )

    expect(cachedCount()).toBe(3)
  })
})
