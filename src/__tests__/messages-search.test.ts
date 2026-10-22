/**
 * Tests for messages search service (FTS5)
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'

describe('MessagesSearch', () => {
  let db: Database
  let messagesCache: ReturnType<typeof createMessagesCache>
  let usersCache: ReturnType<typeof createUsersCache>
  let chatsCache: ReturnType<typeof createChatsCache>

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    messagesCache = createMessagesCache(db)
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  function seedBaseData(): void {
    const now = Date.now()

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

    chatsCache.upsert({
      chat_id: '-1001234567890',
      type: 'supergroup',
      title: 'Team Chat',
      username: 'teamchat',
      member_count: 3,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: now,
      raw_json: '{}',
    })

    chatsCache.upsert({
      chat_id: '-200',
      type: 'group',
      title: 'Random',
      username: 'randomchat',
      member_count: 2,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: now,
      raw_json: '{}',
    })

    messagesCache.upsert({
      chat_id: -1001234567890,
      message_id: 1,
      from_id: 10,
      text: 'hello team',
      message_type: 'text',
      date: now - 1000,
      raw_json: '{}',
    })

    messagesCache.upsert({
      chat_id: -200,
      message_id: 2,
      from_id: 11,
      text: 'hello random',
      message_type: 'text',
      date: now - 500,
      raw_json: '{}',
    })

    messagesCache.upsert({
      chat_id: -1001234567890,
      message_id: 3,
      from_id: 11,
      text: 'hello deleted',
      message_type: 'text',
      is_deleted: true,
      date: now - 200,
      raw_json: '{}',
    })
  }

  it('searches text and orders results by date desc', () => {
    seedBaseData()

    const search = createMessagesSearch(db)
    const results = search.search('hello')

    expect(results).toHaveLength(2)
    expect(results[0]!.message_id).toBe(2)
    expect(results[1]!.message_id).toBe(1)
  })

  it('filters by chat, sender, and includeDeleted', () => {
    seedBaseData()

    const search = createMessagesSearch(db)

    const filtered = search.search('hello', {
      chatUsername: 'teamchat',
      senderUsername: 'alice',
    })

    expect(filtered).toHaveLength(1)
    expect(filtered[0]!.chat_username).toBe('teamchat')
    expect(filtered[0]!.sender_username).toBe('alice')

    const includeDeleted = search.search('hello', {
      chatUsername: 'teamchat',
      includeDeleted: true,
    })

    expect(includeDeleted).toHaveLength(2)
    expect(includeDeleted.map((row) => row.message_id).sort()).toEqual([1, 3])
  })

  it('filters by chatId (numeric)', () => {
    seedBaseData()

    const search = createMessagesSearch(db)

    // Filter by chat_id -1001234567890 (Team Chat)
    const results = search.search('hello', { chatId: -1001234567890 })

    expect(results).toHaveLength(1)
    expect(results[0]!.chat_id).toBe(-1001234567890)
    expect(results[0]!.message_id).toBe(1)
    expect(results[0]!.text).toBe('hello team')

    // Filter by chat_id -200 (Random)
    const results2 = search.search('hello', { chatId: -200 })

    expect(results2).toHaveLength(1)
    expect(results2[0]!.chat_id).toBe(-200)
    expect(results2[0]!.message_id).toBe(2)
    expect(results2[0]!.text).toBe('hello random')
  })

  it('filters by senderId (numeric)', () => {
    seedBaseData()

    const search = createMessagesSearch(db)

    // Filter by from_id 10 (Alice)
    const results = search.search('hello', { senderId: 10 })

    expect(results).toHaveLength(1)
    expect(results[0]!.from_id).toBe(10)
    expect(results[0]!.message_id).toBe(1)
    expect(results[0]!.sender_username).toBe('alice')

    // Filter by from_id 11 (Bob) - excludes deleted by default
    const results2 = search.search('hello', { senderId: 11 })

    expect(results2).toHaveLength(1)
    expect(results2[0]!.from_id).toBe(11)
    expect(results2[0]!.message_id).toBe(2)
    expect(results2[0]!.sender_username).toBe('bob')
  })

  it('combines chatId and senderId filters', () => {
    seedBaseData()

    const search = createMessagesSearch(db)

    // Both chatId and senderId matching (Alice in Team Chat)
    const results = search.search('hello', {
      chatId: -1001234567890,
      senderId: 10,
    })

    expect(results).toHaveLength(1)
    expect(results[0]!.chat_id).toBe(-1001234567890)
    expect(results[0]!.from_id).toBe(10)
    expect(results[0]!.message_id).toBe(1)

    // chatId matches but senderId doesn't match any non-deleted messages
    const results2 = search.search('hello', {
      chatId: -1001234567890,
      senderId: 11,
    })

    expect(results2).toHaveLength(0)

    // Include deleted to find Bob's message in Team Chat
    const results3 = search.search('hello', {
      chatId: -1001234567890,
      senderId: 11,
      includeDeleted: true,
    })

    expect(results3).toHaveLength(1)
    expect(results3[0]!.message_id).toBe(3)
    expect(results3[0]!.is_deleted).toBe(1)
  })

  it('hides a message deleted without chat context unless includeDeleted', () => {
    messagesCache.upsert({
      chat_id: 4242,
      message_id: 7,
      from_id: 4242,
      text: 'rehearsal moved to friday',
      message_type: 'text',
      date: Date.now(),
      raw_json: '{}',
    })

    messagesCache.markDeletedByMessageIds([7])

    const search = createMessagesSearch(db)
    expect(search.search('rehearsal')).toEqual([])

    const withDeleted = search.search('rehearsal', { includeDeleted: true })
    expect(withDeleted).toHaveLength(1)
    expect(withDeleted[0]).toMatchObject({
      chat_id: 4242,
      message_id: 7,
      is_deleted: 1,
    })
  })

  it('escapes FTS5 special characters in queries', () => {
    const now = Date.now()

    usersCache.upsert({
      user_id: '10',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Able',
      fetched_at: now,
      raw_json: '{}',
    })

    chatsCache.upsert({
      chat_id: '-1001234567890',
      type: 'supergroup',
      title: 'Test Chat',
      username: 'testchat',
      member_count: 2,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: now,
      raw_json: '{}',
    })

    // Message with hyphen (Russian "che-nit" slang)
    messagesCache.upsert({
      chat_id: -1001234567890,
      message_id: 1,
      from_id: 10,
      text: 'привет, че-нить новое?',
      message_type: 'text',
      date: now - 1000,
      raw_json: '{}',
    })

    // Message with asterisk
    messagesCache.upsert({
      chat_id: -1001234567890,
      message_id: 2,
      from_id: 10,
      text: 'test*value here',
      message_type: 'text',
      date: now - 500,
      raw_json: '{}',
    })

    // Message with parentheses
    messagesCache.upsert({
      chat_id: -1001234567890,
      message_id: 3,
      from_id: 10,
      text: 'function(arg) call',
      message_type: 'text',
      date: now - 200,
      raw_json: '{}',
    })

    const search = createMessagesSearch(db)

    // Search with hyphen should NOT throw "no such column" error
    const hyphenResults = search.search('че-нить')
    expect(hyphenResults).toHaveLength(1)
    expect(hyphenResults[0]!.message_id).toBe(1)

    // Search with asterisk (would be wildcard without escaping)
    const asteriskResults = search.search('test*value')
    expect(asteriskResults).toHaveLength(1)
    expect(asteriskResults[0]!.message_id).toBe(2)

    // Search with parentheses (would be grouping without escaping)
    const parenResults = search.search('function(arg)')
    expect(parenResults).toHaveLength(1)
    expect(parenResults[0]!.message_id).toBe(3)
  })
})

describe('MessagesSearch on a contentless and a regular index', () => {
  /**
   * The same made-up cache, with the search index of the given kind, on a
   * fixed clock so the rows' timestamps match
   */
  function buildCache(contentlessSearch: boolean): Database {
    const realNow = Date.now
    Date.now = () => 1_760_000_000_000
    try {
      return seedCache(contentlessSearch)
    } finally {
      Date.now = realNow
    }
  }

  function seedCache(contentlessSearch: boolean): Database {
    const db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db, { contentlessSearch })
    const now = 1_760_000_000_000
    const users = createUsersCache(db)
    const chats = createChatsCache(db)
    const messages = createMessagesCache(db)
    users.upsert({
      user_id: '10',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Able',
      fetched_at: now,
      raw_json: '{}',
    })
    users.upsert({
      user_id: '12',
      username: 'maria_example',
      first_name: 'Мария',
      last_name: null,
      fetched_at: now,
      raw_json: '{}',
    })
    for (const [chatId, title, username] of [
      ['-1001234567890', 'Team Chat', 'teamchat'],
      ['-300', 'Команда', null],
    ] as const) {
      chats.upsert({
        chat_id: chatId,
        type: 'supergroup',
        title,
        username,
        member_count: 3,
        access_hash: null,
        is_creator: 0,
        is_admin: 0,
        last_message_id: null,
        last_message_at: null,
        fetched_at: now,
        raw_json: '{}',
      })
    }
    messages.upsertBatch(
      [
        [-1001234567890, 1, 10, 'hello team, the plan is ready'],
        [-300, 2, 12, 'привет команда, встреча завтра'],
        [-300, 3, 10, 'hello again, draft attached'],
        [-1001234567890, 4, 12, 'first wording of the note'],
        [-1001234567890, 5, 10, 'hello from a message deleted later'],
      ].map(([chat_id, message_id, from_id, text]) => ({
        chat_id: chat_id as number,
        message_id: message_id as number,
        from_id: from_id as number,
        text: text as string,
        message_type: 'text',
        date: 1_760_000_000 + (message_id as number),
        raw_json: '{}',
      })),
    )
    messages.updateText(
      -1001234567890,
      4,
      'second wording of the note',
      1_760_000_100,
    )
    messages.markDeleted(-1001234567890, [5])
    return db
  }

  const queries = [
    'hello',
    'привет',
    'встреча',
    'alice',
    'Мария',
    'teamchat',
    'Команда',
    'wording',
  ]

  it('finds the same messages for text, Cyrillic, sender and chat queries', () => {
    const contentless = createMessagesSearch(buildCache(true))
    const regular = createMessagesSearch(buildCache(false))

    for (const query of queries) {
      const found = contentless.search(query)
      expect(found).toEqual(regular.search(query))
    }
    expect(contentless.search('hello', { includeDeleted: true })).toEqual(
      regular.search('hello', { includeDeleted: true }),
    )
    expect(contentless.search('hello').map((row) => row.message_id)).toEqual([
      3, 1,
    ])
    expect(contentless.search('Команда').map((row) => row.message_id)).toEqual([
      3, 2,
    ])
  })

  it('matches only the new text of an edited message', () => {
    for (const contentlessSearch of [true, false]) {
      const search = createMessagesSearch(buildCache(contentlessSearch))

      expect(search.search('first wording')).toEqual([])
      expect(search.search('second wording').map((row) => row.text)).toEqual([
        'second wording of the note',
      ])
    }
  })
})
