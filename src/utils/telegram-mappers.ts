import type { tl } from '@mtcute/bun'

import type { CachedUser, UserCacheInput } from '../db/users-cache'
import type { Contact } from '../types'
import { toRawJson } from './raw-json'

export function apiUserToCacheInput(user: tl.RawUser): UserCacheInput {
  return {
    user_id: String(user.id),
    username: user.username ?? null,
    first_name: user.firstName ?? null,
    last_name: user.lastName ?? null,
    phone: user.phone ?? null,
    access_hash: user.accessHash ? String(user.accessHash) : null,
    is_contact: user.contact ? 1 : 0,
    is_bot: user.bot ? 1 : 0,
    is_premium: user.premium ? 1 : 0,
    fetched_at: Date.now(),
    raw_json: toRawJson(user),
  }
}

/**
 * A user that a history page mentions, for UsersCache.mergeMany: only the
 * fields the record has. A missing username, name or phone may be hidden
 * rather than gone, a missing `contact` flag says nothing about the contact
 * list, and without an access hash the other flags say nothing either.
 */
export function apiPageUserToCacheInput(user: tl.RawUser): UserCacheInput {
  const complete = user.accessHash !== undefined
  const flag = (value: boolean | undefined) =>
    value ? 1 : complete ? 0 : undefined
  return {
    user_id: String(user.id),
    username: user.username ?? undefined,
    first_name: user.firstName ?? undefined,
    last_name: user.lastName ?? undefined,
    phone: user.phone ?? undefined,
    access_hash: complete ? String(user.accessHash) : undefined,
    is_contact: user.contact ? 1 : undefined,
    is_bot: flag(user.bot),
    is_premium: flag(user.premium),
    fetched_at: Date.now(),
    raw_json: toRawJson(user),
  }
}

export function apiUserToContact(user: tl.RawUser): Contact {
  return {
    id: user.id,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    phone: user.phone ?? null,
  }
}

export function cachedUserToContact(cached: CachedUser): Contact {
  return {
    id: Number(cached.user_id),
    firstName: cached.first_name ?? '',
    lastName: cached.last_name ?? null,
    username: cached.username ?? null,
    phone: cached.phone ?? null,
  }
}
