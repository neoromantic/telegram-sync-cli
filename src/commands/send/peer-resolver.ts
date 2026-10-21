import { type TelegramClient, tl } from '@mtcute/bun'

import type { CachedChat, ChatsCache } from '../../db/chats-cache'
import type { CachedUser, UsersCache } from '../../db/users-cache'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { toLong } from '../../utils/long'
import { verbose } from '../../utils/output'
import {
  CHANNEL_PEER_ID_OFFSET,
  getCandidateChatIds,
  toPeerIdFromInputPeer,
} from '../../utils/telegram-peer-ids'
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
  } catch (err) {
    // An RPC error means Telegram has no user with this number. Anything
    // else (missing credentials, a rate limit, a lost connection) is not an
    // answer, and the caller reports it.
    if (!tl.RpcError.is(err) || err.code === tl.RpcError.FLOOD) throw err
    resolvedUser = null
  }

  if (resolvedUser) {
    return buildUserPeerFromApi(resolvedUser, identifier)
  }

  throw new Error(`Could not resolve phone number ${identifier}`)
}

/** The input peer for a chats_cache row, which holds raw (unmarked) IDs */
function peerFromCachedChat(chat: CachedChat): ResolvedPeer {
  const id = Number(chat.chat_id)
  switch (chat.type) {
    case 'private':
      return {
        inputPeer: {
          _: 'inputPeerUser',
          userId: id,
          accessHash: toLong(chat.access_hash),
        },
        name: chat.title || `User ${id}`,
      }
    case 'group':
      return buildGroupPeer(id, chat.title || `Group ${id}`)
    default:
      return buildChannelPeerFromCache(chat, `Channel ${id}`)
  }
}

/** A bare ID from users_cache (with an access hash) or chats_cache */
function resolveCachedId(
  identifier: string,
  { usersCache, chatsCache }: CacheDeps,
): ResolvedPeer | null {
  const cachedUser = usersCache.getById(identifier)
  if (cachedUser?.access_hash) {
    verbose(`Found user ID ${identifier} in cache`)
    return buildUserPeerFromCache(cachedUser, `User ${identifier}`)
  }

  const cachedChat = chatsCache.getById(identifier)
  if (cachedChat) {
    verbose(`Found chat ID ${identifier} in cache`)
    return peerFromCachedChat(cachedChat)
  }

  return null
}

/** An ID the cache doesn't know is taken as a basic group */
function resolveUncachedId(identifier: string): ResolvedPeer {
  const numericId = Number.parseInt(identifier, 10)
  if (Number.isNaN(numericId)) {
    throw new Error(`Invalid peer identifier: ${identifier}`)
  }
  return buildGroupPeer(numericId, `Chat ${numericId}`)
}

/**
 * A marked ID, as messages_cache stores it: -N is basic group N and
 * -100… is a channel or supergroup. chats_cache holds raw IDs, so try each
 * raw candidate and keep a row only if it maps back to the same marked ID;
 * that stops user 4242 from answering for group -4242. Without a cached row
 * the peer is built from the ID alone, with no API call.
 */
function resolveByMarkedId(
  identifier: string,
  { chatsCache }: CacheDeps,
): ResolvedPeer {
  const marked = Number(identifier)
  if (!Number.isSafeInteger(marked)) {
    throw new Error(`Invalid peer identifier: ${identifier}`)
  }

  for (const candidate of getCandidateChatIds(marked)) {
    const cachedChat = chatsCache.getById(String(candidate))
    if (!cachedChat) continue
    const peer = peerFromCachedChat(cachedChat)
    if (toPeerIdFromInputPeer(peer.inputPeer, null) === marked) {
      verbose(`Found chat ID ${identifier} in cache`)
      return peer
    }
  }

  const abs = Math.abs(marked)
  if (abs > CHANNEL_PEER_ID_OFFSET) {
    return {
      inputPeer: {
        _: 'inputPeerChannel',
        channelId: abs - CHANNEL_PEER_ID_OFFSET,
        accessHash: toLong(0),
      },
      name: `Chat ${identifier}`,
    }
  }
  return buildGroupPeer(abs, `Chat ${identifier}`)
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

  if (/^-\d+$/.test(normalized)) {
    return resolveByMarkedId(normalized, deps)
  }

  // A bare number is an ID when the cache knows it. Otherwise 10+ digits
  // are still a phone number; `+` always means a phone number.
  const cached = /^\d+$/.test(normalized)
    ? resolveCachedId(normalized, deps)
    : null
  if (cached) return cached

  const phone = normalizePhone(normalized)
  if (phone) {
    return resolveByPhone(client, normalized, phone, deps)
  }

  return resolveUncachedId(normalized)
}
