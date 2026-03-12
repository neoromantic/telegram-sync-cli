import type { tl } from '@mtcute/tl'

import type { CachedUser, UsersCache } from '../../db/users-cache'

export interface UserInfo {
  id: number
  firstName: string
  lastName: string | null
  username: string | null
  phone: string | null
  isBot: boolean
  isPremium: boolean
  isContact: boolean
}

export type UserIdentifierKind = 'username' | 'phone' | 'id'

export interface ParsedIdentifier {
  kind: UserIdentifierKind
  value: string
  raw: string
}

export function apiUserToUserInfo(user: tl.RawUser): UserInfo {
  return {
    id: user.id,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    phone: user.phone ?? null,
    isBot: Boolean(user.bot),
    isPremium: Boolean(user.premium),
    isContact: Boolean(user.contact),
  }
}

export function cachedUserToUserInfo(cached: CachedUser): UserInfo {
  return {
    id: Number(cached.user_id),
    firstName: cached.first_name ?? '',
    lastName: cached.last_name ?? null,
    username: cached.username ?? null,
    phone: cached.phone ?? null,
    isBot: cached.is_bot === 1,
    isPremium: cached.is_premium === 1,
    isContact: cached.is_contact === 1,
  }
}

export function parseUserIdentifier(identifier: string): ParsedIdentifier {
  const isUsername =
    identifier.startsWith('@') ||
    (Number.isNaN(Number(identifier)) && !identifier.startsWith('+'))
  const isPhone = identifier.startsWith('+') || /^\d{10,}$/.test(identifier)

  if (isUsername) {
    return {
      kind: 'username',
      value: identifier.startsWith('@') ? identifier.slice(1) : identifier,
      raw: identifier,
    }
  }

  if (isPhone) {
    return {
      kind: 'phone',
      value: identifier.replace(/[\s+\-()]/g, ''),
      raw: identifier,
    }
  }

  return { kind: 'id', value: identifier, raw: identifier }
}

export function findCachedUser(
  usersCache: UsersCache,
  parsed: ParsedIdentifier,
): CachedUser | null {
  if (parsed.kind === 'username') {
    return usersCache.getByUsername(parsed.raw)
  }

  if (parsed.kind === 'phone') {
    return usersCache.getByPhone(parsed.value)
  }

  return usersCache.getById(parsed.value)
}
