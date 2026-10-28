/**
 * Content protection for `tg media download`
 * (https://core.telegram.org/api/content-protection): media of a protected
 * chat, channel, private chat or message, and self-destructing media, is
 * never saved.
 */
import type { TelegramClient, tl } from '@mtcute/bun'

import type {
  ChatProtectionReason,
  ChatProtectionRow,
} from '../../db/chat-protection'
import { toPeerIdFromRawChat } from '../../utils/telegram-peer-ids'
import type { HistoryChat } from '../messages/history'
import type { FetchedRawMessage } from './fetch'

export type ProtectionReason =
  | 'message'
  | 'chat'
  | 'private_chat'
  | 'self_destructing'

export type ProtectionResult =
  | { protected: false }
  | { protected: true; reason: ProtectionReason }

/** The chat-level answer of an online check, recorded in chat_content_protection */
export interface ChatProtectionResult {
  protected: boolean
  reason: ChatProtectionReason | null
}

const NOT_PROTECTED: ProtectionResult = { protected: false }

type RawObject = Record<string, unknown>

function asObject(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null
    ? (value as RawObject)
    : null
}

function parseJson(text: string | null): RawObject | null {
  if (text === null) return null
  try {
    return asObject(JSON.parse(text))
  } catch {
    return null
  }
}

/** A message's own protection: its noforwards flag, or a media timer */
function messageProtection(message: RawObject | null): ProtectionResult {
  if (!message) return NOT_PROTECTED
  if (message.noforwards === true) {
    return { protected: true, reason: 'message' }
  }
  const ttl = asObject(message.media)?.ttlSeconds
  if (typeof ttl === 'number' && ttl > 0) {
    return { protected: true, reason: 'self_destructing' }
  }
  return NOT_PROTECTED
}

/** A raw chat or channel object's noforwards flag */
function chatObjectProtected(chat: RawObject | null): boolean {
  return (
    (chat?._ === 'chat' || chat?._ === 'channel') && chat.noforwards === true
  )
}

/** The chat's chats_cache row: its raw_json and when it was fetched, ms */
export interface CachedChatState {
  raw_json: string
  fetched_at: number
}

/**
 * The chat's protection as the cache knows it: a positive answer of the
 * last online check (it holds until an online check finds protection off),
 * else the chat's noforwards when its chats_cache raw_json is a raw chat or
 * channel (dialog rows don't carry it) fetched after that check
 */
export function knownChatProtection(
  chat: CachedChatState | null,
  stored: ChatProtectionRow | null,
): ProtectionResult {
  if (stored?.protected === 1) {
    return { protected: true, reason: stored.reason ?? 'chat' }
  }
  if (!chat || !chatObjectProtected(parseJson(chat.raw_json))) {
    return NOT_PROTECTED
  }
  // The online check that found protection off is newer
  if (stored !== null && chat.fetched_at <= stored.fetched_at) {
    return NOT_PROTECTED
  }
  return { protected: true, reason: 'chat' }
}

/**
 * Protection known without Telegram: the message's flags in its raw_json,
 * then the chat's (knownChatProtection)
 */
export function checkCachedProtection(
  messageRawJson: string,
  chat: CachedChatState | null,
  stored: ChatProtectionRow | null,
): ProtectionResult {
  const message = messageProtection(parseJson(messageRawJson))
  if (message.protected) return message
  return knownChatProtection(chat, stored)
}

export interface OnlineProtection {
  message: ProtectionResult
  /** Null when no chat-level check ran: Saved Messages, or no chat object */
  chat: ChatProtectionResult | null
}

/**
 * Protection of a freshly fetched message and its chat: the chat or
 * channel object Telegram sent with the message, or, for a private chat
 * other than Saved Messages, the user's full info
 */
export async function checkOnlineProtection(
  client: Pick<TelegramClient, 'call'>,
  chat: HistoryChat,
  message: FetchedRawMessage,
  chats: tl.TypeChat[],
  signal?: AbortSignal,
): Promise<OnlineProtection> {
  const result: OnlineProtection = {
    message: messageProtection(message as unknown as RawObject),
    chat: null,
  }

  const peer = chat.inputPeer
  if (peer._ === 'inputPeerUser') {
    const { fullUser } = await client.call(
      {
        _: 'users.getFullUser',
        id: {
          _: 'inputUser',
          userId: peer.userId,
          accessHash: peer.accessHash,
        },
      },
      { abortSignal: signal },
    )
    const isProtected = Boolean(
      fullUser.noforwardsMyEnabled || fullUser.noforwardsPeerEnabled,
    )
    result.chat = {
      protected: isProtected,
      reason: isProtected ? 'private_chat' : null,
    }
    return result
  }

  const chatObject = chats.find(
    (item) => toPeerIdFromRawChat(item) === chat.chatId,
  )
  if (chatObject && (chatObject._ === 'chat' || chatObject._ === 'channel')) {
    const isProtected = chatObject.noforwards === true
    result.chat = {
      protected: isProtected,
      reason: isProtected ? 'chat' : null,
    }
  }
  return result
}
