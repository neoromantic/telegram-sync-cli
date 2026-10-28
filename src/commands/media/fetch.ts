/**
 * One message fetched from Telegram by ID for `tg media download`: a fresh
 * file reference, the chat object for the protection check, and the cached
 * row brought up to date
 */
import type { Database } from 'bun:sqlite'
import type { TelegramClient, tl } from '@mtcute/bun'

import { parseRawMessage } from '../../daemon/sync-worker-real-helpers'
import { createMessagesCache } from '../../db/messages-cache'
import { createUsersCache } from '../../db/users-cache'
import { ErrorCodes } from '../../types'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import { toPeerIdFromRawPeer } from '../../utils/telegram-peer-ids'
import type { HistoryChat } from '../messages/history'
import { MediaError } from './errors'

export type FetchedRawMessage = tl.RawMessage | tl.RawMessageService

export interface FetchedMessage {
  message: FetchedRawMessage
  chats: tl.TypeChat[]
  users: tl.TypeUser[]
}

function messageNotFound(chatId: number, messageId: number): MediaError {
  return new MediaError(
    ErrorCodes.MESSAGE_NOT_FOUND,
    `Message ${messageId} not found in chat ${chatId}`,
    { chatId, messageId },
  )
}

/**
 * The message with this ID in the chat, from Telegram. A channel or
 * supergroup numbers its own messages (channels.getMessages); private
 * chats and basic groups share the account's numbering (messages.getMessages),
 * so the message must also belong to the chat. MESSAGE_NOT_FOUND otherwise.
 */
export async function fetchMessageById(
  client: Pick<TelegramClient, 'call'>,
  chat: HistoryChat,
  messageId: number,
  signal?: AbortSignal,
): Promise<FetchedMessage> {
  const id: tl.TypeInputMessage[] = [{ _: 'inputMessageID', id: messageId }]
  const peer = chat.inputPeer
  const response =
    peer._ === 'inputPeerChannel'
      ? await client.call(
          {
            _: 'channels.getMessages',
            channel: {
              _: 'inputChannel',
              channelId: peer.channelId,
              accessHash: peer.accessHash,
            },
            id,
          },
          { abortSignal: signal },
        )
      : await client.call(
          { _: 'messages.getMessages', id },
          { abortSignal: signal },
        )

  if (response._ === 'messages.messagesNotModified') {
    throw messageNotFound(chat.chatId, messageId)
  }
  const message = response.messages.find(
    (item): item is FetchedRawMessage =>
      item._ !== 'messageEmpty' && item.id === messageId,
  )
  if (!message || toPeerIdFromRawPeer(message.peerId) !== chat.chatId) {
    throw messageNotFound(chat.chatId, messageId)
  }
  return { message, chats: response.chats, users: response.users }
}

/**
 * Write the fetched message to the cache in one transaction, its full
 * (non-min) senders first, as history pages do: a fresh raw_json, the live
 * message_type and the attachment row. An unchanged message writes nothing.
 * chats_cache is not written: a chat object would clobber the dialog fields.
 */
export function cacheFetchedMessage(
  cacheDb: Database,
  chatId: number,
  message: FetchedRawMessage,
  users: tl.TypeUser[],
): void {
  const input = parseRawMessage(message, chatId)
  if (!input) return
  const usersCache = createUsersCache(cacheDb)
  const messagesCache = createMessagesCache(cacheDb)
  cacheDb.transaction(() => {
    for (const user of users) {
      if (user._ === 'user' && !user.min) {
        usersCache.upsert(apiUserToCacheInput(user))
      }
    }
    messagesCache.upsert(input)
  })()
}
