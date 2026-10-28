/**
 * chat_content_protection: the last online answer per chat. Made-up IDs.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createChatProtectionStore } from '../db/chat-protection'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

let db: Database

beforeEach(() => {
  db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
})

afterEach(() => {
  db.close()
})

describe('chat protection store', () => {
  it('has no row for a chat never checked', () => {
    expect(createChatProtectionStore(db).get(-1001234567890)).toBeNull()
  })

  it('records an answer and reads it back', () => {
    const store = createChatProtectionStore(db)
    store.record(-1001234567890, { protected: true, reason: 'chat' }, 1_000)
    store.record(5550001, { protected: true, reason: 'private_chat' }, 2_000)

    expect(store.get(-1001234567890)).toEqual({
      chat_id: -1001234567890,
      protected: 1,
      reason: 'chat',
      fetched_at: 1_000,
    })
    expect(store.get(5550001)?.reason).toBe('private_chat')
  })

  it('overwrites the row with the next check, a negative answer too', () => {
    const store = createChatProtectionStore(db)
    store.record(-4001, { protected: true, reason: 'chat' }, 1_000)
    store.record(-4001, { protected: false, reason: 'chat' }, 3_000)

    expect(store.get(-4001)).toEqual({
      chat_id: -4001,
      protected: 0,
      reason: null,
      fetched_at: 3_000,
    })
    expect(
      db.query('SELECT COUNT(*) AS n FROM chat_content_protection').get(),
    ).toEqual({ n: 1 })
  })

  it('creates the table once: a second schema run changes nothing', () => {
    createChatProtectionStore(db).record(
      -4001,
      { protected: true, reason: 'chat' },
      1_000,
    )
    initSyncSchema(db)
    expect(createChatProtectionStore(db).get(-4001)?.protected).toBe(1)
  })
})
