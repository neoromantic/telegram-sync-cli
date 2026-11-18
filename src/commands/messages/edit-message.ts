/**
 * Editing a sent message for `tg messages edit`: messages.editMessage
 * replaces its text, and the edited message Telegram returns goes into
 * messages_cache right away, as a message `tg send` sent does
 * (send/sent-message-cache.ts).
 */
import type { Database } from 'bun:sqlite'
import { type TelegramClient, tl } from '@mtcute/bun'

import { getErrorMessage } from '../../daemon/daemon-utils'
import { parseRawMessage } from '../../daemon/sync-worker-real-helpers'
import { createMessagesCache } from '../../db/messages-cache'
import { createMessagesHistory } from '../../db/messages-history'
import type { MessageSearchItem } from '../../types'
import { verbose } from '../../utils/output'
import { messageRowsToItems } from './helpers'
import { type HistoryChat, withPeerHint } from './history'

type CallClient = Pick<TelegramClient, 'call'>

/** Telegram's refusals of an edit that say what to change, by RPC error name */
const REFUSALS: Record<string, (messageId: number) => string> = {
  MESSAGE_NOT_MODIFIED: (id) => `Message ${id} already has this text`,
  MESSAGE_ID_INVALID: (id) =>
    `Telegram has no message ${id} in this chat that can be edited`,
  MESSAGE_AUTHOR_REQUIRED: (id) =>
    `You can't edit message ${id}: it was sent by someone else`,
  MESSAGE_EDIT_TIME_EXPIRED: (id) =>
    `Message ${id} is too old: Telegram no longer allows editing it`,
  MESSAGE_TOO_LONG: () => 'The text is too long for a message',
  MEDIA_CAPTION_TOO_LONG: () =>
    'The text is too long for the caption of a media message',
  CHAT_WRITE_FORBIDDEN: () =>
    'You do not have permission to edit messages in this chat',
  CHAT_ADMIN_REQUIRED: () =>
    'You do not have permission to edit messages in this chat',
}

/** Telegram refused the edit for a reason the caller can act on */
export class EditRefusedError extends Error {
  readonly details: { chatId: number; messageId: number; telegramError: string }

  constructor(
    message: string,
    chatId: number,
    messageId: number,
    telegramError: string,
  ) {
    super(message)
    this.name = 'EditRefusedError'
    this.details = { chatId, messageId, telegramError }
  }
}

/** Without entities the text is plain: Telegram drops the old formatting */
export function editMessageRequest(
  inputPeer: tl.TypeInputPeer,
  messageId: number,
  text: string,
): tl.messages.RawEditMessageRequest {
  return {
    _: 'messages.editMessage',
    peer: inputPeer,
    id: messageId,
    message: text,
  }
}

/** The edited message in Telegram's response, if it holds one */
function editedMessage(
  result: tl.TypeUpdates,
  messageId: number,
): tl.TypeMessage | null {
  if (!('updates' in result)) return null
  for (const update of result.updates) {
    if (
      (update._ === 'updateEditMessage' ||
        update._ === 'updateEditChannelMessage') &&
      update.message.id === messageId
    ) {
      return update.message
    }
  }
  return null
}

/**
 * Store the edited message and read it back as a message item. Null when
 * the response held no message or the cache write failed: the edit is done
 * either way, so a failure is only logged.
 */
function cacheEditedMessage(
  cacheDb: Database,
  chatId: number,
  messageId: number,
  result: tl.TypeUpdates,
): MessageSearchItem | null {
  try {
    const message = editedMessage(result, messageId)
    const input = message ? parseRawMessage(message, chatId) : null
    if (!input) {
      verbose(`Edited message not cached: no message in ${result._}`)
      return null
    }
    createMessagesCache(cacheDb).upsert(input)
    const row = createMessagesHistory(cacheDb).get(chatId, messageId)
    return messageRowsToItems(cacheDb, row ? [row] : [])[0] ?? null
  } catch (err) {
    verbose(`Could not cache the edited message: ${getErrorMessage(err)}`)
    return null
  }
}

export interface EditMessageResult {
  chatId: number
  messageId: number
  edited: true
  /**
   * The message after the edit, as `tg messages get` prints it; null when
   * it could not be stored in the cache
   */
  message: MessageSearchItem | null
}

/**
 * Replace the text of a message (the caption, for a message with a file)
 * and store the edited message in the cache
 */
export async function editMessage(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  messageId: number,
  text: string,
): Promise<EditMessageResult> {
  let result: tl.TypeUpdates
  try {
    result = await client.call(
      editMessageRequest(chat.inputPeer, messageId, text),
    )
  } catch (err) {
    if (tl.RpcError.is(err)) {
      const refusal = REFUSALS[err.text]
      if (refusal) {
        throw new EditRefusedError(
          refusal(messageId),
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
    edited: true,
    message: cacheEditedMessage(cacheDb, chat.chatId, messageId, result),
  }
}
