/**
 * Tests for the core of `tg messages list` (src/commands/messages/history.ts)
 */
import { Database } from 'bun:sqlite'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'

import {
  createLazyClient,
  type HistoryClient,
  MessageNotFoundError,
  messageRowToItem,
  parseIntegerArg,
  reportHistoryError,
} from '../commands/messages/helpers'
import {
  aroundRequest,
  cacheHistoryResponse,
  fetchHistoryPage,
  fetchMessageAround,
  getMessageWithContext,
  type HistoryChat,
  type HistoryWindow,
  historyRequest,
  listHistory,
  type ResolveHistoryChatDeps,
  resolveHistoryChat,
} from '../commands/messages/history'
import { InvalidPeerError } from '../commands/send/peer-resolver'
import { ConfigError } from '../config'
import { type AccountsDbInterface, createTestDatabase } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges, type HistoryRange } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { createRateLimitsService } from '../db/rate-limits'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema, SyncPriority } from '../db/sync-schema'
import type { ChatType } from '../db/types'
import { createUsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'
import {
  RateLimitError,
  wrapClientCallWithRateLimits,
} from '../utils/telegram-rate-limits'
import {
  createFakeHistory,
  type GetHistoryRequest,
  range,
  rawMessage,
} from './helpers/fake-history'

const SELF_ID = 999
const ALICE_ID = 10
const BOB_ID = 11
const TEAM_CHAT_RAW_ID = 1234567890
const TEAM_CHAT_ID = -1001234567890
const BOOK_CLUB_ID = -4242
const NEW_USER_ID = 12
const LONG_NEW_USER_ID = 7_000_000_001
const DATE = 1_760_000_000

const TEAM_CHAT: HistoryChat = {
  chatId: TEAM_CHAT_ID,
  inputPeer: {
    _: 'inputPeerChannel',
    channelId: TEAM_CHAT_RAW_ID,
    accessHash: toLong('2222'),
  },
}

type CallClient = Pick<TelegramClient, 'call'>

function createCacheDb(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}

function cacheChat(
  db: Database,
  chatId: string,
  type: ChatType,
  title: string,
  username: string | null,
  accessHash: string | null,
) {
  createChatsCache(db).upsert({
    chat_id: chatId,
    type,
    title,
    username,
    member_count: null,
    access_hash: accessHash,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: '{}',
  })
}

function cacheMessages(db: Database, chatId: number, ids: number[]) {
  createMessagesCache(db).upsertBatch(
    ids.map((id) => ({
      chat_id: chatId,
      message_id: id,
      from_id: ALICE_ID,
      text: `cached ${id}`,
      message_type: 'text',
      date: DATE + id,
      raw_json: '{}',
    })),
  )
}

/** Messages the daemon cached as one run, so the cache can vouch for them */
function cacheRun(db: Database, chatId: number, low: number, high: number) {
  cacheMessages(db, chatId, range(low, high))
  createHistoryRanges(db).add(chatId, { low, high })
}

/** The recorded ranges of a chat, oldest first */
function storedRanges(db: Database, chatId = TEAM_CHAT_ID): HistoryRange[] {
  return db
    .query(
      'SELECT low, high FROM history_ranges WHERE chat_id = ? ORDER BY low',
    )
    .all(chatId) as HistoryRange[]
}

/** createFakeHistory, plus the senders a real getHistory response carries */
function historyClient(ids: number[], users: tl.TypeUser[] = []) {
  const fake = createFakeHistory(ids)
  const fakeCall = fake.client.call as unknown as (
    request: GetHistoryRequest,
  ) => Promise<Record<string, unknown>>
  const call = mock(async (request: GetHistoryRequest) => ({
    ...(await fakeCall(request)),
    users,
    chats: [],
  }))
  return {
    client: { call } as unknown as CallClient,
    call,
    requests: fake.requests,
  }
}

/** Alice as getHistory returns her with her messages */
const ALICE: tl.RawUser = {
  _: 'user',
  id: ALICE_ID,
  firstName: 'Alice',
  lastName: 'Able',
  username: 'alice',
  accessHash: toLong('1111'),
}

/** A client whose pages hold messages from Alice, with Alice in `users` */
function aliceClient(ids: number[]) {
  const fake = historyClient(ids, [ALICE])
  const call = mock(async (request: GetHistoryRequest) => {
    const result = (await fake.call(request)) as unknown as {
      messages: Array<Record<string, unknown>>
    }
    return {
      ...result,
      messages: result.messages.map((message) => ({
        ...message,
        fromId: { _: 'peerUser', userId: ALICE_ID },
      })),
    }
  })
  return { client: { call } as unknown as CallClient }
}

/** The fetched rows carry Alice's name, and search finds them by it */
function expectAliceCached(
  db: Database,
  rows: Parameters<typeof messageRowToItem>[0][],
) {
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(messageRowToItem(row).sender).toMatchObject({
      id: ALICE_ID,
      username: 'alice',
      firstName: 'Alice',
    })
  }
  expect(
    createMessagesSearch(db)
      .search('Alice')
      .map((hit) => hit.message_id)
      .sort((a, b) => b - a),
  ).toEqual(rowIds(rows).sort((a, b) => b - a))
}

