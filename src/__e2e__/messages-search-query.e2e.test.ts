/**
 * E2E tests for the query rules of tg messages search
 */

import type { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createUsersCache } from '../db/users-cache'
import type { MessageSearchItem } from '../types'
import { runCli, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const TEAM_CHAT_ID = -1001234567890
const BOOK_CLUB_ID = -4242
const ALICE_ID = 10
const BOB_ID = 11
const HOUR = 3600
const DAY = 24 * HOUR

/** Made-up messages: [id, chat, sender, text, age in seconds] */
const MESSAGES = [
  [1, TEAM_CHAT_ID, ALICE_ID, 'the deploy failed with an error', 1 * HOUR],
  [2, TEAM_CHAT_ID, BOB_ID, 'request timeout again', 2 * HOUR],
  [3, TEAM_CHAT_ID, ALICE_ID, 'hello there, wide world', 3 * HOUR],
  [4, BOOK_CLUB_ID, BOB_ID, 'world, hello', 2 * DAY],
  [5, BOOK_CLUB_ID, ALICE_ID, 'hello world from the club', 10 * DAY],
  [6, TEAM_CHAT_ID, BOB_ID, 'сдаю квартиру на месяц', 5 * DAY],
  [7, TEAM_CHAT_ID, ALICE_ID, 'квартира свободна', 6 * DAY],
  [8, BOOK_CLUB_ID, BOB_ID, "don't forget the e-mail", 20 * DAY],
  [9, BOOK_CLUB_ID, BOB_ID, 'function(arg) call', 30 * DAY],
] as const

function seed(db: Database): void {
  const now = Date.now()
  const users = createUsersCache(db)
  for (const [id, username, first] of [
    [ALICE_ID, 'alice', 'Alice'],
    [BOB_ID, 'bob', 'Bob'],
  ] as const) {
    users.upsert({
      user_id: String(id),
      username,
      first_name: first,
      last_name: null,
      fetched_at: now,
      raw_json: '{}',
    })
  }
  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: 'supergroup',
        id: 1234567890,
        title: 'Team Chat',
        username: 'teamchat',
        membersCount: 3,
      }),
      fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
    ].map(dialogToCacheInput),
  )
  const nowSec = Math.floor(now / 1000)
  createMessagesCache(db).upsertBatch(
    MESSAGES.map(([message_id, chat_id, from_id, text, age]) => ({
      chat_id,
      message_id,
      from_id,
      text,
      message_type: 'text',
      date: nowSec - age,
      raw_json: '{}',
    })),
  )
}

describe('E2E: messages search query rules', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTestEnvironment('messages-search-query')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000000', is_active: true }])
    seed(env.openCacheDb(1))
  })

  afterAll(() => {
    env.cleanup()
  })

  async function ids(...args: string[]): Promise<number[]> {
    const result = await runCliSuccess(
      ['messages', 'search', '--query', ...args],
      env.getCliOptions(),
    )
    return (
      result.json as { data: { results: MessageSearchItem[] } }
    ).data.results
      .map((item) => item.messageId)
      .sort((a, b) => a - b)
  }

  it('matches every word of a plain query in any order', async () => {
    expect(await ids('hello world')).toEqual([3, 4, 5])
  })

  it('matches a quoted phrase, and the whole query with --phrase', async () => {
    expect(await ids('"hello world"')).toEqual([5])
    expect(await ids('hello world', '--phrase')).toEqual([5])
  })

  it('passes OR, column filters and prefixes to FTS5', async () => {
    expect(await ids('error OR timeout')).toEqual([1, 2])
    expect(await ids('sender:alice')).toEqual([1, 3, 5, 7])
    expect(await ids('chat:club AND hello')).toEqual([4, 5])
    expect(await ids('hel*')).toEqual([3, 4, 5])
    expect(await ids('hello NOT club')).toEqual([3])
  })

  it('finds other word forms with a Cyrillic prefix', async () => {
    expect(await ids('квартир*')).toEqual([6, 7])
    expect(await ids('квартира')).toEqual([7])
  })

  it('reads punctuation in a plain query as part of a word', async () => {
    expect(await ids("don't")).toEqual([8])
    expect(await ids('e-mail')).toEqual([8])
    expect(await ids('function(arg)', '--phrase')).toEqual([9])
  })

  it('returns INVALID_ARGS with a suggestion for a query FTS5 cannot parse', async () => {
    for (const query of ['function(arg)', 'error OR', 'meet at 10:30']) {
      const result = await runCli(
        ['messages', 'search', '--query', query],
        env.getCliOptions(),
      )
      const json = result.json as {
        success: boolean
        error: { code: string; suggestion?: string }
      }
      expect(result.exitCode).toBe(3)
      expect(json.error.code).toBe('INVALID_ARGS')
      expect(json.error.suggestion).toContain('--phrase')
    }
  })
})
