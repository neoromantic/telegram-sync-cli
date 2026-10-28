import type { Database } from 'bun:sqlite'
import type { TelegramClient, tl } from '@mtcute/bun'

import { getErrorMessage } from '../../daemon/daemon-utils'
import { parseRawMessage } from '../../daemon/sync-worker-real-helpers'
import type { AccountsDbInterface } from '../../db'
import { createMessagesCache, type MessageInput } from '../../db/messages-cache'
import { verbose } from '../../utils/output'
import { toRawJson } from '../../utils/raw-json'
import {
  toPeerIdFromInputPeer,
  toPeerIdFromRawPeer,
} from '../../utils/telegram-peer-ids'

/** What `tg send` asked Telegram to send */
export type SentMessageRequest = {
  peer: tl.TypeInputPeer
  /** The text, or the caption of a file */
  text: string
  replyTo?: number
}

export type SentMessageCacheDeps = {
  cacheDb: Database
  /** Own user ID, needed only for `updateShortSentMessage` */
  getSelfId: () => Promise<number>
}

function fromShortSentMessage(
  result: tl.RawUpdateShortSentMessage,
  request: SentMessageRequest,
  selfId: number,
): MessageInput | null {
  const chatId = toPeerIdFromInputPeer(request.peer, selfId)
  if (chatId === null) return null

  // The short response has no message object: rebuild one from the request
  // and map it the same way the sync worker maps fetched messages
  const parsed = parseRawMessage(
    {
      _: 'message',
      id: result.id,
      out: result.out,
      date: result.date,
      message: request.text,
      fromId: { _: 'peerUser', userId: selfId },
      replyTo: request.replyTo
        ? { _: 'messageReplyHeader', replyToMsgId: request.replyTo }
        : undefined,
      media: result.media,
      entities: result.entities,
    },
    chatId,
  )
  if (!parsed) return null

  return { ...parsed, raw_json: toRawJson(result) }
}

function fromUpdates(updates: tl.TypeUpdate[]): MessageInput[] {
  const inputs: MessageInput[] = []
  for (const update of updates) {
    if (
      update._ !== 'updateNewMessage' &&
      update._ !== 'updateNewChannelMessage'
    ) {
      continue
    }
    const chatId = toPeerIdFromRawPeer(update.message.peerId)
    if (chatId === null) continue
    const parsed = parseRawMessage(update.message, chatId)
    if (parsed) inputs.push(parsed)
  }
  return inputs
}

/**
 * Turn a `messages.sendMessage` or `messages.sendMedia` response into
 * messages_cache rows, with marked peer IDs as `chat_id` like the daemon.
 * The messages cache writes a sent file's attachment row with its message.
 */
export function buildSentMessageInputs(
  result: tl.TypeUpdates,
  request: SentMessageRequest,
  selfId: number | null,
): MessageInput[] {
  if (result._ === 'updateShortSentMessage') {
    if (selfId === null) return []
    const input = fromShortSentMessage(result, request, selfId)
    return input ? [input] : []
  }
  if ('updates' in result) {
    return fromUpdates(result.updates)
  }
  return []
}

/**
 * Store a message `tg send` just sent in messages_cache. Telegram pushes no
 * update for it to this session, nor to a daemon that shares the session.
 * Never throws: the message is already sent, so a failure is only logged.
 */
export async function cacheSentMessage(
  deps: SentMessageCacheDeps,
  result: tl.TypeUpdates,
  request: SentMessageRequest,
): Promise<number> {
  try {
    const selfId =
      result._ === 'updateShortSentMessage' ? await deps.getSelfId() : null
    const inputs = buildSentMessageInputs(result, request, selfId)
    if (inputs.length === 0) {
      verbose(`Sent message not cached: no message in ${result._}`)
      return 0
    }
    createMessagesCache(deps.cacheDb).upsertBatch(inputs)
    verbose(`Cached ${inputs.length} sent message(s)`)
    return inputs.length
  } catch (err) {
    verbose(`Could not cache the sent message: ${getErrorMessage(err)}`)
    return 0
  }
}

/**
 * Own user ID from the account row. Older rows may lack it: then ask
 * Telegram once and save it, as `tg me` does.
 */
export async function resolveSelfId(
  client: Pick<TelegramClient, 'getMe'>,
  accountId: number | undefined,
  accounts: Pick<AccountsDbInterface, 'getById' | 'getActive' | 'update'>,
): Promise<number> {
  const account =
    accountId !== undefined ? accounts.getById(accountId) : accounts.getActive()
  if (account?.user_id) return account.user_id

  const me = await client.getMe()
  if (account) {
    try {
      accounts.update(account.id, { user_id: me.id })
    } catch (err) {
      verbose(`Could not save user_id for account: ${getErrorMessage(err)}`)
    }
  }
  return me.id
}
