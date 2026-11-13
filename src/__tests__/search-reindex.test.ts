/**
 * Fresh sender and chat names in the search index (#93): what the triggers
 * queue, and how the queue drains in batches. Made-up data only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readMigrationStatus,
  registerBackgroundMigrations,
  runPendingMigrations,
} from '../db/background-migrations'
import { type CachedChatInput, createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { runReindexBatch } from '../db/search-reindex'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache, type UserCacheInput } from '../db/users-cache'

const CHAT_ID = -1009000000001
const USER_ID = 5001
const MESSAGES = 10
const SMALL = { maxRows: 4, maxMs: 1_000 }

const user: UserCacheInput = {
  user_id: String(USER_ID),
  username: 'rose_fan',
  first_name: 'Ann',
  last_name: 'Example',
  fetched_at: 1,
  raw_json: '{}',
}

const chat: CachedChatInput = {
  chat_id: String(CHAT_ID),
  type: 'supergroup',
  title: 'Garden Club',
  username: null,
  member_count: 12,
  access_hash: null,
  is_creator: 0,
  is_admin: 0,
  last_message_id: null,
  last_message_at: null,
  fetched_at: 1,
  raw_json: '{}',
}

function open(path = ':memory:'): Database {
  const db = new Database(path)
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}

/** Messages of the user in the chat, written before either row */
function seedMessages(db: Database): void {
  createMessagesCache(db).upsertBatch(
    Array.from({ length: MESSAGES }, (_, i) => ({
      chat_id: CHAT_ID,
      message_id: i + 1,
      from_id: USER_ID,
      text: `note ${i + 1} about the roses`,
      message_type: 'text',
      date: 1_760_000_000 + i,
      raw_json: '{}',
    })),
  )
}

function queue(db: Database) {
  return db
    .query('SELECT kind, peer_id, cursor FROM search_reindex_queue')
    .all()
}

function matches(db: Database, query: string): number {
  return (
    db
      .query(
        'SELECT COUNT(*) AS n FROM message_search WHERE message_search MATCH ?',
      )
      .get(query) as { n: number }
  ).n
}

async function drain(db: Database): Promise<number> {
  return runPendingMigrations(db, { limits: SMALL })
}

describe('the re-index queue', () => {
  it('queues a sender and a chat cached after their messages', async () => {
    const db = open()
    seedMessages(db)
    expect(matches(db, 'sender:ann')).toBe(0)

    createUsersCache(db).upsert(user)
    createChatsCache(db).upsert(chat)
    expect(queue(db)).toEqual([
      { kind: 'sender', peer_id: USER_ID, cursor: 0 },
      { kind: 'chat', peer_id: CHAT_ID, cursor: 0 },
    ])

    expect(await drain(db)).toBe(2 * MESSAGES)
    expect(queue(db)).toEqual([])
    expect(matches(db, 'sender:ann AND sender:example')).toBe(MESSAGES)
    expect(matches(db, 'chat:"garden club"')).toBe(MESSAGES)
  })

  it('queues nothing for a peer without messages', () => {
    const db = open()
    createUsersCache(db).upsert(user)
    createChatsCache(db).upsert(chat)
    expect(queue(db)).toEqual([])
  })

  it('queues nothing for an upsert that changes no name', async () => {
    const db = open()
    seedMessages(db)
    const users = createUsersCache(db)
    const chats = createChatsCache(db)
    users.upsert(user)
    chats.upsert(chat)
    await drain(db)

    users.upsert({ ...user, phone: '15550000001', fetched_at: 2 })
    chats.upsert({ ...chat, member_count: 13, raw_json: '{"a":1}' })
    expect(queue(db)).toEqual([])
  })

  it('re-indexes a renamed sender and chat', async () => {
    const db = open()
    seedMessages(db)
    const users = createUsersCache(db)
    const chats = createChatsCache(db)
    users.upsert(user)
    chats.upsert(chat)
    await drain(db)

    users.upsert({ ...user, first_name: 'Annabel', fetched_at: 2 })
    chats.upsert({ ...chat, title: 'Rose Society', fetched_at: 2 })
    expect(queue(db)).toHaveLength(2)

    await drain(db)
    expect(matches(db, 'sender:annabel')).toBe(MESSAGES)
    expect(matches(db, 'sender:ann')).toBe(0)
    expect(matches(db, 'chat:"rose society"')).toBe(MESSAGES)
    expect(matches(db, 'chat:garden')).toBe(0)
    // The text is indexed as before
    expect(matches(db, 'text:roses')).toBe(MESSAGES)
  })

  it('leaves messages written after the rename alone', async () => {
    const db = open()
    seedMessages(db)
    createUsersCache(db).upsert(user)
    createMessagesCache(db).upsert({
      chat_id: CHAT_ID,
      message_id: 100,
      from_id: USER_ID,
      text: 'a later note',
      message_type: 'text',
      date: 1_760_001_000,
      raw_json: '{}',
    })
    expect(await drain(db)).toBe(MESSAGES)
  })
})