/** A client that returns every message it has, ignoring the window */
function unboundedClient(ids: number[]) {
  const call = mock(async () => ({
    _: 'messages.messages',
    messages: [...ids].sort((a, b) => b - a).map(rawMessage),
    users: [],
    chats: [],
  }))
  return { client: { call } as unknown as CallClient, call }
}

function throwingFactory() {
  return mock((): HistoryClient => {
    throw new Error('the cache should have answered')
  })
}

function messageIds(items: Array<{ messageId: number }>) {
  return items.map((item) => item.messageId)
}

function rowIds(rows: Array<{ message_id: number }>) {
  return rows.map((row) => row.message_id)
}

/** Every cached message ID, newest first */
function storedIds(db: Database): number[] {
  const rows = db
    .query('SELECT message_id FROM messages_cache ORDER BY message_id DESC')
    .all() as Array<{ message_id: number }>
  return rowIds(rows)
}

describe('resolveHistoryChat', () => {
  let cacheDb: Database
  let accounts: AccountsDbInterface
  let deps: ResolveHistoryChatDeps

  beforeEach(() => {
    cacheDb = createCacheDb()
    accounts = createTestDatabase().accountsDb
    accounts.create({
      phone: '+15550000000',
      user_id: SELF_ID,
      is_active: true,
    })
    createUsersCache(cacheDb).upsert({
      user_id: String(ALICE_ID),
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Able',
      access_hash: '1111',
      fetched_at: Date.now(),
      raw_json: '{}',
    })
    cacheChat(cacheDb, '10', 'private', 'Alice Able', 'alice', '1111')
    cacheChat(
      cacheDb,
      String(TEAM_CHAT_RAW_ID),
      'supergroup',
      'Team Chat',
      'teamchat',
      '2222',
    )
    cacheChat(cacheDb, '4242', 'group', 'Book Club', null, null)
    // A private chat the daemon cached with no users_cache or chats_cache row
    const newDm = [NEW_USER_ID, LONG_NEW_USER_ID]
    for (const chatId of [
      ALICE_ID,
      TEAM_CHAT_ID,
      BOOK_CLUB_ID,
      SELF_ID,
      ...newDm,
    ]) {
      cacheRun(cacheDb, chatId, 1, 2)
    }
    deps = {
      usersCache: createUsersCache(cacheDb),
      chatsCache: createChatsCache(cacheDb),
      messagesCache: createMessagesCache(cacheDb),
      accounts,
      accountId: undefined,
    }
  })

  afterEach(() => {
    cacheDb.close()
  })

  it.each([
    ['@alice', ALICE_ID],
    ['10', ALICE_ID],
    ['@teamchat', TEAM_CHAT_ID],
    ['1234567890', TEAM_CHAT_ID],
    ['-1001234567890', TEAM_CHAT_ID],
    ['-4242', BOOK_CLUB_ID],
    ['me', SELF_ID],
    [String(NEW_USER_ID), NEW_USER_ID],
    [String(LONG_NEW_USER_ID), LONG_NEW_USER_ID],
  ])(
    'resolves and lists %p from the cache as chat %p',
    async (identifier, chatId) => {
      const create = throwingFactory()
      const client = createLazyClient(create)

      const chat = await resolveHistoryChat(client, identifier, deps)
      const result = await listHistory({
        cacheDb,
        client,
        chat,
        window: { limit: 20 },
        includeDeleted: false,
        fresh: false,
      })

      expect(chat.chatId).toBe(chatId)
      expect(result.chatId).toBe(chatId)
      expect(result.source).toBe('cache')
      expect(messageIds(result.items)).toEqual([2, 1])
      expect(create).not.toHaveBeenCalled()
    },
  )

  it('asks Telegram for the own user ID once when the account lacks it', async () => {
    const account = accounts.create({ phone: '+15550000001' })
    const getMe = mock(async () => ({ id: 1001 }))
    const create = mock(
      () => ({ getMe, call: mock() }) as unknown as HistoryClient,
    )
    const client = createLazyClient(create)
    const withAccount = { ...deps, accountId: account.id }

    const first = await resolveHistoryChat(client, 'me', withAccount)
    const second = await resolveHistoryChat(client, 'me', withAccount)

    expect(first.chatId).toBe(1001)
    expect(second.chatId).toBe(1001)
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(accounts.getById(account.id)?.user_id).toBe(1001)
  })
})

