/**
 * E2E tests for the messages commands: search, list and get
 */

import { Database } from 'bun:sqlite'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import {
  initLegacySchema,
  LEGACY,
  seedLegacyCache,
} from '../__tests__/helpers/legacy-cache'
import { assertPeerIdInvariants } from '../__tests__/helpers/peer-id-invariants'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { PEER_ID_USER_VERSION } from '../db/peer-id-migration'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import type { MessageSearchItem } from '../types'
import { toPeerIdFromRawPeer } from '../utils/telegram-peer-ids'
import { NO_CREDENTIALS, runCli, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: Messages Search', () => {
  let env: TestEnvironment
  let cacheDb: Database | null = null

  beforeEach(() => {
    env = createTestEnvironment('messages-search')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+1111111111', name: 'Test Account', is_active: true },
    ])

    const cacheDbPath = join(env.dataDir, 'cache.db')
    cacheDb = new Database(cacheDbPath)
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)

    seedCacheData(cacheDb)
  })

  afterEach(() => {
    if (cacheDb) {
      cacheDb.close()
      cacheDb = null
    }
    env.cleanup()
  })

  it('filters by chat and sender', async () => {
    const result = await runCliSuccess(
      [
        'messages',
        'search',
        '--query',
        'hello',
        '--chat',
        '@teamchat',
        '--sender',
        '@alice',
      ],
      env.getCliOptions(),
    )

    const response = result.json as {
      success: boolean
      data: {
        results: Array<{
          messageId: number
          chat: { username: string | null }
          sender: { username: string | null }
        }>
        total: number
      }
    }

    expect(response.success).toBe(true)
    expect(response.data.total).toBe(1)
    expect(response.data.results[0]?.messageId).toBe(1)
    expect(response.data.results[0]?.chat.username).toBe('teamchat')
    expect(response.data.results[0]?.sender.username).toBe('alice')
  })

  it('includes deleted messages when requested', async () => {
    const result = await runCliSuccess(
      [
        'messages',
        'search',
        '--query',
        'hello',
        '--chat',
        '@teamchat',
        '--includeDeleted',
      ],
      env.getCliOptions(),
    )

    const response = result.json as {
      success: boolean
      data: {
        results: Array<{ messageId: number; isDeleted: boolean }>
        total: number
        filters: { includeDeleted: boolean }
      }
    }

    const messageIds = response.data.results.map((row) => row.messageId).sort()

    expect(response.success).toBe(true)
    expect(response.data.filters.includeDeleted).toBe(true)
    expect(response.data.total).toBe(2)
    expect(messageIds).toEqual([1, 2])
  })

  async function search(...args: string[]): Promise<MessageSearchItem[]> {
    const result = await runCliSuccess(
      ['messages', 'search', ...args],
      env.getCliOptions(),
    )
    return (result.json as { data: { results: MessageSearchItem[] } }).data
      .results
  }

  it('returns the chat of a supergroup message', async () => {
    const results = await search('--query', 'hello')
    const hit = results.find((item) => item.chatId === TEAM_CHAT_ID)

    expect(hit?.chat).toEqual({
      id: TEAM_CHAT_ID,
      title: 'Team Chat',
      username: 'teamchat',
      type: 'supergroup',
    })

    const filtered = await search('--query', 'hello', '--chat', '@teamchat')
    expect(filtered.map((item) => [item.chatId, item.messageId])).toEqual([
      [TEAM_CHAT_ID, 1],
    ])
  })

  it('gives every result its chat title and type', async () => {
    const results = await search('--query', 'hello')

    expect(results.map((item) => [item.chatId, item.chat.type])).toEqual([
      [ALICE_ID, 'private'],
      [NEWS_ID, 'channel'],
      [BOOK_CLUB_ID, 'group'],
      [TEAM_CHAT_ID, 'supergroup'],
    ])
    for (const item of results) {
      expect(item.chat.title).toEqual(expect.any(String))
    }
    const fromAlice = results.filter((item) => item.fromId === ALICE_ID)
    expect(fromAlice.map((item) => item.sender.firstName)).toEqual([
      'Alice',
      'Alice',
    ])
  })

  it('prints each chat under the ID that tg chats list prints', async () => {
    const list = await runCliSuccess(['chats', 'list'], env.getCliOptions())
    const listed = (
      list.json as { data: { items: Array<{ id: number; type: string }> } }
    ).data.items
    const results = await search('--query', 'hello')

    expect(listed.map((chat) => chat.type).sort()).toEqual([
      'channel',
      'group',
      'private',
      'supergroup',
    ])
    for (const chat of listed) {
      const hit = results.find((item) => item.chat.type === chat.type)
      expect([hit?.chatId, hit?.chat.id]).toEqual([chat.id, chat.id])
    }
  })

  it('finds a message by the title of its chat', async () => {
    const results = await search('--query', 'Book Club')

    expect(results.map((item) => [item.chatId, item.text])).toEqual([
      [BOOK_CLUB_ID, 'hello club'],
    ])
  })

  it('leaves the cache in one peer ID format', async () => {
    await search('--query', 'hello')

    const db = new Database(join(env.dataDir, 'cache.db'))
    try {
      assertPeerIdInvariants(db)
    } finally {
      db.close()
    }
  })
})

