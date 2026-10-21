/**
 * Peer IDs, the only place that converts them. Every cache table stores
 * marked peer IDs, the format mtcute uses: a user keeps its ID, basic group
 * N is -N and channel or supergroup N is -100…N (-1000000000000 - N).
 * Telegram's raw peers carry bare IDs, which are converted here on the way
 * in and back to bare IDs only for an InputPeer.
 */
import type { tl } from '@mtcute/bun'

import { toLong } from './long'

export const CHANNEL_PEER_ID_OFFSET = 1_000_000_000_000

/** The lowest marked basic group ID; anything lower is a channel */
const MIN_MARKED_CHAT_ID = -999_999_999_999

type RawPeerLike = {
  _?: string
  userId?: number
  chatId?: number
  channelId?: number
}

type RawChatLike = {
  _?: string
  id?: unknown
}

type PeerKind = 'user' | 'chat' | 'channel'

function markChat(chatId: number): number {
  return -chatId
}

function markChannel(channelId: number): number {
  return -CHANNEL_PEER_ID_OFFSET - channelId
}

/** What a marked ID names, or null for 0, -1000000000000 and non-integers */
function peerKind(peerId: number): PeerKind | null {
  if (!Number.isSafeInteger(peerId)) return null
  if (peerId > 0) return 'user'
  if (peerId < 0 && peerId >= MIN_MARKED_CHAT_ID) return 'chat'
  if (peerId < -CHANNEL_PEER_ID_OFFSET) return 'channel'
  return null
}

export function toPeerIdFromRawPeer(
  peer: RawPeerLike | null | undefined,
): number | null {
  if (!peer) return null
  switch (peer._) {
    case 'peerUser':
      return typeof peer.userId === 'number' ? peer.userId : null
    case 'peerChat':
      return typeof peer.chatId === 'number' ? markChat(peer.chatId) : null
    case 'peerChannel':
      return typeof peer.channelId === 'number'
        ? markChannel(peer.channelId)
        : null
    default:
      return null
  }
}

/**
 * Marked ID of a raw message's sender, by mtcute's Message.sender rule that
 * live updates use: fromId, or the chat (peerId) when Telegram leaves fromId
 * out, so an incoming private message is from the user, a channel post from
 * the channel and Saved Messages from the own user. Null when it names neither.
 */
export function toSenderIdFromRawMessage(
  message:
    | { fromId?: RawPeerLike | null; peerId?: RawPeerLike | null }
    | null
    | undefined,
): number | null {
  if (!message) return null
  return toPeerIdFromRawPeer(message.fromId ?? message.peerId)
}

/**
 * Marked peer ID for a raw user or chat object, as `users`/`chats` lists
 * and updates carry them. A community has a channel ID, like a channel.
 */
export function toPeerIdFromRawChat(
  chat: RawChatLike | null | undefined,
): number | null {
  if (!chat || typeof chat.id !== 'number') return null
  switch (chat._) {
    case 'user':
      return chat.id
    case 'chat':
    case 'chatForbidden':
      return markChat(chat.id)
    case 'channel':
    case 'channelForbidden':
    case 'community':
    case 'communityForbidden':
      return markChannel(chat.id)
    default:
      return null
  }
}

/**
 * Marked peer ID for an input peer, in the same format as
 * `toPeerIdFromRawPeer`. `inputPeerSelf` carries no ID, so the caller passes
 * its own user ID.
 */
export function toPeerIdFromInputPeer(
  peer: tl.TypeInputPeer,
  selfId: number | null,
): number | null {
  switch (peer._) {
    case 'inputPeerSelf':
      return selfId
    case 'inputPeerUser':
    case 'inputPeerUserFromMessage':
      return toPeerIdFromRawPeer({ _: 'peerUser', userId: peer.userId })
    case 'inputPeerChat':
      return toPeerIdFromRawPeer({ _: 'peerChat', chatId: peer.chatId })
    case 'inputPeerChannel':
    case 'inputPeerChannelFromMessage':
      return toPeerIdFromRawPeer({
        _: 'peerChannel',
        channelId: peer.channelId,
      })
    default:
      return null
  }
}

/**
 * Marked peer ID for a bare ID and the chat type it was stored with. Only
 * for data that has no raw peer: a community is stored as 'group' but has a
 * channel ID, which only the raw peer or chat tells.
 */
export function toMarkedPeerId(
  rawId: number,
  type: 'private' | 'group' | 'supergroup' | 'channel',
): number {
  switch (type) {
    case 'private':
      return rawId
    case 'group':
      return markChat(rawId)
    case 'supergroup':
    case 'channel':
      return markChannel(rawId)
  }
}

/**
 * The bare ID inside a marked peer ID, the inverse of `toMarkedPeerId`:
 * user ID, basic group ID or channel ID. Null for 0 and -1000000000000.
 */
export function toRawPeerId(peerId: number): number | null {
  switch (peerKind(peerId)) {
    case 'user':
      return peerId
    case 'chat':
      return -peerId
    case 'channel':
      return -CHANNEL_PEER_ID_OFFSET - peerId
    default:
      return null
  }
}

/**
 * The InputPeer for a marked peer ID. A basic group needs no access hash;
 * without one a user or channel gets 0, which Telegram may refuse. Null for
 * an ID that names no peer (0, -1000000000000).
 */
export function toInputPeerFromPeerId(
  peerId: number,
  accessHash: string | null,
): tl.TypeInputPeer | null {
  const rawId = toRawPeerId(peerId)
  if (rawId === null) return null
  switch (peerKind(peerId)) {
    case 'user':
      return {
        _: 'inputPeerUser',
        userId: rawId,
        accessHash: toLong(accessHash),
      }
    case 'chat':
      return { _: 'inputPeerChat', chatId: rawId }
    default:
      return {
        _: 'inputPeerChannel',
        channelId: rawId,
        accessHash: toLong(accessHash),
      }
  }
}

/**
 * The marked IDs a bare positive chat ID from 0.2.0 or older can mean:
 * `tg chats list` printed basic group N and channel N as N. Basic group
 * first; a number too large for a basic group gives only the channel.
 */
export function legacyChatIdCandidates(bareId: number): number[] {
  if (!Number.isSafeInteger(bareId) || bareId <= 0) return []
  const candidates: number[] = []
  if (markChat(bareId) >= MIN_MARKED_CHAT_ID) candidates.push(markChat(bareId))
  candidates.push(markChannel(bareId))
  return candidates
}
