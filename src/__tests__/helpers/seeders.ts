/**
 * Seeders for seedInChild: each takes the database and JSON arguments.
 * Made-up data only.
 */
import type { Database } from 'bun:sqlite'
import { createChatsCache } from '../../db/chats-cache'
import { createMessagesCache } from '../../db/messages-cache'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'
import { seedLegacyCache } from './legacy-cache'

/** A shared cache as 0.2.0 left it (see legacy-cache.ts) */
export function legacySharedCache(db: Database): void {
  initCacheSchema(db)
  initSyncSchema(db)
  seedLegacyCache(db)
}

/** The current schema with no rows */
export function emptyCache(db: Database): void {
  initCacheSchema(db)
  initSyncSchema(db)
}

/**
 * A shared cache whose rows are still in the WAL: checkpoints are off and
 * the process exits without closing it, so only the -wal file holds them
 */
export function cacheWithRowsInWal(
  db: Database,
  args: { messages: number },
): 'exit-without-close' {
  initCacheSchema(db)
  initSyncSchema(db)
  db.run('PRAGMA wal_autocheckpoint = 0')
  createChatsCache(db).upsert({
    chat_id: '-4242',
    type: 'group',
    title: 'Book Club',
    username: null,
    member_count: 5,
    access_hash: null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: '{}',
  })
  createMessagesCache(db).upsertBatch(
    Array.from({ length: args.messages }, (_, i) => ({
      chat_id: -4242,
      message_id: i + 1,
      text: `note ${i + 1}`,
      message_type: 'text',
      date: 1_760_000_000 + i,
      raw_json: '{}',
    })),
  )
  return 'exit-without-close'
}

/**
 * A shared cache that is already in rollback-journal mode, as a fold leaves
 * it: no -wal or -shm after the process exits
 */
export function foldedCache(db: Database, args: { empty?: boolean }): void {
  if (args?.empty) emptyCache(db)
  else legacySharedCache(db)
  db.run('PRAGMA journal_mode = DELETE')
}