describe('E2E: Messages Search on a cache from 0.2.0', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTestEnvironment('messages-search-legacy')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000000', name: 'Test Account', is_active: true },
    ])
    const cacheDb = new Database(join(env.dataDir, 'cache.db'))
    initLegacySchema(cacheDb)
    seedLegacyCache(cacheDb)
    cacheDb.close()
  })

  afterAll(() => {
    env.cleanup()
  })

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  })

  async function search(query: string): Promise<MessageSearchItem[]> {
    const result = await runCliSuccess(
      ['messages', 'search', '--query', query],
      options(),
    )
    return (result.json as { data: { results: MessageSearchItem[] } }).data
      .results
  }

  it('shows group and channel titles on the first run', async () => {
    const results = await search('hello')

    expect(
      results.map((item) => [item.chatId, item.chat.title, item.chat.type]),
    ).toEqual(
      expect.arrayContaining([
        [LEGACY.teamChat.marked, 'Team Chat', 'supergroup'],
        [LEGACY.bookClub.marked, 'Book Club', 'group'],
        [LEGACY.news.marked, 'Example News', 'channel'],
        [LEGACY.alice.id, 'Alice Able', 'private'],
      ]),
    )
    expect(results).toHaveLength(4)
  })

  it('lists the chats under their marked IDs', async () => {
    const list = await runCliSuccess(['chats', 'list'], options())
    const ids = (list.json as { data: { items: Array<{ id: number }> } }).data
      .items

    expect(ids.map((chat) => chat.id).sort()).toEqual(
      [
        LEGACY.alice.id,
        LEGACY.teamChat.marked,
        LEGACY.bookClub.marked,
        LEGACY.news.marked,
      ].sort(),
    )
  })

  it('finds a message by the title of its chat', async () => {
    const results = await search('Team Chat')

    expect(results.map((item) => item.text)).toEqual([
      'weekly digest is out',
      'hello team',
    ])
  })

  it('prints a channel that posts as itself under its marked ID', async () => {
    const [hit] = await search('weekly digest')

    expect(hit).toMatchObject({
      fromId: LEGACY.senderChannel.marked,
      sender: { id: LEGACY.senderChannel.marked, firstName: null },
    })
  })

  it('joins every cached message to its chat in SQL', async () => {
    const result = await runCliSuccess(
      [
        'sql',
        '--query',
        'SELECT COUNT(DISTINCT m.chat_id) AS orphans FROM messages_cache m LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT) WHERE c.chat_id IS NULL',
      ],
      options(),
    )

    expect(result.json).toMatchObject({ data: { rows: [{ orphans: 0 }] } })

    const db = new Database(join(env.dataDir, 'cache.db'))
    try {
      expect(db.query('PRAGMA user_version').get()).toEqual({
        user_version: PEER_ID_USER_VERSION,
      })
      assertPeerIdInvariants(db)
    } finally {
      db.close()
    }
  })
})