describe('createLazyClient', () => {
  it('creates the client on first use only', async () => {
    const call = mock(async () => ({ ok: true }))
    const create = mock(() => ({ call }) as unknown as HistoryClient)
    const client = createLazyClient(create)

    expect(create).not.toHaveBeenCalled()
    await client.call({ _: 'help.getConfig' })
    await client.call({ _: 'help.getConfig' })

    expect(create).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('historyRequest', () => {
  it('asks for the newest page by default', () => {
    expect(historyRequest({ limit: 20 })).toEqual({ offsetId: 0, limit: 20 })
  })

  it('asks for the page below --before', () => {
    expect(historyRequest({ limit: 20, before: 50 })).toEqual({
      offsetId: 50,
      limit: 20,
    })
  })

  it('asks for the page right above --after, like the daemon', () => {
    expect(historyRequest({ limit: 20, after: 50 })).toEqual({
      offsetId: 51,
      addOffset: -20,
      limit: 20,
      minId: 50,
      maxId: 0,
    })
    expect(historyRequest({ limit: 5, after: 50, before: 60 })).toEqual({
      offsetId: 51,
      addOffset: -5,
      limit: 5,
      minId: 50,
      maxId: 60,
    })
  })
})

describe('fetchHistoryPage', () => {
  let cacheDb: Database

  beforeEach(() => {
    cacheDb = createCacheDb()
  })

  afterEach(() => {
    cacheDb.close()
  })

  it.each<[HistoryWindow, number[]]>([
    [{ limit: 3 }, [10, 9, 8]],
    [{ limit: 3, before: 8 }, [7, 6, 5]],
    [{ limit: 3, after: 3 }, [6, 5, 4]],
    [{ limit: 3, after: 3, before: 6 }, [5, 4]],
    [{ limit: 3, after: 0 }, [3, 2, 1]],
    [{ limit: 3, before: 1 }, []],
  ])('fetches window %p as %p', async (window, expected) => {
    const { client } = historyClient(range(1, 10))

    const rows = await fetchHistoryPage(client, cacheDb, TEAM_CHAT, window)

    expect(rowIds(rows)).toEqual(expected)
  })

  it.each<[HistoryWindow, number[]]>([
    [{ limit: 3 }, [10, 9, 8]],
    [{ limit: 3, before: 8 }, [7, 6, 5]],
    [{ limit: 3, after: 3 }, [6, 5, 4]],
    [{ limit: 10, after: 3, before: 6 }, [5, 4]],
  ])(
    'drops messages outside window %p that Telegram returns',
    async (window, expected) => {
      const { client } = unboundedClient(range(1, 10))

      const rows = await fetchHistoryPage(client, cacheDb, TEAM_CHAT, window)

      expect(rowIds(rows)).toEqual(expected)
      expect(storedIds(cacheDb)).toEqual(expected)
    },
  )

  it.each<[HistoryWindow, HistoryRange[]]>([
    [{ limit: 3 }, [{ low: 8, high: 10 }]],
    [{ limit: 3, before: 8 }, [{ low: 5, high: 7 }]],
    [{ limit: 3, before: 3 }, [{ low: 1, high: 2 }]],
    [{ limit: 3, after: 3 }, [{ low: 4, high: 6 }]],
    [{ limit: 3, after: 0 }, [{ low: 1, high: 3 }]],
    [{ limit: 3, after: 8 }, [{ low: 9, high: 10 }]],
    [{ limit: 3, before: 1 }, []],
  ])('records the range that window %p covers', async (window, expected) => {
    const { client } = historyClient(range(1, 10))

    await fetchHistoryPage(client, cacheDb, TEAM_CHAT, window)

    expect(storedRanges(cacheDb)).toEqual(expected)
  })

  it('joins pages across ID gaps when paging back with nextBefore', async () => {
    // Private chats share one ID sequence per account, so a chat's IDs skip
    const { client } = historyClient([1, 2, 3, 7, 8, 9, 10])
    let before: number | undefined
    for (let page = 0; page < 4; page++) {
      const rows = await fetchHistoryPage(client, cacheDb, TEAM_CHAT, {
        limit: 2,
        before,
      })
      before = Math.min(...rowIds(rows))
    }

    expect(storedRanges(cacheDb)).toEqual([{ low: 1, high: 10 }])
  })

  it('stores the page under the marked chat ID with raw_json and fetched_at', async () => {
    const { client } = historyClient(range(1, 10))
    const before = Date.now()

    await fetchHistoryPage(client, cacheDb, TEAM_CHAT, { limit: 2 })

    const stored = cacheDb
      .query(
        'SELECT chat_id, message_id, raw_json, fetched_at FROM messages_cache ORDER BY message_id',
      )
      .all() as Array<{
      chat_id: number
      message_id: number
      raw_json: string
      fetched_at: number
    }>
    expect(stored.map((row) => [row.chat_id, row.message_id])).toEqual([
      [TEAM_CHAT_ID, 9],
      [TEAM_CHAT_ID, 10],
    ])
    for (const row of stored) {
      expect(JSON.parse(row.raw_json)).toMatchObject({ id: row.message_id })
      expect(row.fetched_at).toBeGreaterThanOrEqual(before)
    }
  })

  it('caches the senders of the page, so items carry their names', async () => {
    const { client } = aliceClient(range(1, 10))

    const rows = await fetchHistoryPage(client, cacheDb, TEAM_CHAT, {
      limit: 3,
    })

    expectAliceCached(cacheDb, rows)
  })

  it('adds a hint when Telegram cannot find a chat built from a bare ID', async () => {
    const call = mock(async () => {
      throw new Error('CHANNEL_INVALID')
    })

    await expect(
      fetchHistoryPage({ call } as unknown as CallClient, cacheDb, TEAM_CHAT, {
        limit: 3,
      }),
    ).rejects.toThrow(
      'CHANNEL_INVALID (run tg chats list --fresh or pass the @username)',
    )
  })
})

describe('cacheHistoryResponse', () => {
  it('caches full senders before their messages, so search finds them by name', () => {
    const cacheDb = createCacheDb()
    const alice: tl.RawUser = {
      _: 'user',
      id: ALICE_ID,
      firstName: 'Alice',
      lastName: 'Able',
      username: 'alice',
      accessHash: toLong('1111'),
    }
    const bob: tl.RawUser = {
      _: 'user',
      id: BOB_ID,
      min: true,
      firstName: 'Bob',
    }
    const message = {
      _: 'message',
      id: 7,
      date: DATE,
      message: 'see you at noon',
      fromId: { _: 'peerUser', userId: ALICE_ID },
    }

    const ids = cacheHistoryResponse(
      cacheDb,
      TEAM_CHAT_ID,
      [message, { _: 'messageEmpty', id: 8 }],
      [alice, bob],
      {},
    )

    expect(ids).toEqual([7])
    expect(storedRanges(cacheDb)).toEqual([{ low: 7, high: 8 }])
    const usersCache = createUsersCache(cacheDb)
    expect(usersCache.getById(String(ALICE_ID))).toMatchObject({
      first_name: 'Alice',
      access_hash: '1111',
    })
    expect(usersCache.getById(String(BOB_ID))).toBeNull()

    const [hit] = createMessagesSearch(cacheDb).search('Alice')
    expect(hit).toMatchObject({
      chat_id: TEAM_CHAT_ID,
      message_id: 7,
      sender_first_name: 'Alice',
    })
    cacheDb.close()
  })
})

describe('listHistory', () => {
  let cacheDb: Database

  beforeEach(() => {
    cacheDb = createCacheDb()
  })

  afterEach(() => {
    cacheDb.close()
  })

  function list(
    client: CallClient,
    window: HistoryWindow,
    options: { fresh?: boolean; includeDeleted?: boolean } = {},
  ) {
    return listHistory({
      cacheDb,
      client,
      chat: TEAM_CHAT,
      window,
      includeDeleted: options.includeDeleted ?? false,
      fresh: options.fresh ?? false,
    })
  }

  function syncState(historyComplete: boolean) {
    const state = createChatSyncStateService(cacheDb)
    state.upsert({
      chat_id: TEAM_CHAT_ID,
      chat_type: 'supergroup',
      sync_priority: SyncPriority.Medium,
      sync_enabled: true,
      forward_cursor: 5,
      backward_cursor: 2,
    })
    if (historyComplete) state.markHistoryComplete(TEAM_CHAT_ID)
    return state
  }

  it('serves a window the cache holds without a client', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 5)
    const create = throwingFactory()

    const result = await list(createLazyClient(create), {
      limit: 2,
      before: 5,
    })

    expect(result).toMatchObject({
      chatId: TEAM_CHAT_ID,
      limit: 2,
      before: 5,
      after: null,
      nextBefore: 3,
      nextAfter: 4,
      source: 'cache',
      stale: false,
    })
    expect(messageIds(result.items)).toEqual([4, 3])
    expect(create).not.toHaveBeenCalled()
  })

  it('asks Telegram for a window the cache does not hold, then caches it', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 5)
    const { client, requests } = historyClient(range(1, 10))

    const fetched = await list(client, { limit: 3, after: 5 })
    const cached = await list(client, { limit: 3, after: 5 })

    expect(fetched.source).toBe('api')
    expect(messageIds(fetched.items)).toEqual([8, 7, 6])
    expect(cached.source).toBe('cache')
    expect(cached.items).toEqual(fetched.items)
    expect(requests).toHaveLength(1)
    expect(storedRanges(cacheDb)).toEqual([{ low: 1, high: 8 }])
  })

  it('returns an empty page with null cursors', async () => {
    const { client } = historyClient([])

    const result = await list(client, { limit: 3 })

    expect(result).toMatchObject({
      items: [],
      nextBefore: null,
      nextAfter: null,
      source: 'api',
    })
  })

  it('always asks Telegram with fresh, and its items match the next cache read', async () => {
    cacheMessages(cacheDb, TEAM_CHAT_ID, range(1, 10))
    const { client, requests } = historyClient(range(1, 10))

    const fresh = await list(client, { limit: 3 }, { fresh: true })
    const cached = await list(client, { limit: 3 })

    expect(requests).toHaveLength(1)
    expect(fresh.source).toBe('api')
    expect(cached.source).toBe('cache')
    expect(fresh.items).toEqual(cached.items)
    expect(fresh.items[0]?.text).toBe('msg 10')
  })

  it('pages back to the first message without Telegram', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 5)
    const { client, requests } = historyClient(range(1, 5))

    const last = await list(client, { limit: 3, before: 2 })
    const end = await list(client, { limit: 3, before: 1 })

    expect(messageIds(last.items)).toEqual([1])
    expect(last.source).toBe('cache')
    expect(end.items).toEqual([])
    expect(end.source).toBe('cache')
    expect(requests).toHaveLength(0)
  })

  it('asks Telegram for messages cached outside any recorded range', async () => {
    // tg send and live updates cache messages without saying what is next
    // to them, and a fully synced chat from before ranges has none
    cacheMessages(cacheDb, TEAM_CHAT_ID, range(1, 5))
    syncState(true)
    const { client, requests } = historyClient(range(1, 5))

    const result = await list(client, { limit: 3, before: 3 })

    expect(messageIds(result.items)).toEqual([2, 1])
    expect(result.source).toBe('api')
    expect(requests).toHaveLength(1)
  })

  it('asks Telegram below the oldest recorded range', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 3, 5)
    const { client, requests } = historyClient(range(1, 5))

    const result = await list(client, { limit: 3, before: 3 })

    expect(messageIds(result.items)).toEqual([2, 1])
    expect(result.source).toBe('api')
    expect(requests).toHaveLength(1)
  })

  it('asks Telegram for a short page past the newest cached message', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 5)
    syncState(true)
    const { client, requests } = historyClient(range(1, 7))

    const result = await list(client, { limit: 3, after: 4 })

    expect(messageIds(result.items)).toEqual([7, 6, 5])
    expect(result.source).toBe('api')
    expect(requests).toHaveLength(1)
  })

  it('asks Telegram for newer messages between --after and --before in a fully synced chat', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 5)
    syncState(true)
    const { client, requests } = historyClient(range(1, 7))

    const result = await list(client, { limit: 3, after: 5, before: 8 })

    expect(result.source).toBe('api')
    expect(messageIds(result.items)).toEqual([7, 6])
    expect(requests).toHaveLength(1)
  })

  it('serves a short page between --after and --before that a range covers', async () => {
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 8)
    const create = throwingFactory()

    const result = await list(createLazyClient(create), {
      limit: 5,
      after: 5,
      before: 8,
    })

    expect(messageIds(result.items)).toEqual([7, 6])
    expect(result.source).toBe('cache')
  })

  describe('with gaps in the cache', () => {
    // Telegram holds 1-1000; the daemon cached the newest page, 951-1000
    let history: ReturnType<typeof historyClient>

    beforeEach(() => {
      history = historyClient(range(1, 1000))
      cacheRun(cacheDb, TEAM_CHAT_ID, 951, 1000)
    })

    it('starts --after 0 at the first message', async () => {
      const result = await list(history.client, { limit: 5, after: 0 })

      expect(result.source).toBe('api')
      expect(messageIds(result.items)).toEqual([5, 4, 3, 2, 1])
    })

    it('pages forward from a fetched page into the gap', async () => {
      await list(history.client, { limit: 5, before: 100 })

      const result = await list(history.client, { limit: 5, after: 99 })

      expect(result.source).toBe('api')
      expect(messageIds(result.items)).toEqual([104, 103, 102, 101, 100])
    })

    it('pages back with nextBefore without skipping the gap', async () => {
      await list(history.client, { limit: 5, before: 100 })
      const seen: number[] = []
      let before: number | undefined
      for (let page = 0; page < 6; page++) {
        const result = await list(history.client, { limit: 10, before })
        seen.push(...messageIds(result.items))
        before = result.nextBefore ?? undefined
      }

      expect(seen).toEqual(range(941, 1000).reverse())
      // 951-1000 came from the cache, 941-950 from Telegram
      expect(history.requests).toHaveLength(2)
      expect(storedRanges(cacheDb)).toEqual([
        { low: 95, high: 99 },
        { low: 941, high: 1000 },
      ])
    })
  })

  it('leaves the sync cursors alone', async () => {
    const state = syncState(false)
    const before = state.get(TEAM_CHAT_ID)
    const { client } = historyClient(range(1, 10))

    await list(client, { limit: 3 }, { fresh: true })
    await list(client, { limit: 3, after: 0 })

    const after = state.get(TEAM_CHAT_ID)
    expect(after?.forward_cursor).toBe(before!.forward_cursor)
    expect(after?.backward_cursor).toBe(before!.backward_cursor)
    expect(after?.history_complete).toBe(before!.history_complete)
  })
})

