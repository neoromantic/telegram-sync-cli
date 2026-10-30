import type { TelegramClient, tl } from '@mtcute/bun'
import type { ChatsCache } from '../db/chats-cache'
import type { MessageInput } from '../db/messages-cache'
import type { UsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'
import { resolveRawMessageType } from '../utils/message-type'
import { toRawJson } from '../utils/raw-json'
import { apiUserToCacheInput } from '../utils/telegram-mappers'
import {
  toInputPeerFromPeerId,
  toPeerIdFromRawPeer,
  toSenderIdFromRawMessage,
} from '../utils/telegram-peer-ids'

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

  const { messageType, hasMedia } = resolveRawMessageType(m)
  // A channel or group that posts as itself gets its marked ID, like chats.
  // Without fromId the chat is the sender, as live updates store it
  const fromId = toSenderIdFromRawMessage(
    m as { fromId?: RawPeerField; peerId?: RawPeerField },
  )
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
    raw_json: toRawJson(m),
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

/**
 * One `messages.getHistory` page. A `signal` (the daemon's stop) ends the
 * request at once, a FLOOD_WAIT it waits out included.
 */
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
  signal?: AbortSignal,
): Promise<{ messages: unknown[]; count?: number; users: tl.TypeUser[] }> {
  // mtcute's flood waiter never wakes on a signal that is already aborted,
  // so a stored FLOOD_WAIT would sleep in full
  signal?.throwIfAborted()
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
  const result = signal
    ? await client.call(request, { abortSignal: signal })
    : await client.call(request)
  const messages = 'messages' in result ? result.messages : []
  const count = 'count' in result ? result.count : undefined
  // The senders of the page, for callers that cache them
  const users = 'users' in result ? result.users : []

  return { messages, count, users }
}

/**
 * Cache the senders of a history page. Only full users: a "min" user lacks
 * fields, and its access hash works only in the update that carried it.
 * Callers write them before the messages, because the search index reads a
 * sender's name when a message row is written.
 */
export function cachePageUsers(
  usersCache: UsersCache,
  users: tl.TypeUser[],
): void {
  const full = users.filter(
    (user): user is tl.RawUser => user._ === 'user' && !user.min,
  )
  if (full.length > 0) usersCache.upsertMany(full.map(apiUserToCacheInput))
}

/**
 * How many messages the chat has on the server, from a history page. A
 * slice carries Telegram's `count`; a page that is the whole history
 * (messages.messages) has none, and its length is the count. Null for a
 * page bounded by `minId` or `maxId`, whose count may cover only the
 * bounds, and for a whole-history answer to a request with an offset.
 */
export function historyTotal(
  page: { messages: unknown[]; count?: number },
  request: { offsetId?: number; minId?: number; maxId?: number },
): number | null {
  if (request.minId || request.maxId) return null
  if (page.count !== undefined) return page.count
  return request.offsetId ? null : page.messages.length
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
