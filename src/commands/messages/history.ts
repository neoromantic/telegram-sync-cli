/**
 * Chat history for `tg messages list` and `tg messages get`: cache-first
 * reads, and Telegram pages written back to the cache so they are read back
 * exactly like cached ones. The cache answers only inside the ranges that
 * cached pages recorded (src/db/history-ranges.ts), so a read never runs
 * across a gap in the cache.
 */
import type { Database } from 'bun:sqlite'
import type { TelegramClient, tl } from '@mtcute/bun'

import { getErrorMessage } from '../../daemon/daemon-utils'
import {
  cachePageUsers,
  createMessageInputs,
  fetchMessagesRaw,
  forwardPageRequest,
  rawMessageId,
} from '../../daemon/sync-worker-real-helpers'
import type { AccountsDbInterface } from '../../db'
import type { ChatsCache } from '../../db/chats-cache'
import { createHistoryRanges, type PageBounds } from '../../db/history-ranges'
import { createMessagesCache } from '../../db/messages-cache'
import { createMessagesHistory } from '../../db/messages-history'
import type { MessageSearchRow } from '../../db/messages-search'
import { createUsersCache, type UsersCache } from '../../db/users-cache'
import type { MessageSearchItem } from '../../types'
import { verbose } from '../../utils/output'
import { toPeerIdFromInputPeer } from '../../utils/telegram-peer-ids'
import { type DmLookup, resolvePeer } from '../send/peer-resolver'
import { resolveSelfId } from '../send/sent-message-cache'
import {
  type HistoryClient,
  MessageNotFoundError,
  messageItemReader,
  messageRowsToItems,
} from './helpers'

type CallClient = Pick<TelegramClient, 'call'>

export interface HistoryChat {
  /** Marked peer ID, the `chat_id` of messages_cache */
  chatId: number
  inputPeer: tl.TypeInputPeer
}