describe('aroundRequest', () => {
  it('asks for the message with N messages on each side', () => {
    expect(aroundRequest(50, 3)).toEqual({
      offsetId: 51,
      addOffset: -3,
      limit: 7,
    })
    expect(aroundRequest(50, 0)).toEqual({
      offsetId: 51,
      addOffset: 0,
      limit: 1,
    })
  })
})

describe('fetchMessageAround', () => {
  let cacheDb: Database

  beforeEach(() => {
    cacheDb = createCacheDb()
  })

  afterEach(() => {
    cacheDb.close()
  })

  it.each<[number, number, number[], number[]]>([
    [5, 2, [7, 6], [4, 3]],
    [10, 2, [], [9, 8]],
    [1, 2, [3, 2], []],
    [5, 0, [], []],
  ])(
    'fetches message %p with %p around it',
    async (messageId, context, newer, older) => {
      const { client } = historyClient(range(1, 10))

      const around = await fetchMessageAround(
        client,
        cacheDb,
        TEAM_CHAT,
        messageId,
        context,
      )

      expect(around.message.message_id).toBe(messageId)
      expect(rowIds(around.newer)).toEqual(newer)
      expect(rowIds(around.older)).toEqual(older)
      expect(storedIds(cacheDb)).toEqual(
        [...newer, messageId, ...older].sort((a, b) => b - a),
      )
    },
  )

  it.each<[number, number, HistoryRange]>([
    [5, 2, { low: 3, high: 7 }],
    [10, 2, { low: 8, high: 10 }],
    [2, 2, { low: 1, high: 4 }],
    [5, 0, { low: 5, high: 5 }],
  ])(
    'records the range around message %p with %p on each side',
    async (messageId, context, expected) => {
      const { client } = historyClient(range(1, 10))

      await fetchMessageAround(client, cacheDb, TEAM_CHAT, messageId, context)

      expect(storedRanges(cacheDb)).toEqual([expected])
    },
  )

  it('keeps the closest messages when Telegram returns more', async () => {
    const { client } = unboundedClient(range(1, 10))

    const around = await fetchMessageAround(client, cacheDb, TEAM_CHAT, 5, 1)

    expect(rowIds(around.newer)).toEqual([6])
    expect(rowIds(around.older)).toEqual([4])
    expect(storedIds(cacheDb)).toEqual([6, 5, 4])
  })

  it('caches the senders of the page, so items carry their names', async () => {
    const { client } = aliceClient(range(1, 10))

    const around = await fetchMessageAround(client, cacheDb, TEAM_CHAT, 5, 1)

    expectAliceCached(cacheDb, [
      ...around.newer,
      around.message,
      ...around.older,
    ])
  })

  it('sends limit 1 without context', async () => {
    const { client, requests } = historyClient(range(1, 10))

    await fetchMessageAround(client, cacheDb, TEAM_CHAT, 5, 0)

    expect(requests[0]).toMatchObject({ offsetId: 6, addOffset: 0, limit: 1 })
  })

  it('reports a message Telegram does not return as not found', async () => {
    const { client } = historyClient(range(1, 10))

    const failure = fetchMessageAround(client, cacheDb, TEAM_CHAT, 99, 2)

    await expect(failure).rejects.toBeInstanceOf(MessageNotFoundError)
    await expect(failure).rejects.toThrow(
      `Message 99 not found in chat ${TEAM_CHAT_ID}`,
    )
    expect(storedIds(cacheDb)).toEqual([])
  })
})

