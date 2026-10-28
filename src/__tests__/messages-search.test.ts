/**
 * Tests for messages search service (FTS5)
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import {
  createMessagesSearch,
  isFts5QueryError,
  toFts5Query,
} from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema, isContentlessSearch } from '../db/sync-schema'
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

    // A plain query quotes each word, so a hyphen is never syntax
    const hyphenResults = search.search('че-нить')
    expect(hyphenResults).toHaveLength(1)
    expect(hyphenResults[0]!.message_id).toBe(1)

    // An asterisk is FTS5 syntax: a prefix, then another word
    const asteriskResults = search.search('test*value')
    expect(asteriskResults).toHaveLength(1)
    expect(asteriskResults[0]!.message_id).toBe(2)

    // Parentheses are FTS5 syntax too; as a phrase they are punctuation
    expect(() => search.search('function(arg)')).toThrow(/fts5: syntax error/)
    const parenResults = search.search('function(arg)', { phrase: true })
    expect(parenResults).toHaveLength(1)
    expect(parenResults[0]!.message_id).toBe(3)
  })
})

describe('toFts5Query', () => {
  it('quotes each word of a plain query', () => {
    expect(toFts5Query('hello world')).toBe('"hello" "world"')
    expect(toFts5Query("  don't  e-mail ")).toBe('"don\'t" "e-mail"')
  })

  it('passes a query with FTS5 syntax as written', () => {
    for (const query of [
      'error OR timeout',
      '"exact phrase"',
      'sender:alice',
      'квартир*',
      'NEAR(one two)',
      '^start',
      'a NOT b',
    ]) {
      expect(toFts5Query(query)).toBe(query)
    }
  })

  it('reads lowercase operators and operator-like words as plain words', () => {
    expect(toFts5Query('cats and dogs')).toBe('"cats" "and" "dogs"')
    expect(toFts5Query('NOTES ORдер')).toBe('"NOTES" "ORдер"')
  })

  it('reads + and ^ inside a word as punctuation', () => {
    expect(toFts5Query('C++')).toBe('"C++"')
    expect(toFts5Query('learn c++ fast')).toBe('"learn" "c++" "fast"')
    expect(toFts5Query('2^10 a+b')).toBe('"2^10" "a+b"')
    // Between phrases and at the start of a word they stay FTS5 syntax
    expect(toFts5Query('hel* + world')).toBe('hel* + world')
    expect(toFts5Query('"a"+"b"')).toBe('"a"+"b"')
    expect(toFts5Query('x ^start')).toBe('x ^start')
  })

  it('makes the whole query one phrase with phrase', () => {
    expect(toFts5Query('say "hi" now', { phrase: true })).toBe(
      '"say ""hi"" now"',
    )
  })

  it('recognizes FTS5 query errors', () => {
    expect(isFts5QueryError(new Error('fts5: syntax error near "x"'))).toBe(
      true,
    )
    expect(isFts5QueryError(new Error('no such column: foo'))).toBe(true)
    expect(isFts5QueryError(new Error('unterminated string'))).toBe(true)
    expect(isFts5QueryError(new Error('database is locked'))).toBe(false)
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

  it('ranks, counts and limits by date the same way on both indexes', () => {
    const ranked = [true, false].map((contentlessSearch) =>
      createMessagesSearch(buildCache(contentlessSearch))
        .search('hello', { sort: 'relevance', includeDeleted: true })
        .map((row) => row.message_id),
    )
    expect(ranked[0]).toEqual(ranked[1]!)
    // Message 3 says hello in the shortest text, so bm25 ranks it first
    expect(ranked[0]![0]).toBe(3)
    expect(ranked[0]).not.toEqual([5, 3, 1])

    for (const contentlessSearch of [true, false]) {
      const search = createMessagesSearch(buildCache(contentlessSearch))

      expect(search.count('hello')).toBe(2)
      expect(search.count('hello', { includeDeleted: true })).toBe(3)
      expect(search.count('hello', { limit: 1 })).toBe(2)
      expect(
        search
          .search('hello', { since: 1_760_000_002, until: 1_760_000_004 })
          .map((row) => row.message_id),
      ).toEqual([3])
    }
  })

  it('reads matches with their text from the message_search_text view', () => {
    for (const contentlessSearch of [true, false]) {
      const db = buildCache(contentlessSearch)
      const sql = `SELECT message_id, text, chat_title, sender_username, rank
        FROM message_search_text
        WHERE message_search_text MATCH ? AND is_deleted = 0
        ORDER BY rank`
      const rows = db.query(sql).all('hello') as Array<{
        message_id: number
        text: string
        chat_title: string
        sender_username: string
        rank: number
      }>

      expect(rows.map((row) => row.message_id).sort()).toEqual([1, 3])
      expect(rows.find((row) => row.message_id === 1)).toMatchObject({
        text: 'hello team, the plan is ready',
        chat_title: 'Team Chat',
        sender_username: 'alice',
      })
      expect(rows[0]!.rank).toBeLessThanOrEqual(rows[1]!.rank)
      // SQLite flattens the view and gives the MATCH to FTS5
      const plan = (
        db.query(`EXPLAIN QUERY PLAN ${sql}`).all('hello') as Array<{
          detail: string
        }>
      ).map((row) => row.detail)
      expect(plan.some((step) => /VIRTUAL TABLE INDEX \d+:M/.test(step))).toBe(
        true,
      )
    }
  })

  it('keeps the view working when the index table is rebuilt', () => {
    const db = buildCache(false)
    // A newer SQLite drops the full-content table and builds a contentless one
    initSyncSchema(db, { contentlessSearch: true })
    expect(isContentlessSearch(db)).toBe(true)

    const rows = db
      .query(
        `SELECT message_id FROM message_search_text WHERE message_search_text MATCH 'привет'`,
      )
      .all() as Array<{ message_id: number }>
    expect(rows.map((row) => row.message_id)).toEqual([2])
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
