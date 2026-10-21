/**
 * Tests for chat history reads over messages_cache (src/db/messages-history.ts)
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'

import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesHistory } from '../db/messages-history'
import { createMessagesSearch } from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'

const CHAT_ID = -1001234567890
const OTHER_CHAT_ID = 10
const ALICE_ID = 10
const DATE = 1_760_000_000

describe('MessagesHistory', () => {
  let db: Database
  let history: ReturnType<typeof createMessagesHistory>

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    history = createMessagesHistory(db)

    const now = Date.now()
    createUsersCache(db).upsert({
      user_id: String(ALICE_ID),
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Able',
      fetched_at: now,
      raw_json: '{}',
    })
    createChatsCache(db).upsert({
      chat_id: String(OTHER_CHAT_ID),
      type: 'private',
      title: 'Alice Able',
      username: 'alice',
      member_count: null,
      access_hash: null,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: now,
      raw_json: '{}',
    })

    // Chat CHAT_ID holds ids 1-10; 9 is deleted. Dates run against id order,
    // so the tests prove that history pages by id, not date.
    const messagesCache = createMessagesCache(db)
    for (let id = 1; id <= 10; id++) {
      messagesCache.upsert({
        chat_id: CHAT_ID,
        message_id: id,
        from_id: ALICE_ID,
        text: `team message ${id}`,
        message_type: 'text',
        is_deleted: id === 9,
        date: DATE - id,
        raw_json: '{}',
      })
    }
    messagesCache.upsert({
      chat_id: OTHER_CHAT_ID,
      message_id: 5,
      from_id: ALICE_ID,
      text: 'other chat',
      message_type: 'text',
      date: DATE,
      raw_json: '{}',
    })
  })

  function ids(rows: Array<{ message_id: number }>) {
    return rows.map((row) => row.message_id)
  }

  describe('list', () => {
    it('returns the newest page, newest first, without deleted rows', () => {
      expect(ids(history.list(CHAT_ID, { limit: 3 }))).toEqual([10, 8, 7])
    })

    it('includes deleted rows when asked', () => {
      const rows = history.list(CHAT_ID, { limit: 3, includeDeleted: true })
      expect(ids(rows)).toEqual([10, 9, 8])
      expect(rows[1]?.is_deleted).toBe(1)
    })

    it('pages older with an exclusive before', () => {
      expect(ids(history.list(CHAT_ID, { limit: 3, before: 7 }))).toEqual([
        6, 5, 4,
      ])
      expect(ids(history.list(CHAT_ID, { limit: 3, before: 2 }))).toEqual([1])
      expect(history.list(CHAT_ID, { limit: 3, before: 1 })).toEqual([])
    })

    it('returns the messages right after an exclusive after, newest first', () => {
      expect(ids(history.list(CHAT_ID, { limit: 3, after: 0 }))).toEqual([
        3, 2, 1,
      ])
      expect(ids(history.list(CHAT_ID, { limit: 3, after: 3 }))).toEqual([
        6, 5, 4,
      ])
      expect(ids(history.list(CHAT_ID, { limit: 3, after: 7 }))).toEqual([
        10, 8,
      ])
      expect(history.list(CHAT_ID, { limit: 3, after: 10 })).toEqual([])
    })

    it('anchors a window with both bounds at after', () => {
      expect(
        ids(history.list(CHAT_ID, { limit: 3, after: 2, before: 7 })),
      ).toEqual([5, 4, 3])
      expect(
        ids(history.list(CHAT_ID, { limit: 10, after: 2, before: 7 })),
      ).toEqual([6, 5, 4, 3])
    })

    it('reads only the given chat', () => {
      expect(ids(history.list(OTHER_CHAT_ID, { limit: 20 }))).toEqual([5])
      expect(history.list(-4242, { limit: 20 })).toEqual([])
    })
  })

  describe('getMany', () => {
    it('returns the given ids newest first, deleted ones included', () => {
      const rows = history.getMany(CHAT_ID, [2, 9, 5, 404])
      expect(ids(rows)).toEqual([9, 5, 2])
      expect(rows[0]?.is_deleted).toBe(1)
    })

    it('returns nothing for no ids', () => {
      expect(history.getMany(CHAT_ID, [])).toEqual([])
    })
  })

  it('returns exactly the rows that search returns for the same message', () => {
    const search = createMessagesSearch(db)
    const [searchRow] = search.search('team message 4')
    const [otherSearchRow] = search.search('other chat')

    expect(history.list(CHAT_ID, { limit: 1, before: 5 })[0]).toEqual(
      searchRow!,
    )
    expect(history.getMany(CHAT_ID, [4])[0]).toEqual(searchRow!)
    expect(history.getMany(OTHER_CHAT_ID, [5])[0]).toEqual(otherSearchRow!)
    expect(otherSearchRow?.chat_title).toBe('Alice Able')
    expect(searchRow?.sender_first_name).toBe('Alice')
  })
})
