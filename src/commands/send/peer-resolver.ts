import type { Database } from 'bun:sqlite'
import { type TelegramClient, tl } from '@mtcute/bun'

import { getErrorMessage } from '../../daemon/daemon-utils'
import {
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../../db/chat-sync-state'
import type { CachedChat, ChatsCache } from '../../db/chats-cache'
import {
  createMessagesCache,
  type MessagesCache,
} from '../../db/messages-cache'
import type { CachedUser, UsersCache } from '../../db/users-cache'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { toLong } from '../../utils/long'
import { verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import { toInputPeerFromPeerId } from '../../utils/telegram-peer-ids'
import { resolveUsername } from '../../utils/telegram-resolve'

export type ResolvedPeer = { inputPeer: tl.TypeInputPeer; name: string }

/** The identifier can't name a peer: bad input, not a Telegram failure */
export class InvalidPeerError extends Error {
  readonly identifier: string

  constructor(identifier: string) {
    super(`Invalid peer identifier: ${identifier}`)
    this.name = 'InvalidPeerError'
    this.identifier = identifier
  }
}

/**
 * A bare ID that 0.2.0 or older printed for a chat, which the cache knows as
 * both basic group N and channel N: bad input, the caller passes the
 * marked ID it means.
 */
export class AmbiguousPeerError extends Error {
  readonly identifier: string
  /** The marked IDs of the cached chats the number can name */
  readonly candidates: number[]

  constructor(identifier: string, candidates: number[]) {
    super(
      `Ambiguous chat ID ${identifier}: pass one of the marked IDs ${candidates.join(', ')}`,
    )
    this.name = 'AmbiguousPeerError'
    this.identifier = identifier
    this.candidates = candidates
  }
}

type TelegramClientLike = Pick<TelegramClient, 'call'>

/**
 * The cache tables that know a DM without a users_cache row: sync state (a
 * positive chat ID in chat_sync_state is always a user) and messages cached
 * under the user ID, which only a private chat has
 */
export type DmLookup = {
  chatSyncState: Pick<ChatSyncStateService, 'get'>
  messagesCache: Pick<MessagesCache, 'getOldestMessageId'>
}

export function createDmLookup(db: Database): DmLookup {
  return {
    chatSyncState: createChatSyncStateService(db),
    messagesCache: createMessagesCache(db),
  }
}

/**
 * Whether the cache knows user N: a users_cache row, sync state for the DM
 * or messages cached under N. Every command that reads a chat ID asks this
 * before it takes a positive ID as a group or channel ID as 0.2.0 printed
 * it, so `tg send`, `tg messages` and `tg chats` name the same chat.
 */
export function isKnownUserId(
  usersCache: Pick<UsersCache, 'getById'>,
  dms: DmLookup | undefined,
  id: number,
): boolean {
  return (
    usersCache.getById(String(id)) !== null ||
    dms?.chatSyncState.get(id) != null ||
    dms?.messagesCache.getOldestMessageId(id) != null
  )
}

type CacheDeps = {
  usersCache: UsersCache
  chatsCache: ChatsCache
  dms?: DmLookup
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

/** Keep a full user from Telegram, so the next lookup by ID hits the cache */
function cacheResolvedUser(usersCache: UsersCache, user: tl.RawUser): void {
  if (user.min) return
  try {
    usersCache.upsert(apiUserToCacheInput(user))
  } catch (err) {
    verbose(`Could not cache user ${user.id}: ${getErrorMessage(err)}`)
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
  const phone = identifier.replace(/[\s\-+()]/g, '')
  return /^\d+$/.test(phone) ? phone : null
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
    const peer = peerFromCachedChat(cachedChat, `@${username}`)
    if (peer?.inputPeer._ === 'inputPeerChannel') {
      verbose(`Found chat @${username} in cache`)
      return peer
    }
  }

  verbose(`Resolving @${username} via API...`)
  const resolved = await resolveUsername(client, username)
  const resolvedUser = resolved.users?.find(
    (user): user is tl.RawUser => user._ === 'user',
  )
  if (resolvedUser) {
    cacheResolvedUser(usersCache, resolvedUser)
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
    cacheResolvedUser(usersCache, resolvedUser)
    return buildUserPeerFromApi(resolvedUser, identifier)
  }

  throw new Error(`Could not resolve phone number ${identifier}`)
}

/**
 * The input peer for a chats_cache row, built from its marked ID. Null for
 * a row whose ID names no peer.
 */
function peerFromCachedChat(
  chat: CachedChat,
  fallbackName?: string,
): ResolvedPeer | null {
  const id = Number(chat.chat_id)
  const inputPeer = toInputPeerFromPeerId(id, chat.access_hash)
  if (!inputPeer) return null
  return { inputPeer, name: chat.title || fallbackName || `Chat ${id}` }
}

/**
 * A bare positive number that 0.2.0 or older printed for a group or channel:
 * `tg chats list` showed basic group N and channel N as N. Only the cache
 * answers. Two cached chats for one number are an error, since either could
 * be meant.
 */
function resolveLegacyChatId(
  identifier: string,
  { chatsCache }: CacheDeps,
): ResolvedPeer | null {
  const matches = chatsCache.getByLegacyId(Number(identifier))
  if (matches.length > 1) {
    throw new AmbiguousPeerError(
      identifier,
      matches.map((chat) => Number(chat.chat_id)),
    )
  }
  const [chat] = matches
  if (!chat) return null
  verbose(`Found chat ${chat.chat_id} in cache for the old ID ${identifier}`)
  return peerFromCachedChat(chat)
}

/**
 * A bare ID the cache knows. A positive marked ID is a user, so users come
 * first: one with an access hash, then a chats_cache row (a private chat),
 * then any other user the cache knows (isKnownUserId): one without a hash,
 * or a DM with sync state or cached messages. Telegram may refuse a user
 * peer without an access hash, but the peer is the right one, and cache
 * reads need no hash. Last, a group or channel ID as 0.2.0 printed it.
 */
function resolveCachedId(
  identifier: string,
  deps: CacheDeps,
): ResolvedPeer | null {
  const { usersCache, chatsCache, dms } = deps
  const cachedUser = usersCache.getById(identifier)
  if (cachedUser?.access_hash) {
    verbose(`Found user ID ${identifier} in cache`)
    return buildUserPeerFromCache(cachedUser, `User ${identifier}`)
  }

  // Only a private chat has a positive marked ID. A group or channel row
  // under one is a bare row from an older binary, re-keyed on the next open.
  const cachedChat = chatsCache.getById(identifier)
  if (cachedChat?.type === 'private') {
    verbose(`Found chat ID ${identifier} in cache`)
    return peerFromCachedChat(cachedChat, `User ${identifier}`)
  }

  const id = Number(identifier)
  if (Number.isSafeInteger(id) && isKnownUserId(usersCache, dms, id)) {
    verbose(`Found private chat ${identifier} in cache, without an access hash`)
    return buildUserPeerFromCache(
      cachedUser ?? {
        user_id: identifier,
        access_hash: null,
        display_name: null,
      },
      `User ${identifier}`,
    )
  }

  return resolveLegacyChatId(identifier, deps)
}

/**
 * An ID the cache doesn't know is taken as a basic group. Only plain digits
 * count: `Number.parseInt` would read `-12.5` as -12 and `1e1` as 1.
 */
function resolveUncachedId(identifier: string): ResolvedPeer {
  const numericId = /^\d+$/.test(identifier) ? Number(identifier) : 0
  if (!Number.isSafeInteger(numericId) || numericId === 0) {
    throw new InvalidPeerError(identifier)
  }
  return buildGroupPeer(numericId, `Chat ${numericId}`)
}

/**
 * A marked ID, as every cache table stores it: -N is basic group N and
 * -100… is a channel or supergroup. A cached row gives the access hash and
 * the title; without one the peer is built from the ID alone, with no API
 * call.
 */
function resolveByMarkedId(
  identifier: string,
  { chatsCache }: CacheDeps,
): ResolvedPeer {
  const marked = Number(identifier)
  if (!Number.isSafeInteger(marked) || marked >= 0) {
    throw new InvalidPeerError(identifier)
  }

  const cachedChat = chatsCache.getById(String(marked))
  const cachedPeer = cachedChat ? peerFromCachedChat(cachedChat) : null
  if (cachedPeer) {
    verbose(`Found chat ID ${identifier} in cache`)
    return cachedPeer
  }

  const inputPeer = toInputPeerFromPeerId(marked, null)
  if (!inputPeer) throw new InvalidPeerError(identifier)
  return { inputPeer, name: `Chat ${identifier}` }
}

const SELF_IDENTIFIERS = new Set(['me', 'self'])

export async function resolvePeer(
  client: TelegramClientLike,
  identifier: string,
  usersCache: UsersCache,
  chatsCache: ChatsCache,
  dms?: DmLookup,
): Promise<ResolvedPeer> {
  const normalized = identifier.trim()
  const deps = { usersCache, chatsCache, dms }

  if (SELF_IDENTIFIERS.has(normalized.toLowerCase())) {
    return { inputPeer: { _: 'inputPeerSelf' }, name: 'Saved Messages' }
  }

  // `+` always means a phone number, with or without spaces, dashes and
  // brackets, which would otherwise read as a username
  if (normalized.startsWith('+')) {
    const phone = normalizePhone(normalized)
    if (!phone) throw new InvalidPeerError(normalized)
    return resolveByPhone(client, normalized, phone, deps)
  }

  if (isUsernameIdentifier(normalized)) {
    const username = normalizeUsername(normalized)
    return resolveByUsername(client, username, deps)
  }

  if (/^-\d+$/.test(normalized)) {
    return resolveByMarkedId(normalized, deps)
  }

  // A positive number is an ID when the cache knows it: a user, a DM with
  // sync state or cached messages, or a group or channel ID as 0.2.0
  // printed it. Otherwise 10+ digits are still a phone number.
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
