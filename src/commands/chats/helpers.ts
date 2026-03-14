import type { Dialog } from '@mtcute/bun'
import type { tl } from '@mtcute/tl'

import type { CachedChat, CachedChatInput } from '../../db/chats-cache'
import type { ChatType } from '../../db/types'

export interface ChatItem {
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
  if (peer.chatType === 'supergroup' || peer.chatType === 'gigagroup') {
    return 'supergroup'
  }
  if (peer.chatType === 'channel' || peer.chatType === 'monoforum') {
    return 'channel'
  }
  return 'group'
}

export function dialogToCacheInput(dialog: Dialog): CachedChatInput {
  const rawPeer = dialog.raw.peer
  const peer = dialog.peer
  const type = getChatType(dialog)
  const lastMessageAt = dialog.lastMessage?.date ?? null

  let chatId: string
  let title: string | null = null
  let username: string | null = null
  let memberCount: number | null = null
  let accessHash: string | null = null

  if (rawPeer._ === 'peerUser' && peer.type === 'user') {
    chatId = String(rawPeer.userId)
    title = peer.displayName || null
    username = peer.username ?? null
  } else if (rawPeer._ === 'peerChat' && peer.type === 'chat') {
    chatId = String(rawPeer.chatId)
    title = peer.title ?? null
    memberCount = peer.membersCount ?? null
  } else if (rawPeer._ === 'peerChannel' && peer.type === 'chat') {
    chatId = String(rawPeer.channelId)
    title = peer.title ?? null
    username = peer.username ?? null
    memberCount = peer.membersCount ?? null
    const rawChat = peer.raw
    if (rawChat._ === 'channel' || rawChat._ === 'channelForbidden') {
      accessHash = rawChat.accessHash ? String(rawChat.accessHash) : null
    }
  } else {
    chatId = String(
      rawPeer._ === 'peerUser'
        ? rawPeer.userId
        : rawPeer._ === 'peerChat'
          ? rawPeer.chatId
          : rawPeer.channelId,
    )
  }

  return {
    chat_id: chatId,
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
    raw_json: JSON.stringify(dialog.raw),
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
    raw_json: JSON.stringify(user),
  }
}
