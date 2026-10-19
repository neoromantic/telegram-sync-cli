import type { tl } from '@mtcute/bun'

import type { CachedUser, UserCacheInput } from '../db/users-cache'
import type { Contact } from '../types'

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
    raw_json: JSON.stringify(user),
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
