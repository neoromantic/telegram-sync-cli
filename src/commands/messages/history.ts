/**
 * Chat history for `tg messages list`: cache-first reads, and Telegram pages
 * written back to the cache so they are read back exactly like cached ones.
 */
import type { Database } from 'bun:sqlite'
import type { TelegramClient, tl } from '@mtcute/bun'

import {
  createMessageInputs,
  fetchMessagesRaw,
  forwardPageRequest,
  rawMessageId,
} from '../../daemon/sync-worker-real-helpers'
import type { AccountsDbInterface } from '../../db'
import { createChatSyncStateService } from '../../db/chat-sync-state'
import type { ChatsCache } from '../../db/chats-cache'
import { createMessagesCache } from '../../db/messages-cache'
import { createMessagesHistory } from '../../db/messages-history'
import type { MessageSearchRow } from '../../db/messages-search'
import { createUsersCache, type UsersCache } from '../../db/users-cache'
import type { MessageSearchItem } from '../../types'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import { toPeerIdFromInputPeer } from '../../utils/telegram-peer-ids'
import { resolvePeer } from '../send/peer-resolver'
import { resolveSelfId } from '../send/sent-message-cache'
import { type HistoryClient, messageRowToItem } from './helpers'

type CallClient = Pick<TelegramClient, 'call'>

export interface HistoryChat {
  /** Marked peer ID, the `chat_id` of messages_cache */
  chatId: number
  inputPeer: tl.TypeInputPeer
}

export interface ResolveHistoryChatDeps {
  usersCache: UsersCache
  chatsCache: ChatsCache
  accounts: Pick<AccountsDbInterface, 'getById' | 'getActive' | 'update'>
  accountId: number | undefined
}

/**
 * Resolve `--chat` the way `tg send --to` does, plus the marked chat ID the
 * cache stores its messages under. Saved Messages is the own user ID.
 */
export async function resolveHistoryChat(
  client: HistoryClient,
  identifier: string,
  deps: ResolveHistoryChatDeps,
): Promise<HistoryChat> {
  const { inputPeer } = await resolvePeer(
    client,
    identifier,
    deps.usersCache,
    deps.chatsCache,
  )
  const selfId =
    inputPeer._ === 'inputPeerSelf'
      ? await resolveSelfId(client, deps.accountId, deps.accounts)
      : null
  const chatId = toPeerIdFromInputPeer(inputPeer, selfId)
  if (chatId === null) {
    throw new Error(`Could not resolve chat ${identifier}`)
  }
  return { chatId, inputPeer }
}

/** A page of history. Both bounds are exclusive message IDs. */
export interface HistoryWindow {
  limit: number
  before?: number
  after?: number
}

/**
 * The `messages.getHistory` page for a window: the newest `limit` messages
 * below `before`, or, with `after`, the `limit` messages right above it (the
 * daemon's forward page, capped by `before`).
 */
export function historyRequest({ limit, before, after }: HistoryWindow) {
  if (after !== undefined) {
    return { ...forwardPageRequest(after, limit), maxId: before ?? 0 }
  }
  return { offsetId: before ?? 0, limit }
}

/**
 * Write a getHistory page to the cache in one transaction and return the
 * IDs of the messages it stored. Full (non-min) senders go in first, because
 * the search index reads sender names when a message row is written.
 * Sync cursors stay where the daemon left them.
 */
export function cacheHistoryResponse(
  cacheDb: Database,
  chatId: number,
  messages: unknown[],
  users: tl.TypeUser[],
): number[] {
  const usersCache = createUsersCache(cacheDb)
  const messagesCache = createMessagesCache(cacheDb)
  const { inputs } = createMessageInputs(
    messages,
    chatId,
    Number.MAX_SAFE_INTEGER,
    0,
  )

  cacheDb.transaction(() => {
    for (const user of users) {
      if (user._ === 'user' && !user.min) {
        usersCache.upsert(apiUserToCacheInput(user))
      }
    }
    messagesCache.upsertBatch(inputs)
  })()

  return inputs.map((input) => input.message_id)
}