describe('getMessageWithContext', () => {
  let cacheDb: Database

  beforeEach(() => {
    cacheDb = createCacheDb()
    cacheRun(cacheDb, TEAM_CHAT_ID, 1, 8)
    createMessagesCache(cacheDb).markDeleted(TEAM_CHAT_ID, [6, 8])
  })

  afterEach(() => {
    cacheDb.close()
  })

  function get(
    client: CallClient,
    messageId: number,
    options: {
      context?: number
      fresh?: boolean
      includeDeleted?: boolean
      chat?: HistoryChat
    },
  ) {
    return getMessageWithContext({
      cacheDb,
      client,
      chat: options.chat ?? TEAM_CHAT,
      messageId,
      context: options.context ?? 0,
      includeDeleted: options.includeDeleted ?? false,
      fresh: options.fresh ?? false,
    })
  }

  it('serves a cached message and its context without a client', async () => {
    const create = throwingFactory()

    const result = await get(createLazyClient(create), 4, { context: 2 })

    expect(result).toMatchObject({
      chatId: TEAM_CHAT_ID,
      message: { messageId: 4, isDeleted: false },
      source: 'cache',
      stale: false,
    })
    expect(messageIds(result.newer)).toEqual([7, 5])
    expect(messageIds(result.older)).toEqual([3, 2])
    expect(create).not.toHaveBeenCalled()
  })

  it('returns a cached deleted message, with context by --includeDeleted', async () => {
    const create = throwingFactory()
    const client = createLazyClient(create)

    const deleted = await get(client, 8, { context: 2 })
    const withDeleted = await get(client, 8, {
      context: 2,
      includeDeleted: true,
    })

    expect(deleted.message).toMatchObject({ messageId: 8, isDeleted: true })
    expect(messageIds(deleted.older)).toEqual([7, 5])
    expect(messageIds(withDeleted.older)).toEqual([7, 6])
    expect(create).not.toHaveBeenCalled()
  })

  it('asks Telegram for older context when the cached message is the oldest', async () => {
    // The daemon cached only the newest page of this chat
    const aliceChat: HistoryChat = {
      chatId: ALICE_ID,
      inputPeer: {
        _: 'inputPeerUser',
        userId: ALICE_ID,
        accessHash: toLong('1111'),
      },
    }
    cacheRun(cacheDb, ALICE_ID, 50, 60)
    const { client, requests } = historyClient(range(1, 60))

    const result = await get(client, 50, { context: 3, chat: aliceChat })

    expect(result.source).toBe('api')
    expect(messageIds(result.newer)).toEqual([53, 52, 51])
    expect(messageIds(result.older)).toEqual([49, 48, 47])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ offsetId: 51, addOffset: -3, limit: 7 })
  })

  it('asks Telegram for newer context when nothing newer is cached', async () => {
    // 6 and 8 are deleted, so 7 is the newest message the cache can show
    const { client, requests } = historyClient([1, 2, 3, 4, 5, 7, 9])

    const result = await get(client, 7, { context: 2 })

    expect(result.source).toBe('api')
    expect(messageIds(result.newer)).toEqual([9])
    expect(messageIds(result.older)).toEqual([5, 4])
    expect(requests).toHaveLength(1)
  })

  it('serves no older context for the first message of a chat', async () => {
    const create = throwingFactory()

    const result = await get(createLazyClient(create), 1, { context: 2 })

    expect(result.source).toBe('cache')
    expect(messageIds(result.newer)).toEqual([3, 2])
    expect(result.older).toEqual([])
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps a cached message that Telegram no longer returns', async () => {
    const { client, requests } = historyClient(range(1, 6))

    const result = await get(client, 7, { context: 2 })

    expect(result.source).toBe('cache')
    expect(result.message.messageId).toBe(7)
    expect(result.newer).toEqual([])
    expect(messageIds(result.older)).toEqual([5, 4])
    expect(requests).toHaveLength(1)
  })

  it.each<[string, Error]>([
    [
      'without credentials',
      new ConfigError('TELEGRAM_API_ID environment variable is required', []),
    ],
    ['for a peer without an access hash', new Error('PEER_ID_INVALID')],
    ['while rate limited', new RateLimitError('messages.getHistory', 30)],
  ])(
    'serves the context the cache holds when Telegram cannot be asked %s',
    async (_name, failure) => {
      const call = mock(async () => {
        throw failure
      })

      // Nothing newer than 7 is cached (8 is deleted), so the cache lacks
      // the newer side
      const result = await get({ call } as unknown as CallClient, 7, {
        context: 2,
      })

      expect(call).toHaveBeenCalledTimes(1)
      expect(result.source).toBe('cache')
      expect(result.message.messageId).toBe(7)
      expect(result.newer).toEqual([])
      expect(messageIds(result.older)).toEqual([5, 4])
    },
  )

  it('serves a cached message alone when no recorded range is next to it', async () => {
    // A message that tg send or a live update cached
    cacheMessages(cacheDb, ALICE_ID, [42])
    const aliceChat: HistoryChat = {
      chatId: ALICE_ID,
      inputPeer: {
        _: 'inputPeerUser',
        userId: ALICE_ID,
        accessHash: toLong(0),
      },
    }
    const call = mock(async () => {
      throw new Error('PEER_ID_INVALID')
    })

    const result = await get({ call } as unknown as CallClient, 42, {
      context: 5,
      chat: aliceChat,
    })

    expect(result.source).toBe('cache')
    expect(result.message.messageId).toBe(42)
    expect(result.newer).toEqual([])
    expect(result.older).toEqual([])
  })

  it('reports a failed call with fresh, or for a message the cache lacks', async () => {
    const call = mock(async () => {
      throw new Error('PEER_ID_INVALID')
    })
    const client = { call } as unknown as CallClient

    await expect(get(client, 4, { context: 2, fresh: true })).rejects.toThrow(
      'PEER_ID_INVALID',
    )
    await expect(get(client, 11, { context: 2 })).rejects.toThrow(
      'PEER_ID_INVALID',
    )
  })

  it('asks Telegram for context across a gap in the cache', async () => {
    // Telegram holds 1-1000; the daemon cached 951-1000 and a list page 95-99
    const { client, requests } = historyClient(range(1, 1000))
    cacheRun(cacheDb, ALICE_ID, 951, 1000)
    const aliceChat: HistoryChat = {
      chatId: ALICE_ID,
      inputPeer: {
        _: 'inputPeerUser',
        userId: ALICE_ID,
        accessHash: toLong('1111'),
      },
    }
    await listHistory({
      cacheDb,
      client,
      chat: aliceChat,
      window: { limit: 5, before: 100 },
      includeDeleted: false,
      fresh: false,
    })

    const result = await get(client, 99, { context: 2, chat: aliceChat })

    expect(result.source).toBe('api')
    expect(messageIds(result.newer)).toEqual([101, 100])
    expect(messageIds(result.older)).toEqual([98, 97])
    expect(requests).toHaveLength(2)
  })

  it('asks Telegram for a message the cache does not hold', async () => {
    const { client, requests } = historyClient(range(1, 12))

    const result = await get(client, 11, { context: 1 })

    expect(result.source).toBe('api')
    expect(result.message.messageId).toBe(11)
    expect(messageIds(result.newer)).toEqual([12])
    expect(messageIds(result.older)).toEqual([10])
    expect(requests).toHaveLength(1)
  })

  it('always asks Telegram with fresh', async () => {
    const { client, requests } = historyClient(range(1, 8))

    const result = await get(client, 4, { context: 1, fresh: true })

    expect(result.source).toBe('api')
    expect(messageIds(result.newer)).toEqual([5])
    expect(messageIds(result.older)).toEqual([3])
    expect(result.message.text).toBe('msg 4')
    expect(requests).toHaveLength(1)
  })
})