/** Raw peers of the search fixture */
const TEAM_CHAT_PEER = { _: 'peerChannel', channelId: 1234567890 } as const
const BOOK_CLUB_PEER = { _: 'peerChat', chatId: 4242 } as const
const NEWS_PEER = { _: 'peerChannel', channelId: 2222222222 } as const
const ALICE_PEER = { _: 'peerUser', userId: 10 } as const
const BOB_PEER = { _: 'peerUser', userId: 11 } as const

/** A cached message, mapped from a raw one the way the sync worker maps it */
function syncedMessage(
  peer: Parameters<typeof toPeerIdFromRawPeer>[0] & object,
  id: number,
  text: string,
  from?: typeof ALICE_PEER | typeof BOB_PEER,
) {
  return parseRawMessage(
    {
      _: 'message',
      id,
      peerId: peer,
      ...(from ? { fromId: from } : {}),
      message: text,
      date: Math.floor(Date.now() / 1000) - 3600 + id * 60,
    },
    toPeerIdFromRawPeer(peer)!,
  )!
}

/**
 * Four chats, seeded the way the daemon caches them: the supergroup Team
 * Chat (@teamchat), the basic group Book Club, the channel Example News and
 * a DM with Alice
 */
function seedCacheData(db: Database): void {
  const now = Date.now()
  const usersCache = createUsersCache(db)

  usersCache.upsert({
    user_id: '10',
    username: 'alice',
    first_name: 'Alice',
    last_name: 'Able',
    fetched_at: now,
    raw_json: '{}',
  })

  usersCache.upsert({
    user_id: '11',
    username: 'bob',
    first_name: 'Bob',
    last_name: 'Baker',
    fetched_at: now,
    raw_json: '{}',
  })

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
      fakeDialog({
        kind: 'channel',
        id: 2222222222,
        title: 'Example News',
        username: 'examplenews',
      }),
      fakeDialog({ kind: 'user', id: 10, title: 'Alice Able' }),
    ].map(dialogToCacheInput),
  )

  createMessagesCache(db).upsertBatch([
    syncedMessage(TEAM_CHAT_PEER, 1, 'hello team', ALICE_PEER),
    {
      ...syncedMessage(TEAM_CHAT_PEER, 2, 'hello deleted', BOB_PEER),
      is_deleted: true,
    },
    syncedMessage(BOOK_CLUB_PEER, 3, 'hello club', BOB_PEER),
    // A channel post has no sender
    syncedMessage(NEWS_PEER, 4, 'hello subscribers'),
    syncedMessage(ALICE_PEER, 5, 'hello from Alice', ALICE_PEER),
  ])
}

interface ListData {
  chatId: number
  items: MessageSearchItem[]
  limit: number
  before: number | null
  after: number | null
  nextBefore: number | null
  nextAfter: number | null
  source: 'cache' | 'api'
  stale: boolean
}

interface ErrorData {
  success: false
  error: { code: string; message: string }
}

const SELF_ID = 999
/** The own user ID of the second, inactive account */
const SECOND_SELF_ID = 998
const SECOND_ACCOUNT_ID = 2
const ALICE_ID = 10
const TEAM_CHAT_ID = -1001234567890
const BOOK_CLUB_ID = -4242
const NEWS_ID = -1002222222222
/** Bob is in users_cache without an access hash */
const BOB_ID = 11
/** A private chat with cached messages and no users_cache or chats_cache row */
const NEW_DM_ID = 7_000_000_001

/**
 * One seeded cache for a describe block. The commands under test only read
 * it, so the blocks seed once. Every call runs without credentials: a cache
 * miss fails fast instead of reaching the network.
 */
function useSeededHistory(name: string) {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTestEnvironment(name)
    env.initDatabase()
    env.seedAccounts([
      {
        phone: '+15550000000',
        user_id: SELF_ID,
        name: 'Test Account',
        is_active: true,
      },
      {
        phone: '+15550000001',
        user_id: SECOND_SELF_ID,
        name: 'Second Account',
        is_active: false,
      },
    ])

    const cacheDb = new Database(join(env.dataDir, 'cache.db'))
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)
    seedHistory(cacheDb)
    cacheDb.close()
  })

  afterAll(() => {
    env.cleanup()
  })

  return () => ({ env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } })
}