const PEER_HINT = 'run tg chats list --fresh or pass the @username'

/** Telegram can't find a chat built from a bare ID without an access hash */
function withPeerHint(err: unknown): unknown {
  if (
    err instanceof Error &&
    /CHANNEL_INVALID|PEER_ID_INVALID/.test(err.message)
  ) {
    return new Error(`${err.message} (${PEER_HINT})`)
  }
  return err
}

async function callHistory(
  client: CallClient,
  chat: HistoryChat,
  request: Parameters<typeof fetchMessagesRaw>[2],
) {
  try {
    return await fetchMessagesRaw(client, chat.inputPeer, request)
  } catch (err) {
    throw withPeerHint(err)
  }
}

/**
 * Fetch one window from Telegram, cache it and read it back from the cache,
 * so API items are exactly cache items. Messages outside the window are
 * dropped, and a long page keeps the `limit` messages closest to its anchor.
 */
export async function fetchHistoryPage(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  window: HistoryWindow,
): Promise<MessageSearchRow[]> {
  const { messages, users } = await callHistory(
    client,
    chat,
    historyRequest(window),
  )

  const floor = window.after ?? 0
  const ceiling = window.before ?? Number.POSITIVE_INFINITY
  const fromAnchor = window.after !== undefined ? 1 : -1
  const page = messages
    .filter((message) => {
      const id = rawMessageId(message)
      return id > floor && id < ceiling
    })
    .sort((a, b) => fromAnchor * (rawMessageId(a) - rawMessageId(b)))
    .slice(0, window.limit)

  const ids = cacheHistoryResponse(cacheDb, chat.chatId, page, users)
  return createMessagesHistory(cacheDb).getMany(chat.chatId, ids)
}

export interface ListHistoryOptions {
  cacheDb: Database
  client: CallClient
  chat: HistoryChat
  window: HistoryWindow
  includeDeleted: boolean
  fresh: boolean
}

export interface ListHistoryResult {
  chatId: number
  /** Newest first */
  items: MessageSearchItem[]
  limit: number
  before: number | null
  after: number | null
  /** Pass as `--before` for the next older page; null on an empty page */
  nextBefore: number | null
  /** Pass as `--after` for the next newer page; null on an empty page */
  nextAfter: number | null
  source: 'cache' | 'api'
  stale: false
}

function isHistoryComplete(cacheDb: Database, chatId: number): boolean {
  return createChatSyncStateService(cacheDb).get(chatId)?.history_complete === 1
}

async function readHistoryPage({
  cacheDb,
  client,
  chat,
  window,
  includeDeleted,
  fresh,
}: ListHistoryOptions): Promise<{
  rows: MessageSearchRow[]
  source: 'cache' | 'api'
}> {
  if (!fresh) {
    const rows = createMessagesHistory(cacheDb).list(chat.chatId, {
      ...window,
      includeDeleted,
    })
    if (rows.length > 0) {
      return { rows, source: 'cache' }
    }
    // The daemon cached a fully synced chat down to its first message, so
    // there is nothing older to ask Telegram for
    const olderOnly = window.before !== undefined && window.after === undefined
    if (olderOnly && isHistoryComplete(cacheDb, chat.chatId)) {
      return { rows: [], source: 'cache' }
    }
  }

  const rows = await fetchHistoryPage(client, cacheDb, chat, window)
  return { rows, source: 'api' }
}

/**
 * One page of a chat, newest first. The cache answers when it holds any
 * message of the window; otherwise, or with `fresh`, Telegram does.
 */
export async function listHistory(
  options: ListHistoryOptions,
): Promise<ListHistoryResult> {
  const { chat, window } = options
  const { rows, source } = await readHistoryPage(options)
  const ids = rows.map((row) => row.message_id)

  return {
    chatId: chat.chatId,
    items: rows.map(messageRowToItem),
    limit: window.limit,
    before: window.before ?? null,
    after: window.after ?? null,
    nextBefore: ids.length > 0 ? Math.min(...ids) : null,
    nextAfter: ids.length > 0 ? Math.max(...ids) : null,
    source,
    stale: false,
  }
}
