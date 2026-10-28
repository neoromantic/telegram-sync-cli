/**
 * Message parsing utilities for converting raw Telegram messages
 * to the internal format used by the sync system
 */

import type { NewMessageData } from '../daemon/handlers'
import { resolveRawMessageType } from './message-type'
import {
  toPeerIdFromRawPeer,
  toSenderIdFromRawMessage,
} from './telegram-peer-ids'

/**
 * Raw Telegram peer types
 */
export interface RawPeerUser {
  _: 'peerUser'
  userId: number
}

export interface RawPeerChat {
  _: 'peerChat'
  chatId: number
}

export interface RawPeerChannel {
  _: 'peerChannel'
  channelId: number
}

export type RawPeer = RawPeerUser | RawPeerChat | RawPeerChannel

/**
 * Raw message forward header from Telegram API
 */
export interface RawMessageFwdHeader {
  _: 'messageFwdHeader'
  /** Original sender peer (can be user, chat, or channel) */
  fromId?: RawPeer
  /** Original sender name (when fromId is hidden) */
  fromName?: string
  /** Original channel post ID */
  channelPost?: number
  /** Post author signature */
  postAuthor?: string
  /** Original message date */
  date: number
  /** Saved peer ID for saved messages */
  savedFromPeer?: RawPeer
  /** Saved message ID */
  savedFromMsgId?: number
}

/**
 * Raw Telegram message structure (subset of fields we need)
 */
export interface RawMessage {
  _: 'message' | 'messageService' | 'messageEmpty'
  /** Message ID */
  id: number
  /** Peer where the message was sent */
  peerId: RawPeer
  /** Sender peer (for groups/channels) */
  fromId?: RawPeer
  /** Forward header (present for forwarded messages) */
  fwdFrom?: RawMessageFwdHeader
  /** Message text */
  message?: string
  /** Message date (Unix timestamp) */
  date: number
  /** Whether message is outgoing */
  out?: boolean
  /** Reply header */
  replyTo?: {
    _: 'messageReplyHeader'
    replyToMsgId?: number
  }
  /** Media content: a raw TL MessageMedia */
  media?: {
    _: string
    [field: string]: unknown
  }
  /** Whether message is pinned */
  pinned?: boolean
}

/**
 * Marked ID of a raw peer: the user ID, -N for basic group N and -100…N for
 * channel N, the format of every cache table
 */
export function extractPeerId(peer: RawPeer | undefined): number | undefined {
  return toPeerIdFromRawPeer(peer) ?? undefined
}

/**
 * Marked ID of the original sender in a message's forward header: a user,
 * a basic group or a channel
 */
export function extractForwardFromId(
  fwdFrom: RawMessageFwdHeader | undefined,
): number | undefined {
  return toPeerIdFromRawPeer(fwdFrom?.fromId) ?? undefined
}

/**
 * Determine message type from raw message, as live updates store it
 */
export function determineMessageType(message: RawMessage): string {
  if (message._ === 'messageEmpty') return 'empty'
  return resolveRawMessageType(message).messageType
}

/**
 * Parse a raw Telegram message into the internal NewMessageData format
 * Used by sync workers to process messages from the API
 */
export function parseRawMessage(
  raw: RawMessage,
  chatId: number,
): NewMessageData {
  const { messageType, hasMedia } =
    raw._ === 'messageEmpty'
      ? { messageType: 'empty', hasMedia: false }
      : resolveRawMessageType(raw)
  return {
    chatId,
    messageId: raw.id,
    fromId: toSenderIdFromRawMessage(raw) ?? undefined,
    text: raw.message,
    date: raw.date,
    isOutgoing: raw.out ?? false,
    replyToId: raw.replyTo?.replyToMsgId,
    forwardFromId: extractForwardFromId(raw.fwdFrom),
    messageType,
    hasMedia,
    isPinned: raw.pinned,
  }
}

/**
 * Parse a batch of raw messages
 */
export function parseRawMessages(
  messages: RawMessage[],
  chatId: number,
): NewMessageData[] {
  return messages
    .filter((msg) => msg._ !== 'messageEmpty')
    .map((msg) => parseRawMessage(msg, chatId))
}
