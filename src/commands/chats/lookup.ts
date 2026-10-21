import type { Database } from 'bun:sqlite'

import { type CachedChat, createChatsCache } from '../../db/chats-cache'
import { createUsersCache } from '../../db/users-cache'
import {
  AmbiguousPeerError,
  createDmLookup,
  isKnownUserId,
} from '../send/peer-resolver'

/**
 * The cached chat for a numeric ID, the one `tg send --to` and
 * `tg messages --chat` resolve it to. A marked ID matches its chats_cache
 * row. A positive marked ID is a user, so a positive number matches only a
 * private chat; a group or channel row under one is a bare row from an older
 * binary, re-keyed on the next open. A number the cache knows as a user
 * (isKnownUserId, the check `tg send` uses too) names that user, cached as a
 * chat or not. Only then is it taken as a group or channel ID as 0.2.0
 * printed it (basic group -N or channel -100…N). Null for anything but plain
 * digits with an optional minus.
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
  if (isKnownUserId(createUsersCache(db), createDmLookup(db), id)) return null

  const legacy = chatsCache.getByLegacyId(id)
  if (legacy.length > 1) {
    throw new AmbiguousPeerError(
      input,
      legacy.map((chat) => Number(chat.chat_id)),
    )
  }
  return legacy[0] ?? null
}
