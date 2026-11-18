import { Database } from 'bun:sqlite'
import type { CachedChatInput } from '../../db/chats-cache'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'
import type { ChatType } from '../../db/types'

/** An in-memory account cache with the cache and sync schemas */
export function createAccountCacheDb(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}

/** A chats_cache row fetched now, with no username, hash or flags */
export function chatRow(
  chatId: number | string,
  type: ChatType,
  overrides: Partial<CachedChatInput> = {},
): CachedChatInput {
  return {
    chat_id: String(chatId),
    type,
    title: `Made-up chat ${chatId}`,
    username: null,
    member_count: null,
    access_hash: null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: '{}',
    ...overrides,
  }
}
