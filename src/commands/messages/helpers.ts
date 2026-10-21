import type { TelegramClient } from '@mtcute/bun'

import { ConfigError } from '../../config'
import { accountsDb, getAccountCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import type { MessageSearchRow } from '../../db/messages-search'
import { createUsersCache } from '../../db/users-cache'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes, type MessageSearchItem } from '../../types'
import { error } from '../../utils/output'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../../utils/telegram-rate-limits'
import {
  AmbiguousPeerError,
  createDmLookup,
  InvalidPeerError,
} from '../send/peer-resolver'

/** The JSON item for a message row, shared by every `tg messages` command */
export function messageRowToItem(row: MessageSearchRow): MessageSearchItem {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    fromId: row.from_id,
    text: row.text,
    messageType: row.message_type,
    hasMedia: row.has_media === 1,
    mediaPath: row.media_path,
    isOutgoing: row.is_outgoing === 1,
    isEdited: row.is_edited === 1,
    isPinned: row.is_pinned === 1,
    isDeleted: row.is_deleted === 1,
    replyToId: row.reply_to_id,
    forwardFromId: row.forward_from_id,
    editDate: row.edit_date,
    date: row.date,
    chat: {
      id: row.chat_id,
      title: row.chat_title,
      username: row.chat_username,
      type: row.chat_type,
    },
    sender: {
      id: row.from_id,
      username: row.sender_username,
      firstName: row.sender_first_name,
      lastName: row.sender_last_name,
    },
  }
}

/**
 * Message IDs are TL int32, and mtcute wraps a larger value silently.
 * `--after` and `--id` go to getHistory as ID + 1, so they stop one lower.
 */
export const MAX_MESSAGE_ID = 2_147_483_647

interface IntegerRange {
  min: number
  max?: number
}

/**
 * A non-negative integer flag, or the default when it is not given.
 * Anything but plain digits in range is INVALID_ARGS: `Number.parseInt`
 * would read `5abc` as 5.
 */
export function parseIntegerArg(
  value: string | undefined,
  name: string,
  range: IntegerRange & { default: number },
): number
export function parseIntegerArg(
  value: string,
  name: string,
  range: IntegerRange,
): number
export function parseIntegerArg(
  value: string | undefined,
  name: string,
  range: IntegerRange,
): number | undefined
export function parseIntegerArg(
  value: string | undefined,
  name: string,
  { min, max, default: fallback }: IntegerRange & { default?: number },
): number | undefined {
  if (value === undefined) return fallback

  const bounds = max === undefined ? `>= ${min}` : `from ${min} to ${max}`
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max)
  ) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid --${name}: ${value}. Expected an integer ${bounds}.`,
      { [name]: value },
    )
  }
  return parsed
}

/** The chat has no message with this ID, in the cache or on Telegram */
export class MessageNotFoundError extends Error {
  readonly details: { chatId: number; messageId: number }

  constructor(chatId: number, messageId: number) {
    super(`Message ${messageId} not found in chat ${chatId}`)
    this.name = 'MessageNotFoundError'
    this.details = { chatId, messageId }
  }
}

/** Report a failed history read with the error codes other commands use */
export function reportHistoryError(err: unknown, action: string): never {
  if (err instanceof MessageNotFoundError) {
    error(ErrorCodes.TELEGRAM_ERROR, err.message, err.details)
  }
  if (err instanceof AmbiguousPeerError) {
    error(ErrorCodes.INVALID_ARGS, err.message, {
      chat: err.identifier,
      candidates: err.candidates,
    })
  }
  if (err instanceof InvalidPeerError) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid --chat: ${err.identifier}. Expected @username, a user or chat ID, a phone number (+…) or me.`,
      { chat: err.identifier },
    )
  }
  if (err instanceof ConfigError) {
    error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
  }
  if (isRateLimitError(err)) {
    error(
      ErrorCodes.RATE_LIMITED,
      `Rate limited for ${err.method}. Wait ${err.waitSeconds}s before retrying.`,
      { method: err.method, wait_seconds: err.waitSeconds },
    )
  }
  const message = err instanceof Error ? err.message : 'Unknown error'
  error(ErrorCodes.TELEGRAM_ERROR, `Failed to ${action}: ${message}`)
}

export type HistoryClient = Pick<TelegramClient, 'call' | 'getMe'>

/**
 * A client that is created on first use, so a read the cache answers needs
 * no credentials and opens no connection.
 */
export function createLazyClient(create: () => HistoryClient): HistoryClient {
  let client: HistoryClient | undefined
  const get = () => {
    client ??= create()
    return client
  }
  return {
    call: ((...args: Parameters<HistoryClient['call']>) =>
      get().call(...args)) as HistoryClient['call'],
    getMe: () => get().getMe(),
  }
}

/**
 * The account's cache and the lazy client that `tg messages list` and `get`
 * read with
 */
export function openHistory(accountId: number, context: string) {
  const cacheDb = getAccountCacheDb(accountId)
  return {
    cacheDb,
    client: createLazyClient(() =>
      wrapClientCallWithRateLimits(getClientForAccount(accountId), {
        context,
        accountId,
      }),
    ),
    usersCache: createUsersCache(cacheDb),
    chatsCache: createChatsCache(cacheDb),
    dms: createDmLookup(cacheDb),
    accounts: accountsDb,
    accountId,
  }
}

export const CHAT_ARG_DESCRIPTION =
  'Chat: @username, user or chat ID (as tg chats list or tg messages search print it), phone number (+…), or me'
