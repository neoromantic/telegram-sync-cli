/**
 * Pinning and unpinning a message for `tg messages pin` and `unpin`:
 * messages.updatePinnedMessage, then the cached message's pinned flag and
 * any service message Telegram returns ("pinned a message") go into
 * messages_cache right away, as a message `tg send` sent does
 * (send/sent-message-cache.ts).
 */
import type { Database } from 'bun:sqlite'
import { type TelegramClient, tl } from '@mtcute/bun'

import { getErrorMessage } from '../../daemon/daemon-utils'
import { createMessagesCache } from '../../db/messages-cache'
import { createMessagesHistory } from '../../db/messages-history'
import type { MessageSearchItem } from '../../types'
import { verbose } from '../../utils/output'
import { newMessageInputs } from '../send/sent-message-cache'
import { messageRowsToItems } from './helpers'
import { type HistoryChat, withPeerHint } from './history'

type CallClient = Pick<TelegramClient, 'call'>

export interface PinChange {
  /** true to pin, false to unpin */
  pin: boolean
  /** Pin without notifying the chat's members; ignored for an unpin */
  silent?: boolean
}

const noPermission = (pin: boolean) =>
  `You do not have permission to ${pin ? 'pin' : 'unpin'} messages in this chat`

/** Telegram's refusals of a pin or unpin that say what to change, by RPC error name */
const REFUSALS: Record<string, (messageId: number, pin: boolean) => string> = {
  MESSAGE_ID_INVALID: (id, pin) =>
    `Telegram has no message ${id} in this chat that can be ${pin ? 'pinned' : 'unpinned'}`,
  PIN_RESTRICTED: (_id, pin) => noPermission(pin),
  CHAT_ADMIN_REQUIRED: (_id, pin) => noPermission(pin),
  CHAT_WRITE_FORBIDDEN: (_id, pin) => noPermission(pin),
  USER_BANNED_IN_CHANNEL: (_id, pin) => noPermission(pin),
}

/** Telegram refused the pin or unpin for a reason the caller can act on */
export class PinRefusedError extends Error {
  readonly details: { chatId: number; messageId: number; telegramError: string }

  constructor(
    message: string,
    chatId: number,
    messageId: number,
    telegramError: string,
  ) {
    super(message)
    this.name = 'PinRefusedError'
    this.details = { chatId, messageId, telegramError }
  }
}

export function updatePinnedMessageRequest(
  inputPeer: tl.TypeInputPeer,
  messageId: number,
  { pin, silent }: PinChange,
): tl.messages.RawUpdatePinnedMessageRequest {
  const request: tl.messages.RawUpdatePinnedMessageRequest = {
    _: 'messages.updatePinnedMessage',
    peer: inputPeer,
    id: messageId,
  }
  if (!pin) return { ...request, unpin: true }
  return silent ? { ...request, silent: true } : request
}

/**
 * Set the cached message's pinned flag, store any new message of the
 * response, and read the message back as a message item. Null when the
 * cache does not hold the message or the cache write failed: the pin is done
 * either way, so a failure is only logged.
 */
function cachePinChange(
  cacheDb: Database,
  chatId: number,
  messageId: number,
  pinned: boolean,
  result: tl.TypeUpdates,
): MessageSearchItem | null {
  try {
    const messagesCache = createMessagesCache(cacheDb)
    const serviceMessages =
      'updates' in result ? newMessageInputs(result.updates) : []
    cacheDb.transaction(() => {
      messagesCache.setPinned(chatId, [messageId], pinned)
      messagesCache.upsertBatch(serviceMessages)
    })()
    const row = createMessagesHistory(cacheDb).get(chatId, messageId)
    return messageRowsToItems(cacheDb, row ? [row] : [])[0] ?? null
  } catch (err) {
    verbose(`Could not cache the pin: ${getErrorMessage(err)}`)
    return null
  }
}

export interface PinMessageResult {
  chatId: number
  messageId: number
  /** Whether the message is pinned now */
  pinned: boolean
  /**
   * The message after the change, as `tg messages get` prints it; null when
   * the cache does not hold it
   */
  message: MessageSearchItem | null
}

/** Pin or unpin a message and record the change in the cache */
export async function pinMessage(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  messageId: number,
  change: PinChange,
): Promise<PinMessageResult> {
  let result: tl.TypeUpdates
  try {
    result = await client.call(
      updatePinnedMessageRequest(chat.inputPeer, messageId, change),
    )
  } catch (err) {
    if (tl.RpcError.is(err)) {
      const refusal = REFUSALS[err.text]
      if (refusal) {
        throw new PinRefusedError(
          refusal(messageId, change.pin),
          chat.chatId,
          messageId,
          err.text,
        )
      }
    }
    throw withPeerHint(err)
  }
  return {
    chatId: chat.chatId,
    messageId,
    pinned: change.pin,
    message: cachePinChange(
      cacheDb,
      chat.chatId,
      messageId,
      change.pin,
      result,
    ),
  }
}
