import type { TelegramClient, tl } from '@mtcute/bun'

import type { CachedChat, ChatsCache } from '../../db/chats-cache'
import type { CachedUser, UsersCache } from '../../db/users-cache'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { toLong } from '../../utils/long'
import { verbose } from '../../utils/output'
import { resolveUsername } from '../../utils/telegram-resolve'

export type ResolvedPeer = { inputPeer: tl.TypeInputPeer; name: string }

type TelegramClientLike = Pick<TelegramClient, 'call'>

type CacheDeps = {
  usersCache: UsersCache
  chatsCache: ChatsCache
}

type CachedUserRef = Pick<
  CachedUser,
  'user_id' | 'access_hash' | 'display_name'
>

function buildUserPeerFromCache(
  user: CachedUserRef,
  fallbackName: string,
): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerUser',
      userId: Number(user.user_id),
      accessHash: toLong(user.access_hash),
    },
    name: user.display_name || fallbackName,
  }
}

function buildUserPeerFromApi(
  user: tl.RawUser,
  fallbackName: string,
): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerUser',
      userId: user.id,
      accessHash: toLong(user.accessHash),
    },
    name:
      [user.firstName, user.lastName].filter(Boolean).join(' ') || fallbackName,
  }
}

function buildChannelPeerFromCache(
  chat: CachedChat,
  fallbackName: string,
): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerChannel',
      channelId: Number(chat.chat_id),
      accessHash: toLong(chat.access_hash),
    },
    name: chat.title || fallbackName,
  }
}

type ResolvedChannel = tl.RawChannel | tl.RawChannelForbidden

function buildChannelPeerFromApi(
  chat: ResolvedChannel,
  fallbackName: string,
): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerChannel',
      channelId: chat.id,
      accessHash: toLong(chat.accessHash),
    },
    name: chat.title || fallbackName,
  }
}

function buildGroupPeer(chatId: number, fallbackName: string): ResolvedPeer {
  return {
    inputPeer: {
      _: 'inputPeerChat',
      chatId,
    },
    name: fallbackName,
  }
}

function normalizePhone(identifier: string): string | null {
  if (!identifier.startsWith('+') && !/^\d{10,}$/.test(identifier)) {
    return null
  }
  return identifier.replace(/[\s\-+()]/g, '')
}

async function resolveByUsername(
  client: TelegramClientLike,
  username: string,
  { usersCache, chatsCache }: CacheDeps,
): Promise<ResolvedPeer> {
  const cachedUser = usersCache.getByUsername(username)
  if (cachedUser?.access_hash) {
    verbose(`Found user @${username} in cache`)
    return buildUserPeerFromCache(cachedUser, `@${username}`)
  }

  const cachedChat = chatsCache.getByUsername(username)
  if (
    cachedChat?.access_hash &&
    (cachedChat.type === 'channel' || cachedChat.type === 'supergroup')
  ) {
    verbose(`Found chat @${username} in cache`)
    return buildChannelPeerFromCache(cachedChat, `@${username}`)
  }

  verbose(`Resolving @${username} via API...`)
  const resolved = await resolveUsername(client, username)
  const resolvedUser = resolved.users?.find(
    (user): user is tl.RawUser => user._ === 'user',
  )
  if (resolvedUser) {
    return buildUserPeerFromApi(resolvedUser, `@${username}`)
  }

  const resolvedChat = resolved.chats?.[0]
  if (resolvedChat) {
    if (resolvedChat._ === 'channel' || resolvedChat._ === 'channelForbidden') {
      return buildChannelPeerFromApi(resolvedChat, `@${username}`)
    }
    if (resolvedChat._ === 'chat' || resolvedChat._ === 'chatForbidden') {
      return buildGroupPeer(resolvedChat.id, `@${username}`)
    }
  }

  throw new Error(`Could not resolve @${username}`)
}

async function resolveByPhone(
  client: TelegramClientLike,
  identifier: string,
  phone: string,
  { usersCache }: CacheDeps,
): Promise<ResolvedPeer> {
  const cachedUser = usersCache.getByPhone(phone)
  if (cachedUser?.access_hash) {
    verbose(`Found user with phone ${identifier} in cache`)
    return buildUserPeerFromCache(cachedUser, identifier)
  }

  verbose(`Resolving phone ${identifier} via API...`)
  let resolvedUser: tl.RawUser | null
  try {
    const request: tl.contacts.RawResolvePhoneRequest = {
      _: 'contacts.resolvePhone',
      phone,
    }
    const resolved = await client.call(request)
    resolvedUser =
      resolved.users?.find((user): user is tl.RawUser => user._ === 'user') ??
      null
  } catch {
    resolvedUser = null
  }

  if (resolvedUser) {
    return buildUserPeerFromApi(resolvedUser, identifier)
  }

  throw new Error(`Could not resolve phone number ${identifier}`)
}

function resolveByNumericId(
  identifier: string,
  { usersCache, chatsCache }: CacheDeps,
): ResolvedPeer {
  const numericId = Number.parseInt(identifier, 10)
  if (Number.isNaN(numericId)) {
    throw new Error(`Invalid peer identifier: ${identifier}`)
  }

  const cachedUser = usersCache.getById(identifier)
  if (cachedUser?.access_hash) {
    verbose(`Found user ID ${identifier} in cache`)
    return buildUserPeerFromCache(cachedUser, `User ${numericId}`)
  }

  const cachedChat = chatsCache.getById(identifier)
  if (cachedChat) {
    verbose(`Found chat ID ${identifier} in cache`)
    if (cachedChat.type === 'private') {
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: Number(cachedChat.chat_id),
          accessHash: toLong(cachedChat.access_hash),
        },
        name: cachedChat.title || `User ${numericId}`,
      }
    }
    if (cachedChat.type === 'group') {
      return buildGroupPeer(numericId, cachedChat.title || `Group ${numericId}`)
    }
    return buildChannelPeerFromCache(
      cachedChat,
      cachedChat.title || `Channel ${numericId}`,
    )
  }

  return buildGroupPeer(numericId, `Chat ${numericId}`)
}

const SELF_IDENTIFIERS = new Set(['me', 'self'])

export async function resolvePeer(
  client: TelegramClientLike,
  identifier: string,
  usersCache: UsersCache,
  chatsCache: ChatsCache,
): Promise<ResolvedPeer> {
  const normalized = identifier.trim()
  const deps = { usersCache, chatsCache }

  if (SELF_IDENTIFIERS.has(normalized.toLowerCase())) {
    return { inputPeer: { _: 'inputPeerSelf' }, name: 'Saved Messages' }
  }

  if (isUsernameIdentifier(normalized)) {
    const username = normalizeUsername(normalized)
    return resolveByUsername(client, username, deps)
  }

  const phone = normalizePhone(normalized)
  if (phone) {
    return resolveByPhone(client, normalized, phone, deps)
  }

  return resolveByNumericId(normalized, deps)
}
