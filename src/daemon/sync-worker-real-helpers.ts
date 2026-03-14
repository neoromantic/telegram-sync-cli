import type { TelegramClient } from '@mtcute/bun'
import type { tl } from '@mtcute/tl'
import type { ChatsCache } from '../db/chats-cache'
import type { MessageInput } from '../db/messages-cache'
import { toLong } from '../utils/long'
import { getCandidateChatIds } from '../utils/telegram-peer-ids'

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

export function buildInputPeer(
  chatId: number,
  chatsCache: ChatsCache,
): tl.TypeInputPeer | null {
  const candidates = getCandidateChatIds(chatId)

  for (const candidateId of candidates) {
    const chat = chatsCache.getById(String(candidateId))
    if (!chat) continue

    switch (chat.type) {
      case 'private':
        return {
          _: 'inputPeerUser',
          userId: Number(chat.chat_id),
          accessHash: toLong(chat.access_hash),
        }
      case 'group':
        return {
          _: 'inputPeerChat',
          chatId: Number(chat.chat_id),
        }
      case 'supergroup':
      case 'channel':
        return {
          _: 'inputPeerChannel',
          channelId: Number(chat.chat_id),
          accessHash: toLong(chat.access_hash),
        }
      default:
        return null
    }
  }

  if (chatId < 0) {
    return null
  }

  return {
    _: 'inputPeerUser',
    userId: chatId,
    accessHash: toLong(0),
  }
}

function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
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

function extractPeerId(
  peer: Record<string, unknown> | null | undefined,
): number | null {
  if (!peer) return null
  switch (peer._) {
    case 'peerUser':
      return peer.userId as number
    case 'peerChannel':
      return peer.channelId as number
    case 'peerChat':
      return peer.chatId as number
    default:
      return null
  }
}

function extractReplyToId(message: Record<string, unknown>): number | null {
  const replyToObj = message.replyTo as Record<string, unknown> | undefined
  if (replyToObj?.replyToMsgId) {
    return replyToObj.replyToMsgId as number
  }
  return null
}

function extractForwardFromId(message: Record<string, unknown>): number | null {
  const fwdFromObj = message.fwdFrom as Record<string, unknown> | undefined
  const fwdFromIdObj = fwdFromObj?.fromId as Record<string, unknown> | undefined
  return extractPeerId(fwdFromIdObj)
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
  const fromId = extractPeerId(m.fromId as Record<string, unknown> | undefined)
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

export async function fetchMessagesRaw(
  client: TelegramClient,
  inputPeer: tl.TypeInputPeer,
  options: {
    offsetId?: number
    addOffset?: number
    limit?: number
    minId?: number
    maxId?: number
  },
): Promise<{ messages: unknown[]; count?: number }> {
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

  return { messages, count }
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
