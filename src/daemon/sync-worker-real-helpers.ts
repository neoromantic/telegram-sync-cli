import type { TelegramClient, tl } from '@mtcute/bun'
import type { ChatsCache } from '../db/chats-cache'
import type { MessageInput } from '../db/messages-cache'
import { toLong } from '../utils/long'
import {
  toInputPeerFromPeerId,
  toPeerIdFromRawPeer,
} from '../utils/telegram-peer-ids'
import { bigIntReplacer } from './daemon-utils'

const MEDIA_TYPE_MAP: Record<string, string> = {
  messageMediaPhoto: 'photo',
  messageMediaDocument: 'document',
  messageMediaVideo: 'video',
  messageMediaAudio: 'audio',
  messageMediaGeo: 'location',
  messageMediaGeoLive: 'location',
  messageMediaContact: 'contact',
  messageMediaPoll: 'poll',
  messageMediaWebPage: 'webpage',
  messageMediaVenue: 'venue',
  messageMediaGame: 'game',
  messageMediaInvoice: 'invoice',
  messageMediaSticker: 'sticker',
}

/**
 * The InputPeer for a marked chat ID, with the access hash chats_cache holds
 * for it. Without a row a basic group needs no hash and a user gets hash 0,
 * which Telegram may refuse; a channel can't be reached without one.
 */
export function buildInputPeer(
  chatId: number,
  chatsCache: ChatsCache,
): tl.TypeInputPeer | null {
  const chat = chatsCache.getById(String(chatId))
  if (chat) return toInputPeerFromPeerId(chatId, chat.access_hash)

  const peer = toInputPeerFromPeerId(chatId, null)
  return peer?._ === 'inputPeerChannel' ? null : peer
}

function resolveMessageType(message: Record<string, unknown>): {
  messageType: string
  hasMedia: boolean
} {
  if (message.media) {
    const mediaObj = message.media as Record<string, unknown>
    const mediaType = String(mediaObj._ ?? '')
    return {
      messageType: MEDIA_TYPE_MAP[mediaType] ?? 'media',
      hasMedia: true,
    }
  }

  if (message._ === 'messageService') {
    return { messageType: 'service', hasMedia: false }
  }

  return { messageType: 'text', hasMedia: false }
}

function extractReplyToId(message: Record<string, unknown>): number | null {
  const replyToObj = message.replyTo as Record<string, unknown> | undefined
  if (replyToObj?.replyToMsgId) {
    return replyToObj.replyToMsgId as number
  }
  return null
}

type RawPeerField = Parameters<typeof toPeerIdFromRawPeer>[0]

/** Marked ID of the original sender of a forwarded message */
function extractForwardFromId(message: Record<string, unknown>): number | null {
  const fwdFrom = message.fwdFrom as { fromId?: RawPeerField } | undefined
  return toPeerIdFromRawPeer(fwdFrom?.fromId)
}

export function parseRawMessage(
  msg: unknown,
  chatId: number,
): MessageInput | null {
  const m = msg as Record<string, unknown>

  if (!m || m._ === 'messageEmpty') {
    return null
  }

  const { messageType, hasMedia } = resolveMessageType(m)
  // A channel or group that posts as itself gets its marked ID, like chats
  const fromId = toPeerIdFromRawPeer(m.fromId as RawPeerField)
  const replyToId = extractReplyToId(m)
  const forwardFromId = extractForwardFromId(m)

  return {
    chat_id: chatId,
    message_id: m.id as number,
    from_id: fromId,
    reply_to_id: replyToId,
    forward_from_id: forwardFromId,
    text: (m.message as string) || null,
    message_type: messageType,
    has_media: hasMedia,
    is_outgoing: Boolean(m.out),
    is_edited: Boolean(m.editDate),
    is_pinned: Boolean(m.pinned),
    edit_date: (m.editDate as number) || null,
    date: m.date as number,
    raw_json: JSON.stringify(m, bigIntReplacer),
  }
}

export function extractFloodWaitSeconds(error: Error): number | null {
  const match = error.message.match(/FLOOD_WAIT_(\d+)/)
  if (match?.[1]) {
    return parseInt(match[1], 10)
  }

  const anyError = error as unknown as Record<string, unknown>
  if (typeof anyError.seconds === 'number') {
    return anyError.seconds
  }

  return null
}

/** The `id` of a raw message from Telegram, or 0 if it has none */
export function rawMessageId(message: unknown): number {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === 'number' ? id : 0
}

/**
 * The page a forward catch-up fetches. With a cursor it is the oldest
 * `limit` messages above the cursor: a negative `addOffset` makes
 * `offsetId` inclusive, so the page starts one above the cursor, and `minId`
 * keeps older messages out. Without a cursor it is the newest page.
 */
export function forwardPageRequest(cursor: number | null, limit: number) {
  if (cursor === null) {
    return { limit }
  }
  return { offsetId: cursor + 1, addOffset: -limit, limit, minId: cursor }
}

export async function fetchMessagesRaw(
  client: Pick<TelegramClient, 'call'>,
  inputPeer: tl.TypeInputPeer,
  options: {
    offsetId?: number
    addOffset?: number
    limit?: number
    minId?: number
    maxId?: number
  },
): Promise<{ messages: unknown[]; count?: number; users: tl.TypeUser[] }> {
  const request: tl.messages.RawGetHistoryRequest = {
    _: 'messages.getHistory',
    peer: inputPeer,
    offsetId: options.offsetId ?? 0,
    offsetDate: 0,
    addOffset: options.addOffset ?? 0,
    limit: options.limit ?? 100,
    maxId: options.maxId ?? 0,
    minId: options.minId ?? 0,
    hash: toLong(0),
  }
  const result = await client.call(request)
  const messages = 'messages' in result ? result.messages : []
  const count = 'count' in result ? result.count : undefined
  // The senders of the page, for callers that cache them
  const users = 'users' in result ? result.users : []

  return { messages, count, users }
}

export function createMessageInputs(
  messages: unknown[],
  chatId: number,
  fallbackMinId: number,
  fallbackMaxId: number,
): { inputs: MessageInput[]; minId: number; maxId: number } {
  const inputs: MessageInput[] = []
  let minId = fallbackMinId
  let maxId = fallbackMaxId

  for (const msg of messages) {
    const parsed = parseRawMessage(msg, chatId)
    if (parsed) {
      inputs.push(parsed)
      if (parsed.message_id < minId) {
        minId = parsed.message_id
      }
      if (parsed.message_id > maxId) {
        maxId = parsed.message_id
      }
    }
  }

  return { inputs, minId, maxId }
}
