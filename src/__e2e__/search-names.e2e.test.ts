/**
 * E2E tests for fresh names in the search index (#93): after a rename, or a
 * sender cached after their messages, `tg db migrate` re-indexes the older
 * messages and `tg messages search` finds them by the new names. Made-up
 * data, no Telegram credentials.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { type CachedChatInput, createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createUsersCache, type UserCacheInput } from '../db/users-cache'
import type { MessageSearchItem } from '../types'
import { NO_CREDENTIALS, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const CHAT_ID = -1009000000002
const USER_ID = 6001

const user: UserCacheInput = {
  user_id: String(USER_ID),
  username: null,
  first_name: 'Marta',
  last_name: 'Example',
  fetched_at: 1,
  raw_json: '{}',
}

const chat: CachedChatInput = {
  chat_id: String(CHAT_ID),
  type: 'supergroup',
  title: 'Hiking Group',
  username: null,
  member_count: 40,
  access_hash: null,
  is_creator: 0,
  is_admin: 0,
  last_message_id: null,
  last_message_at: null,
  fetched_at: 1,
  raw_json: '{}',
}

describe('E2E: names in the search index', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('search-names')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000002', is_active: true }])
  })

  afterEach(() => {
    env.cleanup()
  })

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  })

  function seedMessages(): void {
    const db = env.openCacheDb(1)
    createMessagesCache(db).upsertBatch(
      [1, 2, 3].map((id) => ({
        chat_id: CHAT_ID,
        message_id: id,
        from_id: USER_ID,
        text: `trail report ${id}`,
        message_type: 'text',
        date: 1_760_000_000 + id,
        raw_json: '{}',
      })),
    )
  }

  async function ids(query: string): Promise<number[]> {
    const result = await runCliSuccess(
      ['messages', 'search', '--query', query],
      options(),
    )
    return (
      result.json as { data: { results: MessageSearchItem[] } }
    ).data.results
      .map((item) => item.messageId)
      .sort((a, b) => a - b)
  }

  async function migrate(): Promise<void> {
    await runCliSuccess(['db', 'migrate', '--account', '1'], options())
  }

  it('finds older messages by the new names after a rename', async () => {
    const db = env.openCacheDb(1)
    createUsersCache(db).upsert(user)
    createChatsCache(db).upsert(chat)
    seedMessages()
    expect(await ids('sender:marta')).toEqual([1, 2, 3])

    createUsersCache(db).upsert({ ...user, first_name: 'Martina' })
    createChatsCache(db).upsert({ ...chat, title: 'Mountain Walkers' })
    await migrate()

    expect(await ids('sender:martina')).toEqual([1, 2, 3])
    expect(await ids('sender:marta')).toEqual([])
    expect(await ids('chat:"mountain walkers"')).toEqual([1, 2, 3])
    expect(await ids('chat:hiking')).toEqual([])
  })

  it('finds messages by a sender and chat cached after them', async () => {
    seedMessages()
    expect(await ids('sender:marta')).toEqual([])

    const db = env.openCacheDb(1)
    createUsersCache(db).upsert(user)
    createChatsCache(db).upsert(chat)
    await migrate()

    expect(await ids('sender:marta AND trail')).toEqual([1, 2, 3])
    expect(await ids('chat:hiking')).toEqual([1, 2, 3])
  })
})