describe('E2E: Messages List', () => {
  const options = useSeededHistory('messages-list')

  async function list(...args: string[]): Promise<ListData> {
    const result = await runCliSuccess(['messages', 'list', ...args], options())
    return (result.json as { data: ListData }).data
  }

  async function ids(...args: string[]): Promise<number[]> {
    return (await list(...args)).items.map((item) => item.messageId)
  }

  async function listFailure(...args: string[]) {
    const result = await runCli(['messages', 'list', ...args], options())
    return { exitCode: result.exitCode, json: result.json as ErrorData }
  }

  it('returns the newest page from the cache, newest first', async () => {
    const data = await list('--chat', '@alice', '--limit', '3')

    expect(data.items.map((item) => item.messageId)).toEqual([7, 6, 5])
    expect(data).toMatchObject({
      chatId: ALICE_ID,
      limit: 3,
      before: null,
      after: null,
      nextBefore: 5,
      nextAfter: 7,
      source: 'cache',
      stale: false,
    })
  })

  it('pages back with --before until the page is empty', async () => {
    const pages = [await ids('--chat', '@alice', '--limit', '3')]
    let data = await list('--chat', '@alice', '--limit', '3', '--before', '5')
    pages.push(data.items.map((item) => item.messageId))
    expect(pages[1]).toEqual([4, 3, 2])

    data = await list(
      '--chat',
      '@alice',
      '--limit',
      '3',
      '--before',
      String(data.nextBefore),
    )
    pages.push(data.items.map((item) => item.messageId))
    expect(pages[2]).toEqual([1])

    // Message IDs start at 1, so the end of history needs no Telegram call
    const end = await list('--chat', '@alice', '--limit', '3', '--before', '1')
    expect(end.items).toEqual([])
    expect(end.source).toBe('cache')
    expect(end.nextBefore).toBeNull()

    expect(pages.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('pages forward with --after, starting at 0', async () => {
    expect(
      await ids('--chat', '@alice', '--limit', '3', '--after', '0'),
    ).toEqual([3, 2, 1])
    expect(
      await ids('--chat', '@alice', '--limit', '3', '--after', '3'),
    ).toEqual([6, 5, 4])
    expect(
      await ids(
        '--chat',
        '@alice',
        '--limit',
        '3',
        '--after',
        '5',
        '--before',
        '8',
      ),
    ).toEqual([7, 6])
    expect(
      await ids(
        '--chat',
        '@alice',
        '--limit',
        '3',
        '--after',
        '2',
        '--before',
        '6',
      ),
    ).toEqual([5, 4, 3])
  })

  it('asks Telegram when the cache cannot vouch for the window', async () => {
    // Nothing newer than 7 is cached (8 is deleted), and no cached page
    // covers the message of the DM: both need Telegram, so credentials
    for (const args of [
      ['--chat', '@alice', '--after', '7'],
      ['--chat', String(NEW_DM_ID)],
    ]) {
      const { exitCode, json } = await listFailure(...args)
      expect(exitCode).toBe(3)
      expect(json.error.code).toBe('INVALID_ARGS')
      expect(json.error.message).toContain('TELEGRAM_API_ID')
    }
  })

  it.each(['+15550001111', '15550001111'])(
    'needs credentials to look up the phone number %p',
    async (chat) => {
      const { exitCode, json } = await listFailure('--chat', chat)
      expect(exitCode).toBe(3)
      expect(json.error.code).toBe('INVALID_ARGS')
      expect(json.error.message).toContain('TELEGRAM_API_ID')
    },
  )

  it('asks Telegram with --fresh even when the cache holds the page', async () => {
    expect((await list('--chat', '@alice')).source).toBe('cache')

    const { exitCode, json } = await listFailure('--chat', '@alice', '--fresh')

    expect(exitCode).toBe(3)
    expect(json.error.code).toBe('INVALID_ARGS')
    expect(json.error.message).toContain('TELEGRAM_API_ID')
  })

  it('reads Saved Messages of the account that --account selects', async () => {
    const data = await list(
      '--chat',
      'me',
      '--account',
      String(SECOND_ACCOUNT_ID),
    )

    expect(data.chatId).toBe(SECOND_SELF_ID)
    expect(data.items.map((item) => item.messageId)).toEqual([5])
  })

  it('skips deleted messages unless --includeDeleted', async () => {
    expect(await ids('--chat', '@alice')).not.toContain(8)

    const data = await list(
      '--chat',
      '@alice',
      '--includeDeleted',
      '--limit',
      '3',
    )
    expect(data.items.map((item) => item.messageId)).toEqual([8, 7, 6])
    expect(data.items[0]?.isDeleted).toBe(true)
  })

  it('accepts every chat form that tg prints', async () => {
    expect((await list('--chat', '10')).chatId).toBe(ALICE_ID)
    expect((await list('--chat', 'me')).chatId).toBe(SELF_ID)
    expect(await ids('--chat', 'me')).toEqual([2, 1])

    const byUsername = await list('--chat', '@teamchat')
    expect(byUsername.chatId).toBe(TEAM_CHAT_ID)
    expect(byUsername.items.map((item) => item.messageId)).toEqual([3, 2, 1])
    for (const chat of ['1234567890', '-1001234567890']) {
      const data = await list('--chat', chat)
      expect(data.chatId).toBe(TEAM_CHAT_ID)
      expect(data.items).toEqual(byUsername.items)
    }

    const bookClub = await list('--chat', '-4242')
    expect(bookClub.chatId).toBe(BOOK_CLUB_ID)
    expect(bookClub.items.map((item) => item.messageId)).toEqual([1])

    // A user with no access hash is user 11, not basic group -11
    const bob = await list('--chat', String(BOB_ID))
    expect(bob.chatId).toBe(BOB_ID)
    expect(bob.items.map((item) => item.text)).toEqual(['got the tickets'])
  })

  it('prints exactly the items that messages search prints', async () => {
    const listed = await list('--chat', '@teamchat')
    const search = await runCliSuccess(
      ['messages', 'search', '--query', 'pineapple'],
      options(),
    )
    const [hit] = (search.json as { data: { results: MessageSearchItem[] } })
      .data.results

    expect(hit).toBeDefined()
    expect(listed.items.find((item) => item.messageId === 2)).toEqual(hit!)
  })

  it.each([
    '--limit 0',
    '--limit 101',
    '--limit 5abc',
    '--before 0',
    '--before abc',
    '--before 2147483648',
    '--after -1',
    '--after 2147483647',
    '--after 5 --before 5',
  ])('rejects %p with INVALID_ARGS', async (flags) => {
    const { exitCode, json } = await listFailure(
      '--chat',
      '@alice',
      ...flags.split(' '),
    )
    expect(exitCode).toBe(3)
    expect(json.error.code).toBe('INVALID_ARGS')
    // A cache miss without credentials is INVALID_ARGS too: make sure the
    // flag was rejected before any Telegram call
    expect(json.error.message).not.toContain('TELEGRAM_API_ID')
    expect(json.error.message).toMatch(
      /^Invalid --(limit|before|after):|must be smaller than --before/,
    )
  })

  it.each(['--chat=', '--chat=-12.5', '--chat=1e1', '--chat=0x10'])(
    'rejects the malformed chat %p with INVALID_ARGS',
    async (flag) => {
      const result = await runCli(['messages', 'list', flag], options())
      const json = result.json as ErrorData

      expect(result.exitCode).toBe(3)
      expect(json.error.code).toBe('INVALID_ARGS')
      expect(json.error.message).toStartWith('Invalid --chat:')
    },
  )

  it('requires --chat', async () => {
    const result = await runCli(['messages', 'list'], options())
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Missing required argument')
  })
})

interface GetData {
  chatId: number
  message: MessageSearchItem
  newer: MessageSearchItem[]
  older: MessageSearchItem[]
  source: 'cache' | 'api'
  stale: boolean
}

describe('E2E: Messages Get', () => {
  const options = useSeededHistory('messages-get')

  async function get(...args: string[]): Promise<GetData> {
    const result = await runCliSuccess(['messages', 'get', ...args], options())
    return (result.json as { data: GetData }).data
  }

  function ids(items: MessageSearchItem[]) {
    return items.map((item) => item.messageId)
  }

  async function getFailure(...args: string[]) {
    const result = await runCli(['messages', 'get', ...args], options())
    return { exitCode: result.exitCode, json: result.json as ErrorData }
  }

  it('returns a message with its context from the cache', async () => {
    const data = await get('--chat', '@alice', '--id', '4', '--context', '2')

    expect(data.message.messageId).toBe(4)
    expect(ids(data.newer)).toEqual([6, 5])
    expect(ids(data.older)).toEqual([3, 2])
    expect(data).toMatchObject({
      chatId: ALICE_ID,
      source: 'cache',
      stale: false,
    })
  })

  it('serves the context the cache holds when Telegram cannot be asked', async () => {
    // 8 is deleted, so the cache has nothing newer than 7 to show. Telegram
    // would be asked for the newer side, but there are no credentials.
    const data = await get('--chat', '@alice', '--id', '7', '--context', '2')

    expect(data.message.messageId).toBe(7)
    expect(data.newer).toEqual([])
    expect(ids(data.older)).toEqual([6, 5])
    expect(data.source).toBe('cache')
  })

  it('serves no older context for the first message of a chat', async () => {
    const data = await get('--chat', '@alice', '--id', '1', '--context', '2')

    expect(ids(data.newer)).toEqual([3, 2])
    expect(data.older).toEqual([])
    expect(data.source).toBe('cache')
  })

  it('includes deleted context with --includeDeleted', async () => {
    const data = await get(
      '--chat',
      '@alice',
      '--id',
      '6',
      '--context',
      '2',
      '--includeDeleted',
    )

    expect(ids(data.newer)).toEqual([8, 7])
    expect(data.newer[0]?.isDeleted).toBe(true)
    expect(ids(data.older)).toEqual([5, 4])
    expect(data.source).toBe('cache')
  })

  it('asks Telegram with --fresh even when the message is cached', async () => {
    expect((await get('--chat', '@alice', '--id', '4')).source).toBe('cache')

    const { exitCode, json } = await getFailure(
      '--chat',
      '@alice',
      '--id',
      '4',
      '--fresh',
    )

    expect(exitCode).toBe(3)
    expect(json.error.code).toBe('INVALID_ARGS')
    expect(json.error.message).toContain('TELEGRAM_API_ID')
  })

  it('reads Saved Messages of the account that --account selects', async () => {
    const data = await get(
      '--chat',
      'me',
      '--id',
      '5',
      '--account',
      String(SECOND_ACCOUNT_ID),
    )

    expect(data.chatId).toBe(SECOND_SELF_ID)
    expect(data.message.text).toBe('renew the passport')
  })

  it('returns no context by default', async () => {
    const data = await get('--chat', '@alice', '--id', '4')

    expect(data.message.messageId).toBe(4)
    expect(data.newer).toEqual([])
    expect(data.older).toEqual([])
  })

  it('returns a deleted message that is cached', async () => {
    const data = await get('--chat', '@alice', '--id', '8')

    expect(data.message).toMatchObject({ messageId: 8, isDeleted: true })
    expect(data.source).toBe('cache')
  })

  it('prints the same item as tg messages list', async () => {
    const data = await get('--chat', '-1001234567890', '--id', '2')
    const listed = await runCliSuccess(
      ['messages', 'list', '--chat', '@teamchat'],
      options(),
    )
    const items = (listed.json as { data: ListData }).data.items

    expect(data.chatId).toBe(TEAM_CHAT_ID)
    expect(data.message).toEqual(items.find((item) => item.messageId === 2)!)
  })

  it('opens a search hit in a private chat that only the message cache knows', async () => {
    const search = await runCliSuccess(
      ['messages', 'search', '--query', 'kiwi'],
      options(),
    )
    const [hit] = (search.json as { data: { results: MessageSearchItem[] } })
      .data.results
    expect(hit?.chatId).toBe(NEW_DM_ID)

    const data = await get(
      '--chat',
      String(hit!.chatId),
      '--id',
      String(hit!.messageId),
      '--context',
      '5',
    )

    expect(data.chatId).toBe(NEW_DM_ID)
    expect(data.message).toEqual(hit!)
    expect(data.newer).toEqual([])
    expect(data.older).toEqual([])
    expect(data.source).toBe('cache')
  })

  it('asks Telegram for a message the cache does not hold', async () => {
    const { exitCode, json } = await getFailure(
      '--chat',
      '@alice',
      '--id',
      '99',
    )

    expect(exitCode).toBe(3)
    expect(json.error.code).toBe('INVALID_ARGS')
    expect(json.error.message).toContain('TELEGRAM_API_ID')
  })

  it.each([
    '--id 0',
    '--id abc',
    '--id 2147483647',
    '--id 4 --context -1',
    '--id 4 --context 50',
  ])('rejects %p with INVALID_ARGS', async (flags) => {
    const { exitCode, json } = await getFailure(
      '--chat',
      '@alice',
      ...flags.split(' '),
    )
    expect(exitCode).toBe(3)
    expect(json.error.code).toBe('INVALID_ARGS')
    expect(json.error.message).not.toContain('TELEGRAM_API_ID')
    expect(json.error.message).toMatch(/^Invalid --(id|context):/)
  })

  it('requires --id', async () => {
    const result = await runCli(
      ['messages', 'get', '--chat', '@alice'],
      options(),
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Missing required argument')
  })
})

function seedHistory(db: Database): void {
  const now = Date.now()
  const usersCache = createUsersCache(db)
  const messagesCache = createMessagesCache(db)

  usersCache.upsert({
    user_id: '10',
    username: 'alice',
    first_name: 'Alice',
    last_name: 'Able',
    access_hash: '1111',
    fetched_at: now,
    raw_json: '{}',
  })
  usersCache.upsert({
    user_id: '11',
    username: 'bob',
    first_name: 'Bob',
    last_name: 'Baker',
    fetched_at: now,
    raw_json: '{}',
  })

  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: 'user',
        id: ALICE_ID,
        title: 'Alice Able',
        username: 'alice',
      }),
      fakeDialog({
        kind: 'supergroup',
        id: 1234567890,
        title: 'Team Chat',
        username: 'teamchat',
      }),
      fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
    ].map(dialogToCacheInput),
  )

  const base = Math.floor(now / 1000) - 3600
  const message = (
    chatId: number,
    messageId: number,
    fromId: number,
    text: string,
    extra: { is_deleted?: boolean; is_outgoing?: boolean } = {},
  ) => ({
    chat_id: chatId,
    message_id: messageId,
    from_id: fromId,
    text,
    message_type: 'text',
    date: base + messageId * 60,
    raw_json: '{}',
    ...extra,
  })

  const aliceChat = [
    'hi!',
    'hi Alice',
    'lunch on Friday?',
    'sure, where?',
    'the noodle place',
    'see you at noon',
    'running late',
    'never mind',
  ].map((text, index) =>
    message(ALICE_ID, index + 1, index % 2 === 0 ? 10 : SELF_ID, text, {
      is_deleted: index === 7,
      is_outgoing: index % 2 === 1,
    }),
  )
  messagesCache.upsertBatch([
    ...aliceChat,
    message(TEAM_CHAT_ID, 1, 10, 'standup at ten'),
    message(TEAM_CHAT_ID, 2, 10, 'who ordered the pineapple pizza'),
    message(TEAM_CHAT_ID, 3, 11, 'guilty'),
    message(BOOK_CLUB_ID, 1, 11, 'next book: a short one'),
    message(SELF_ID, 1, SELF_ID, 'buy milk', { is_outgoing: true }),
    message(SELF_ID, 2, SELF_ID, 'call the dentist', { is_outgoing: true }),
    message(SECOND_SELF_ID, 5, SECOND_SELF_ID, 'renew the passport', {
      is_outgoing: true,
    }),
    message(BOB_ID, 1, BOB_ID, 'got the tickets'),
    message(NEW_DM_ID, 1, NEW_DM_ID, 'one kiwi smoothie, please'),
  ])

  // The pages the daemon cached, each a run from message 1. No page covers
  // the DM's message, as when a live update cached it.
  const ranges = createHistoryRanges(db)
  for (const [chatId, high] of [
    [ALICE_ID, 8],
    [TEAM_CHAT_ID, 3],
    [BOOK_CLUB_ID, 1],
    [SELF_ID, 2],
    [SECOND_SELF_ID, 5],
    [BOB_ID, 1],
  ] as const) {
    ranges.add(chatId, { low: 1, high })
  }
}