describe('parseIntegerArg', () => {
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('parses plain digits in range and falls back to the default', () => {
    expect(parseIntegerArg('42', 'limit', { min: 1, max: 100 })).toBe(42)
    expect(parseIntegerArg(' 7 ', 'limit', { min: 1 })).toBe(7)
    expect(parseIntegerArg('0', 'after', { min: 0 })).toBe(0)
    expect(parseIntegerArg(undefined, 'limit', { min: 1, default: 20 })).toBe(
      20,
    )
    expect(parseIntegerArg(undefined, 'before', { min: 1 })).toBeUndefined()
  })

  it.each(['5abc', 'abc', '-1', '1.5', '', '1e3', '0x10'])(
    'rejects %p',
    (value) => {
      expect(() => parseIntegerArg(value, 'limit', { min: 0 })).toThrow(
        `Invalid --limit: ${value}`,
      )
    },
  )

  it('rejects values out of range with INVALID_ARGS', () => {
    for (const value of ['0', '101']) {
      try {
        parseIntegerArg(value, 'limit', { min: 1, max: 100 })
        throw new Error('expected a failure')
      } catch (err) {
        expect((err as { code?: string }).code).toBe('INVALID_ARGS')
      }
    }
  })
})

describe('reportHistoryError', () => {
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  function codeOf(err: unknown): { code?: string; message: string } {
    try {
      reportHistoryError(err, 'list messages')
    } catch (thrown) {
      return thrown as { code?: string; message: string }
    }
    throw new Error('expected reportHistoryError to throw')
  }

  it('maps missing credentials to INVALID_ARGS', () => {
    const reported = codeOf(
      new ConfigError('TELEGRAM_API_ID environment variable is required', []),
    )
    expect(reported.code).toBe('INVALID_ARGS')
    expect(reported.message).toContain('TELEGRAM_API_ID')
  })

  it('maps a malformed chat to INVALID_ARGS', () => {
    const reported = codeOf(new InvalidPeerError('-12.5'))
    expect(reported.code).toBe('INVALID_ARGS')
    expect(reported.message).toStartWith('Invalid --chat: -12.5.')
  })

  it('maps rate limits to RATE_LIMITED', () => {
    expect(codeOf(new RateLimitError('messages.getHistory', 30)).code).toBe(
      'RATE_LIMITED',
    )
  })

  it('maps the first FLOOD_WAIT from Telegram to RATE_LIMITED with the wait', async () => {
    const cacheDb = createCacheDb()
    const call = mock(async () => {
      throw tl.RpcError.fromTl({
        _: 'rpc_error',
        errorCode: 420,
        errorMessage: 'FLOOD_WAIT_30',
      })
    })
    const client = wrapClientCallWithRateLimits(
      { call } as unknown as TelegramClient,
      { rateLimits: createRateLimitsService(cacheDb) },
    )

    const failure = await fetchHistoryPage(client, cacheDb, TEAM_CHAT, {
      limit: 3,
    }).catch((err: unknown) => err)

    expect(codeOf(failure)).toMatchObject({
      code: 'RATE_LIMITED',
      details: { method: 'messages.getHistory', wait_seconds: 30 },
    })
    cacheDb.close()
  })

  it('maps a missing message to TELEGRAM_ERROR with its IDs', () => {
    let reported: { code?: string; message: string; details?: unknown }
    try {
      reportHistoryError(new MessageNotFoundError(TEAM_CHAT_ID, 99), 'get')
    } catch (thrown) {
      reported = thrown as typeof reported
    }
    expect(reported!).toMatchObject({
      code: 'TELEGRAM_ERROR',
      message: `Message 99 not found in chat ${TEAM_CHAT_ID}`,
      details: { chatId: TEAM_CHAT_ID, messageId: 99 },
    })
  })

  it('maps everything else to TELEGRAM_ERROR', () => {
    const reported = codeOf(new Error('CHANNEL_PRIVATE'))
    expect(reported.code).toBe('TELEGRAM_ERROR')
    expect(reported.message).toBe('Failed to list messages: CHANNEL_PRIVATE')
  })
})
