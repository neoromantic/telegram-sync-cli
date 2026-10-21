import type { Database } from 'bun:sqlite'

import { createChatSyncStateService } from '../../db/chat-sync-state'
import { type CachedChat, createChatsCache } from '../../db/chats-cache'
import { createMessagesCache } from '../../db/messages-cache'
import { createUsersCache } from '../../db/users-cache'
import { AmbiguousPeerError } from '../send/peer-resolver'

/**
 * Whether the cache knows user N: a users_cache row, sync state for the DM
 * (a positive chat ID in chat_sync_state is always a user), or messages
 * cached under N, which only a private chat has.
 */
function isKnownUserId(db: Database, id: number): boolean {
  return (
    createUsersCache(db).getById(String(id)) !== null ||
    createChatSyncStateService(db).get(id) !== null ||
    createMessagesCache(db).getOldestMessageId(id) !== null
  )
}

/**
 * The cached chat for a numeric ID, in the order `tg send --to` resolves it.
 * A marked ID matches its chats_cache row. A positive marked ID is a user, so
 * a positive number matches only a private chat; a group or channel row
 * under one is a bare row from an older binary, re-keyed on the next open.
 * A number the cache knows as a user names that user, cached as a chat or
 * not. Only then is it taken as a group or channel ID as 0.2.0 printed it
 * (basic group -N or channel -100…N). Null for anything but plain digits
 * with an optional minus.
 *
 * Throws AmbiguousPeerError when that bare ID names two cached chats.
 */
export function findCachedChatById(
  db: Database,
  input: string,
): CachedChat | null {
  if (!/^-?\d+$/.test(input)) return null
  const id = Number(input)
  if (!Number.isSafeInteger(id) || id === 0) return null

  const chatsCache = createChatsCache(db)
  const exact = chatsCache.getById(String(id))
  if (id < 0) return exact
  if (exact?.type === 'private') return exact
  if (isKnownUserId(db, id)) return null

  const legacy = chatsCache.getByLegacyId(id)
  if (legacy.length > 1) {
    throw new AmbiguousPeerError(
      input,
      legacy.map((chat) => Number(chat.chat_id)),
    )
  }
  return legacy[0] ?? null
}
