import type { Dialog, TelegramClient, tl } from '@mtcute/bun'

import type { CachedChat, CachedChatInput } from '../../db/chats-cache'
import type { ChatType } from '../../db/types'
import { toRawJson } from '../../utils/raw-json'
import {
  toPeerIdFromRawChat,
  toPeerIdFromRawPeer,
} from '../../utils/telegram-peer-ids'

export interface ChatItem {
  /** Marked peer ID, as messages_cache and `tg messages search` use it */
  id: number
  type: ChatType
  title: string
  username: string | null
  memberCount: number | null
  lastMessageAt: number | null
  isCreator: boolean
  isAdmin: boolean
}

export const CHAT_TYPE_VALUES = [
  'private',
  'group',
  'supergroup',
  'channel',
  'community',
] as const satisfies ChatType[]

export function isValidChatType(value: string | undefined): value is ChatType {
  return value !== undefined && CHAT_TYPE_VALUES.includes(value as ChatType)
}

type ChatRow = CachedChat | CachedChatInput

export function chatRowToItem(chat: ChatRow): ChatItem {
  return {
    id: Number(chat.chat_id),
    type: chat.type,
    title: chat.title ?? '',
    username: chat.username,
    memberCount: chat.member_count,
    lastMessageAt: chat.last_message_at,
    isCreator: chat.is_creator === 1,
    isAdmin: chat.is_admin === 1,
  }
}

export function filterChatsByType(
  chats: CachedChatInput[],
  typeFilter?: ChatType,
): CachedChatInput[] {
  if (!typeFilter) return chats
  return chats.filter((chat) => chat.type === typeFilter)
}

export function getChatType(dialog: Dialog): ChatType {
  const peer = dialog.peer
  if (peer.type === 'user') return 'private'
  if (peer.chatType === 'community') return 'community'
  if (peer.chatType === 'supergroup' || peer.chatType === 'gigagroup') {
    return 'supergroup'
  }
  if (peer.chatType === 'channel' || peer.chatType === 'monoforum') {
    return 'channel'
  }
  return 'group'
}

/**
 * A chats_cache row for a dialog, under its marked peer ID: the user ID for
 * a private chat, -N for basic group N and -100…N for channel or community N.
 */
export function dialogToCacheInput(dialog: Dialog): CachedChatInput {
  const rawPeer = dialog.raw.peer
  const peer = dialog.peer
  const type = getChatType(dialog)
  const lastMessageAt = dialog.lastMessage?.date ?? null

  let title: string | null = null
  let username: string | null = null
  let memberCount: number | null = null
  let accessHash: string | null = null

  if (rawPeer._ === 'peerUser' && peer.type === 'user') {
    title = peer.displayName || null
    username = peer.username ?? null
    const rawUser = peer.raw
    if (rawUser && (rawUser._ === 'user' || rawUser._ === 'userEmpty')) {
      accessHash = rawUser.accessHash ? String(rawUser.accessHash) : null
    }
  } else if (rawPeer._ === 'peerChat' && peer.type === 'chat') {
    title = peer.title ?? null
    memberCount = peer.membersCount ?? null
  } else if (rawPeer._ === 'peerChannel' && peer.type === 'chat') {
    title = peer.title ?? null
    username = peer.username ?? null
    memberCount = peer.membersCount ?? null
    const rawChat = peer.raw
    if (hasChannelId(rawChat)) {
      accessHash = rawChat.accessHash ? String(rawChat.accessHash) : null
    }
  }

  return {
    chat_id: String(toPeerIdFromRawPeer(rawPeer)),
    type,
    title,
    username,
    member_count: memberCount,
    access_hash: accessHash,
    is_creator: peer.type === 'chat' && peer.isCreator ? 1 : 0,
    is_admin: peer.type === 'chat' && peer.isAdmin ? 1 : 0,
    last_message_id: dialog.raw.topMessage ?? null,
    last_message_at: lastMessageAt ? lastMessageAt.getTime() : null,
    fetched_at: Date.now(),
    raw_json: toRawJson(dialog.raw),
  }
}

export function userToPrivateChatCacheInput(user: tl.RawUser): CachedChatInput {
  return {
    chat_id: String(user.id),
    type: 'private',
    title: [user.firstName, user.lastName].filter(Boolean).join(' '),
    username: user.username ?? null,
    member_count: null,
    access_hash: user.accessHash ? String(user.accessHash) : null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: toRawJson(user),
  }
}

/** A chat that a resolved username or an update can carry */
export type ResolvedChat = Exclude<tl.TypeChat, tl.RawChatEmpty>

/**
 * A chat with a channel ID (-100…), reached with its access hash: a channel
 * or a community
 */
function hasChannelId(
  chat: tl.TypeChat,
): chat is
  | tl.RawChannel
  | tl.RawChannelForbidden
  | tl.RawCommunity
  | tl.RawCommunityForbidden {
  return (
    chat._ === 'channel' ||
    chat._ === 'channelForbidden' ||
    chat._ === 'community' ||
    chat._ === 'communityForbidden'
  )
}

function rawChatType(peer: ResolvedChat): ChatType {
  if (peer._ === 'community' || peer._ === 'communityForbidden') {
    return 'community'
  }
  if (peer._ === 'channel' || peer._ === 'channelForbidden') {
    const isMega = 'megagroup' in peer && Boolean(peer.megagroup)
    const isGiga = 'gigagroup' in peer && Boolean(peer.gigagroup)
    return isMega || isGiga ? 'supergroup' : 'channel'
  }
  return 'group'
}

/** A chats_cache row for a raw chat, under its marked peer ID */
export function rawChatToCacheInput(chat: ResolvedChat): CachedChatInput {
  return {
    chat_id: String(toPeerIdFromRawChat(chat)),
    type: rawChatType(chat),
    title: 'title' in chat ? (chat.title ?? null) : null,
    username: 'username' in chat ? (chat.username ?? null) : null,
    member_count:
      'participantsCount' in chat ? (chat.participantsCount ?? null) : null,
    access_hash:
      hasChannelId(chat) && chat.accessHash ? String(chat.accessHash) : null,
    is_creator: 'creator' in chat && chat.creator ? 1 : 0,
    is_admin: 'adminRights' in chat && chat.adminRights ? 1 : 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: toRawJson(chat),
  }
}

/**
 * chats_cache rows for the communities the account joined, with their access
 * hash. Telegram lists a community as `dialogCommunity`, apart from the other
 * dialogs, and mtcute's dialog list drops it (#58). One request; errors are
 * left to the caller.
 */
export async function fetchJoinedCommunities(
  client: Pick<TelegramClient, 'getJoinedCommunities'>,
): Promise<CachedChatInput[]> {
  const chats = await client.getJoinedCommunities()
  return (
    chats
      // A min community's access hash works only in the update that carried it
      .filter((chat) => !(chat.raw._ === 'community' && chat.raw.min))
      .map((chat) => rawChatToCacheInput(chat.raw))
  )
}

/**
 * A chats_cache row for the chat of a live message, so sync jobs can build
 * an InputPeer before a dialog pass lists it. Null for a peer that can't
 * give one: an empty peer, or a "min" user, channel or community, whose
 * access hash works only in the update that carried it.
 */
export function rawPeerToCacheInput(
  peer: tl.TypeUser | tl.TypeChat,
): CachedChatInput | null {
  switch (peer._) {
    case 'user':
      return peer.min ? null : userToPrivateChatCacheInput(peer)
    case 'chat':
      return rawChatToCacheInput(peer)
    case 'channel':
    case 'community':
      return peer.min ? null : rawChatToCacheInput(peer)
    default:
      return null
  }
}