describe('draining in batches', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-reindex-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('resumes after a stop, without doing a message twice', async () => {
    const path = join(dir, 'cache.db')
    const first = open(path)
    seedMessages(first)
    createUsersCache(first).upsert(user)

    expect(runReindexBatch(first, SMALL)).toEqual({ rows: 4, finished: false })
    expect(queue(first)).toEqual([
      { kind: 'sender', peer_id: USER_ID, cursor: 4 },
    ])
    first.close()

    const second = open(path)
    expect(await drain(second)).toBe(MESSAGES - 4)
    expect(matches(second, 'sender:ann')).toBe(MESSAGES)
    second.close()
  })

  it('stops a batch at its time limit and keeps the cursor', () => {
    const db = open()
    seedMessages(db)
    createChatsCache(db).upsert(chat)
    let clock = 0
    const result = runReindexBatch(db, {
      maxRows: 100,
      maxMs: 3,
      now: () => clock++,
    })
    expect(result.finished).toBe(false)
    expect(result.rows).toBeLessThan(MESSAGES)
    expect(queue(db)).toEqual([
      { kind: 'chat', peer_id: CHAT_ID, cursor: result.rows },
    ])
  })

  it('rolls a failed batch back and keeps the queue', () => {
    const db = open()
    seedMessages(db)
    createUsersCache(db).upsert(user)
    db.run('DROP TABLE users_cache')

    expect(() => runReindexBatch(db, SMALL)).toThrow()
    expect(queue(db)).toEqual([{ kind: 'sender', peer_id: USER_ID, cursor: 0 }])
  })

  it('empties the queue when the whole index is rebuilt', () => {
    const db = open()
    seedMessages(db)
    createUsersCache(db).upsert(user)
    db.run(
      `UPDATE search_meta SET value = '0' WHERE key = 'search_index_version'`,
    )
    initSyncSchema(db)
    expect(queue(db)).toEqual([])
    expect(matches(db, 'sender:ann')).toBe(MESSAGES)
  })
})

describe('the one-off re-index of an older cache', () => {
  it('finds messages by senders and chats cached after them', async () => {
    const db = open()
    seedMessages(db)
    createUsersCache(db).upsert(user)
    createChatsCache(db).upsert(chat)
    // A cache written before the queue existed: names cached, never indexed
    db.run('DELETE FROM search_reindex_queue')
    db.run(`DELETE FROM cache_migrations WHERE name = 'message_search_names'`)
    registerBackgroundMigrations(db)

    expect(await drain(db)).toBe(MESSAGES)
    expect(matches(db, 'sender:ann')).toBe(MESSAGES)
    expect(matches(db, 'chat:garden')).toBe(MESSAGES)
    const names = readMigrationStatus(db).find(
      (status) => status.name === 'message_search_names',
    )
    expect(names).toMatchObject({ state: 'done', done: MESSAGES })
  })
})