export interface ResolveHistoryChatDeps {
  usersCache: UsersCache
  chatsCache: ChatsCache
  dms: DmLookup
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
    deps.dms,
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
 * Write a getHistory page to the cache in one transaction, with the range
 * it covers, and return the IDs of the messages it stored. Full (non-min)
 * senders go in first, because the search index reads sender names when a
 * message row is written. Sync cursors stay where the daemon left them.
 */
export function cacheHistoryResponse(
  cacheDb: Database,
  chatId: number,
  messages: unknown[],
  users: tl.TypeUser[],
  bounds: PageBounds,
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
    cachePageUsers(usersCache, users)
    messagesCache.upsertBatch(inputs)
    createHistoryRanges(cacheDb).recordPage(
      chatId,
      messages.map(rawMessageId),
      bounds,
    )
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

  // Paging back, the page is the newest messages below `before` and a short
  // one reaches the first message. Paging forward, it is the oldest messages
  // above `after`, and only a short one leaves nothing up to `before`.
  const short = messages.length < window.limit
  const bounds: PageBounds =
    window.after === undefined
      ? { before: window.before, reachedStart: short }
      : { after: window.after, before: short ? window.before : undefined }

  const ids = cacheHistoryResponse(cacheDb, chat.chatId, page, users, bounds)
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

interface CachedWindow {
  /** Newest first, cut where the recorded range ends */
  rows: MessageSearchRow[]
  /** The cache holds the whole window, so Telegram has nothing to add */
  whole: boolean
}

/**
 * A window as the cache holds it. The page starts at its anchor: just below
 * `before`, or at the newest cached message, paging back; just above
 * `after` paging forward. It is whole when the recorded range that holds
 * the anchor holds `limit` messages of it, or fewer because the range
 * reaches the chat's first message (paging back) or `before` (paging
 * forward). A short page past the newest cached message is not whole.
 */
function readCachedWindow(
  cacheDb: Database,
  chatId: number,
  { limit, before, after }: HistoryWindow,
  includeDeleted: boolean,
): CachedWindow {
  const history = createMessagesHistory(cacheDb)
  const ranges = createHistoryRanges(cacheDb)

  if (after === undefined) {
    // Message IDs start at 1
    if (before !== undefined && before <= 1) return { rows: [], whole: true }

    const newest = createMessagesCache(cacheDb).getLatestMessageId(chatId)
    const anchor = Math.min(newest ?? 0, (before ?? Number.MAX_VALUE) - 1)
    const range = anchor > 0 ? ranges.find(chatId, anchor) : null
    if (!range) return { rows: [], whole: false }

    const rows = history
      .list(chatId, { limit, before: anchor + 1, includeDeleted })
      .filter((row) => row.message_id >= range.low)
    return { rows, whole: rows.length === limit || range.low === 1 }
  }

  const range = ranges.find(chatId, after + 1)
  if (!range) return { rows: [], whole: false }

  const rows = history
    .list(chatId, { limit, after, before, includeDeleted })
    .filter((row) => row.message_id <= range.high)
  const reachesBefore = before !== undefined && range.high >= before - 1
  return { rows, whole: rows.length === limit || reachesBefore }
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
    const cached = readCachedWindow(
      cacheDb,
      chat.chatId,
      window,
      includeDeleted,
    )
    if (cached.whole) {
      return { rows: cached.rows, source: 'cache' }
    }
  }

  const rows = await fetchHistoryPage(client, cacheDb, chat, window)
  return { rows, source: 'api' }
}

/**
 * One page of a chat, newest first. The cache answers when it holds the
 * whole window without a gap; otherwise, or with `fresh`, Telegram does.
 */
export async function listHistory(
  options: ListHistoryOptions,
): Promise<ListHistoryResult> {
  const { chat, window } = options
  const { rows, source } = await readHistoryPage(options)
  const ids = rows.map((row) => row.message_id)

  return {
    chatId: chat.chatId,
    items: messageRowsToItems(options.cacheDb, rows),
    limit: window.limit,
    before: window.before ?? null,
    after: window.after ?? null,
    nextBefore: ids.length > 0 ? Math.min(...ids) : null,
    nextAfter: ids.length > 0 ? Math.max(...ids) : null,
    source,
    stale: false,
  }
}

/**
 * The `messages.getHistory` page around one message: `offsetId` one above
 * it makes the page start at the message, and a negative `addOffset` adds
 * the `context` newer ones, so `2 * context + 1` covers both sides.
 */
export function aroundRequest(messageId: number, context: number) {
  return {
    offsetId: messageId + 1,
    addOffset: context > 0 ? -context : 0,
    limit: 2 * context + 1,
  }
}

export interface MessageAround {
  message: MessageSearchRow
  /** Up to `context` newer messages, newest first */
  newer: MessageSearchRow[]
  /** Up to `context` older messages, newest first */
  older: MessageSearchRow[]
}

function closest(ids: number[], to: number, side: 1 | -1, count: number) {
  return ids
    .filter((id) => side * (id - to) > 0)
    .sort((a, b) => side * (a - b))
    .slice(0, count)
}

/**
 * Fetch a message and `context` messages on each side from Telegram, cache
 * them and read them back from the cache.
 */
export async function fetchMessageAround(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  messageId: number,
  context: number,
): Promise<MessageAround> {
  const { messages, users } = await callHistory(
    client,
    chat,
    aroundRequest(messageId, context),
  )
  const ids = messages.map(rawMessageId)
  if (!ids.includes(messageId)) {
    throw new MessageNotFoundError(chat.chatId, messageId)
  }

  const older = closest(ids, messageId, -1, context)
  const keep = new Set([
    messageId,
    ...closest(ids, messageId, 1, context),
    ...older,
  ])
  const page = messages.filter((message) => keep.has(rawMessageId(message)))
  // The page is a run of consecutive messages; with fewer older messages
  // than asked for, it reaches the first message of the chat
  const stored = cacheHistoryResponse(cacheDb, chat.chatId, page, users, {
    reachedStart: older.length < context,
  })
  const rows = createMessagesHistory(cacheDb).getMany(chat.chatId, stored)

  const message = rows.find((row) => row.message_id === messageId)
  if (!message) {
    throw new MessageNotFoundError(chat.chatId, messageId)
  }
  return {
    message,
    newer: rows.filter((row) => row.message_id > messageId),
    older: rows.filter((row) => row.message_id < messageId),
  }
}

export interface GetMessageOptions {
  cacheDb: Database
  client: CallClient
  chat: HistoryChat
  messageId: number
  /** Messages on each side of the target */
  context: number
  includeDeleted: boolean
  fresh: boolean
}

export interface GetMessageResult {
  chatId: number
  message: MessageSearchItem
  /** Newest first, so `[...newer, message, ...older]` reads like a list page */
  newer: MessageSearchItem[]
  /** Newest first */
  older: MessageSearchItem[]
  source: 'cache' | 'api'
  stale: false
}

interface CachedAround {
  around: MessageAround
  /** False when a side of the context has to come from Telegram */
  complete: boolean
}

/**
 * The message and its context from the cache, or null if the message isn't
 * cached. Each side is a `list` window next to the message, so it is
 * complete only when the cache holds it whole; a side is cut where the
 * recorded range ends. A deleted message is complete as it is: Telegram no
 * longer returns it.
 */
function readAroundFromCache(
  cacheDb: Database,
  chatId: number,
  messageId: number,
  context: number,
  includeDeleted: boolean,
): CachedAround | null {
  const history = createMessagesHistory(cacheDb)
  const [message] = history.getMany(chatId, [messageId])
  if (!message) return null
  if (context === 0) {
    return { around: { message, newer: [], older: [] }, complete: true }
  }

  // A deleted target is still returned; its context follows --includeDeleted
  const side = (bound: 'after' | 'before') =>
    readCachedWindow(
      cacheDb,
      chatId,
      { limit: context, [bound]: messageId },
      includeDeleted,
    )
  const newer = side('after')
  const older = side('before')
  return {
    around: { message, newer: newer.rows, older: older.rows },
    complete: message.is_deleted === 1 || (newer.whole && older.whole),
  }
}

async function readAround(
  options: GetMessageOptions,
): Promise<{ around: MessageAround; source: 'cache' | 'api' }> {
  const { cacheDb, client, chat, messageId, context } = options
  const cached = options.fresh
    ? null
    : readAroundFromCache(
        cacheDb,
        chat.chatId,
        messageId,
        context,
        options.includeDeleted,
      )
  if (cached?.complete) {
    return { around: cached.around, source: 'cache' }
  }

  try {
    const around = await fetchMessageAround(
      client,
      cacheDb,
      chat,
      messageId,
      context,
    )
    return { around, source: 'api' }
  } catch (err) {
    // The cache holds the message: Telegram no longer returns it, or it
    // can't be asked (no credentials or connection, a flood wait, a peer
    // without an access hash). Serve the context the cache holds.
    if (cached) {
      verbose(
        `Serving message ${messageId} from the cache: ${getErrorMessage(err)}`,
      )
      return { around: cached.around, source: 'cache' }
    }
    throw err
  }
}

/**
 * One message with up to `context` messages on each side. The cache answers
 * when it holds the message and both sides whole; otherwise, or with
 * `fresh`, one Telegram call fetches the message with both sides. If that
 * call fails and the message is cached, the cache answers with what it
 * holds of the sides; `fresh` reports the failure.
 */
export async function getMessageWithContext(
  options: GetMessageOptions,
): Promise<GetMessageResult> {
  const { around, source } = await readAround(options)
  const toItem = messageItemReader(options.cacheDb)

  return {
    chatId: options.chat.chatId,
    message: toItem(around.message),
    newer: around.newer.map(toItem),
    older: around.older.map(toItem),
    source,
    stale: false,
  }
}
