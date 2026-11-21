import type { Database } from "bun:sqlite";
import type { TelegramClient, tl } from "@mtcute/bun";

import { getErrorMessage } from "../../daemon/daemon-utils";
import {
  cachePageUsers,
  createMessageInputs,
  fetchMessagesRaw,
  forwardPageRequest,
  rawMessageId,
} from "../../daemon/sync-worker-real-helpers";
import type { AccountsDbInterface } from "../../db";
import { isMigrationPending } from "../../db/background-migrations";
import { type ChatsCache, createChatsCache } from "../../db/chats-cache";
import { createGroupParticipation } from "../../db/group-participation";
import { createHistoryRanges, type PageBounds } from "../../db/history-ranges";
import { createMessagesCache } from "../../db/messages-cache";
import { createMessagesHistory, type MessageFilter } from "../../db/messages-history";
import type { MessageSearchRow } from "../../db/messages-search";
import { MESSAGE_TYPES_MIGRATION } from "../../db/raw-json-migrations";
import { createUsersCache, type UsersCache } from "../../db/users-cache";
import type { MessageSearchItem } from "../../types";
import { normalizeUsername } from "../../utils/identifiers";
import { verbose } from "../../utils/output";
import { toInputPeerFromPeerId, toPeerIdFromInputPeer } from "../../utils/telegram-peer-ids";
import { type DmLookup, type ResolvePeerOptions, resolvePeer } from "../send/peer-resolver";
import { resolveSelfId } from "../send/sent-message-cache";
import {
  ChatNotCachedError,
  createLazyClient,
  type HistoryClient,
  MAX_MESSAGE_ID,
  MessageNotFoundError,
  type MessageRow,
  messageItemReader,
  messageRowsToItems,
} from "./helpers";

type CallClient = Pick<TelegramClient, "call">;

export interface HistoryChat {
  /** Marked peer ID, the `chat_id` of messages_cache */
  chatId: number;
  inputPeer: tl.TypeInputPeer;
}

export interface ResolveHistoryChatDeps {
  usersCache: UsersCache;
  chatsCache: ChatsCache;
  dms: DmLookup;
  accounts: Pick<AccountsDbInterface, "getById" | "getActive" | "update">;
  accountId: number | undefined;
}

/**
 * Resolve `--chat` the way `tg send --to` does, plus the marked chat ID the
 * cache stores its messages under. Saved Messages is the own user ID.
 */
export async function resolveHistoryChat(
  client: HistoryClient,
  identifier: string,
  deps: ResolveHistoryChatDeps,
  options?: ResolvePeerOptions,
) {
  const { inputPeer, name } = await resolvePeer(
    client,
    identifier,
    deps.usersCache,
    deps.chatsCache,
    deps.dms,
    options,
  );
  const selfId =
    inputPeer._ === "inputPeerSelf"
      ? await resolveSelfId(client, deps.accountId, deps.accounts)
      : null;
  const chatId = toPeerIdFromInputPeer(inputPeer, selfId);
  if (chatId === null) {
    throw new Error(`Could not resolve chat ${identifier}`);
  }
  const result: HistoryChat & { name: string } = { chatId, inputPeer, name };
  return result;
}

const CHAT_USERNAME = /^@?(?!(?:me|self)$)[a-z]\w*$/i;

/**
 * Resolve `--chat` from the cache alone, for a read that never connects to
 * Telegram. A cached @username resolves without an access hash too, so its
 * input peer may lack one; anything only Telegram could resolve throws
 * ChatNotCachedError.
 */
export async function resolveCachedChat(identifier: string, deps: ResolveHistoryChatDeps) {
  const value = identifier.trim();
  if (CHAT_USERNAME.test(value)) {
    const username = normalizeUsername(value);
    const id =
      deps.usersCache.getByUsername(username)?.user_id ??
      deps.chatsCache.getByUsername(username)?.chat_id;
    const inputPeer = id === undefined ? null : toInputPeerFromPeerId(Number(id), null);
    if (inputPeer) {
      const chat: HistoryChat & { name: string } = { chatId: Number(id), inputPeer, name: value };
      return chat;
    }
  }
  const offline = createLazyClient(() => {
    throw new ChatNotCachedError(value);
  });
  return resolveHistoryChat(offline, value, deps);
}

/** A page of history. Both bounds are exclusive message IDs. */
export interface HistoryWindow {
  limit: number;
  before?: number;
  after?: number;
}

/**
 * The `messages.getHistory` page for a window: the newest `limit` messages
 * below `before`, or, with `after`, the `limit` messages right above it (the
 * daemon's forward page, capped by `before`).
 */
export function historyRequest({ limit, before, after }: HistoryWindow) {
  if (after !== undefined) {
    return { ...forwardPageRequest(after, limit), maxId: before ?? 0 };
  }
  return { offsetId: before ?? 0, limit };
}

/**
 * Write a getHistory page to the cache in one transaction, with the range
 * it covers, and return its rows, newest first, as the cache would read
 * them back. Full (non-min) senders go in first, because the search index
 * reads sender names when a message row is written. Sync cursors stay where
 * the daemon left them.
 *
 * A group the account doesn't take part in keeps its new messages out of
 * the cache (src/db/group-participation.ts), so the rows come from the page
 * itself, and a page with any message kept out records no range.
 */
export function cacheHistoryResponse(
  cacheDb: Database,
  chatId: number,
  messages: unknown[],
  users: tl.TypeUser[],
  bounds: PageBounds,
) {
  const usersCache = createUsersCache(cacheDb);
  const messagesCache = createMessagesCache(cacheDb);
  const inputs = createMessageInputs(messages, chatId);

  cacheDb
    .transaction(() => {
      cachePageUsers(usersCache, users);
      const { skipped } = messagesCache.upsertBatch(inputs);
      if (skipped === 0) {
        createHistoryRanges(cacheDb).recordPage(chatId, messages.map(rawMessageId), bounds);
      }
    })
    .immediate();

  const chat = createChatsCache(cacheDb).getById(String(chatId));
  const fetchedAt = Date.now();
  return inputs
    .map((input) => {
      const u = input.from_id != null ? usersCache.getById(String(input.from_id)) : null;
      const result: MessageRow = {
        chat_id: input.chat_id,
        message_id: input.message_id,
        from_id: input.from_id ?? null,
        text: input.text ?? null,
        message_type: input.message_type,
        has_media: input.has_media ? 1 : 0,
        media_path: input.media_path ?? null,
        is_outgoing: input.is_outgoing ? 1 : 0,
        is_edited: input.is_edited ? 1 : 0,
        is_pinned: input.is_pinned ? 1 : 0,
        is_deleted: input.is_deleted ? 1 : 0,
        reply_to_id: input.reply_to_id ?? null,
        forward_from_id: input.forward_from_id ?? null,
        edit_date: input.edit_date ?? null,
        date: input.date,
        fetched_at: fetchedAt,
        chat_title: chat?.title ?? null,
        chat_username: chat?.username ?? null,
        chat_type: chat?.type ?? null,
        sender_username: u?.username ?? null,
        sender_first_name: u?.first_name ?? null,
        sender_last_name: u?.last_name ?? null,
        raw_json: input.raw_json,
      };
      return result;
    })
    .sort((a, b) => b.message_id - a.message_id);
}

const PEER_HINT = "run tg chats list --fresh or pass the @username";

/** Telegram can't find a chat built from a bare ID without an access hash */
export function withPeerHint(err: unknown) {
  if (err instanceof Error && /CHANNEL_INVALID|PEER_ID_INVALID/.test(err.message)) {
    return new Error(`${err.message} (${PEER_HINT})`);
  }
  return err;
}

async function callHistory(
  client: CallClient,
  chat: HistoryChat,
  request: Parameters<typeof fetchMessagesRaw>[2],
) {
  try {
    return await fetchMessagesRaw(client, chat.inputPeer, request);
  } catch (err) {
    throw withPeerHint(err);
  }
}

/**
 * Fetch one window from Telegram and cache it. Its rows come back in the
 * cache's row shape, so API items are exactly cache items. Messages outside
 * the window are dropped, and a long page keeps the `limit` messages closest
 * to its anchor.
 */
export async function fetchHistoryPage(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  window: HistoryWindow,
) {
  const knownTop = createHistoryRanges(cacheDb).knownTop(chat.chatId);
  const { messages, users } = await callHistory(client, chat, historyRequest(window));

  const floor = window.after ?? 0;
  const ceiling = window.before ?? Number.POSITIVE_INFINITY;
  const fromAnchor = window.after !== undefined ? 1 : -1;
  const page = messages
    .filter((message) => {
      const id = rawMessageId(message);
      return id > floor && id < ceiling;
    })
    .sort((a, b) => fromAnchor * (rawMessageId(a) - rawMessageId(b)))
    .slice(0, window.limit);

  const short = messages.length < window.limit;
  let bounds: PageBounds = { after: window.after };
  if (window.after === undefined) {
    bounds = { before: window.before, reachedStart: short, knownTop };
  } else if (short) {
    bounds = { after: window.after, before: window.before, knownTop };
  }

  return cacheHistoryResponse(cacheDb, chat.chatId, page, users, bounds);
}

export interface ListHistoryOptions {
  cacheDb: Database;
  client: CallClient;
  chat: HistoryChat;
  window: HistoryWindow;
  includeDeleted: boolean;
  fresh: boolean;
  /** Read only the cache, with these filters (see readFilteredPage) */
  filter?: MessageFilter;
}

export interface ListHistoryResult {
  chatId: number;
  /** Newest first */
  items: MessageSearchItem[];
  limit: number;
  before: number | null;
  after: number | null;
  /** Pass as `--before` for the next older page; null on an empty page */
  nextBefore: number | null;
  /** Pass as `--after` for the next newer page; null on an empty page */
  nextAfter: number | null;
  source: "cache" | "api";
  stale: false;
}

/** Why a filtered page may lack matches */
export type MissingPart = "history" | "types";

export interface FilteredCoverage {
  /**
   * No message of the chat that matches is missing from the page, as of the
   * chat's newest known message: missing is empty
   */
  complete: boolean;
  /**
   * `history`: the cache lacks messages of the page's span. `types`: some
   * cached messages have no type to filter on yet (a background migration
   * or a refetch of their raw message is pending)
   */
  missing: MissingPart[];
  /**
   * Where the newest gap ends: the `--before` of the unfiltered page that
   * fills it. Null without a gap, or when the gap reaches the chat's newest
   * message (the newest page fills it)
   */
  missingBefore: number | null;
}

/** The newest gap in the span a filtered page vouches for */
export interface HistoryGap {
  /** The first and last message ID the cache lacks */
  low: number;
  high: number;
  /** The `--before` of the page that fills it; null for the newest page */
  before: number | null;
  /** False when the cache keeps out the group's messages of the gap's time */
  fillable: boolean;
}

/** Why `--type` may miss cached messages of the page's span */
export interface UntypedRows {
  /** The migration that types older rows is unfinished */
  migrating: boolean;
  /** The newest media row still waiting for its raw message, or null */
  newestAwaitingRaw: number | null;
}

export interface FilteredPage {
  page: ListHistoryResult & FilteredCoverage;
  gap: HistoryGap | null;
  /** Null without --type, or when every row of the span has its type */
  untyped: UntypedRows | null;
}

function readCachedWindow(
  cacheDb: Database,
  chatId: number,
  { limit, before, after }: HistoryWindow,
  includeDeleted: boolean,
) {
  const history = createMessagesHistory(cacheDb);
  const ranges = createHistoryRanges(cacheDb);

  if (after === undefined) {
    if (before !== undefined && before <= 1) return { rows: [], whole: true };

    const newest = createMessagesCache(cacheDb).getLatestMessageId(chatId);
    const anchor = Math.min(newest ?? 0, (before ?? Number.MAX_VALUE) - 1);
    const range = anchor > 0 ? ranges.find(chatId, anchor) : null;
    if (!range) return { rows: [], whole: false };

    const rows = history
      .list(chatId, { limit, before: anchor + 1, includeDeleted })
      .filter((row) => row.message_id >= range.low);
    return { rows, whole: rows.length === limit || range.low === 1 };
  }

  const range = ranges.find(chatId, after + 1);
  if (!range) return { rows: [], whole: false };

  const rows = history
    .list(chatId, { limit, after, before, includeDeleted })
    .filter((row) => row.message_id <= range.high);
  const reachesBefore = before !== undefined && range.high >= before - 1;
  return { rows, whole: rows.length === limit || reachesBefore };
}

async function readHistoryPage({
  cacheDb,
  client,
  chat,
  window,
  includeDeleted,
  fresh,
}: ListHistoryOptions) {
  if (!fresh) {
    const cached = readCachedWindow(cacheDb, chat.chatId, window, includeDeleted);
    if (cached.whole) {
      return { rows: cached.rows, source: "cache" as const };
    }
  }

  const rows = await fetchHistoryPage(client, cacheDb, chat, window);
  return { rows, source: "api" as const };
}

function pageSpan({ limit, before, after }: HistoryWindow, ids: number[], top: number | null) {
  let low = (after ?? 0) + 1;
  let high = Math.min(top ?? MAX_MESSAGE_ID, (before ?? MAX_MESSAGE_ID + 1) - 1);
  if (ids.length === limit) {
    if (after === undefined) low = Math.max(low, Math.min(...ids));
    else high = Math.min(high, Math.max(...ids));
  }
  return { low, high };
}

function vouchedSpan(
  cacheDb: Database,
  chatId: number,
  filter: MessageFilter,
  page: { low: number; high: number },
) {
  const history = createMessagesHistory(cacheDb);
  const ranges = createHistoryRanges(cacheDb);
  let { low, high } = page;
  if (filter.until !== undefined) {
    const late = history.firstSentFrom(chatId, low, high, filter.until);
    if (late !== null && ranges.holdsEvery(chatId, late, high)) high = late - 1;
  }
  if (filter.since !== undefined) {
    const early = history.lastSentBefore(chatId, low, high, filter.since);
    if (early !== null && ranges.holdsEvery(chatId, low, early)) low = early + 1;
  }
  return low <= high ? { low, high } : null;
}

function sentDuringCaptureGap(cacheDb: Database, chatId: number, low: number, high: number) {
  const row = cacheDb
    .query(`
      SELECT 1 FROM group_capture_gaps
      WHERE chat_id = $id
        AND end_date > COALESCE((SELECT date FROM messages_cache
          WHERE chat_id = $id AND message_id < $low ORDER BY message_id DESC LIMIT 1), 0)
        AND start_date <= COALESCE((SELECT date FROM messages_cache
          WHERE chat_id = $id AND message_id > $high ORDER BY message_id LIMIT 1), start_date)
      LIMIT 1
    `)
    .get({ $id: chatId, $low: low, $high: high });
  return row !== null;
}

function newestGap(
  cacheDb: Database,
  chatId: number,
  span: { low: number; high: number },
  top: number | null,
) {
  const ranges = createHistoryRanges(cacheDb);
  const holding = ranges.find(chatId, span.high);
  if (holding && holding.low <= span.low) return null;

  const high = holding ? holding.low - 1 : span.high;
  const low = Math.max(span.low, (ranges.below(chatId, high)?.high ?? 0) + 1);
  return {
    low,
    high,
    before: top !== null && high < top ? high + 1 : null,
    fillable:
      createGroupParticipation(cacheDb).captures(chatId) &&
      !sentDuringCaptureGap(cacheDb, chatId, low, high),
  } satisfies HistoryGap;
}

function historyPage(
  cacheDb: Database,
  chatId: number,
  window: HistoryWindow,
  rows: MessageRow[],
  source: "cache" | "api",
) {
  const ids = rows.map((row) => row.message_id);
  const result: ListHistoryResult = {
    chatId,
    items: messageRowsToItems(cacheDb, rows),
    limit: window.limit,
    before: window.before ?? null,
    after: window.after ?? null,
    nextBefore: ids.length > 0 ? Math.min(...ids) : null,
    nextAfter: ids.length > 0 ? Math.max(...ids) : null,
    source,
    stale: false,
  };
  return result;
}

/**
 * A filtered page from the cache alone, with what it vouches for. The rows,
 * the ranges, the chat's newest known message and the type state are read
 * in one read transaction, so a sync writing meanwhile can't make a page
 * look complete that its rows don't match.
 */
export function readFilteredPage(
  cacheDb: Database,
  chatId: number,
  window: HistoryWindow,
  includeDeleted: boolean,
  filter: MessageFilter,
) {
  return cacheDb.transaction(() => {
    const history = createMessagesHistory(cacheDb);
    const rows = history.list(chatId, { ...window, includeDeleted, filter });
    const ids = rows.map((row) => row.message_id);
    const top = createHistoryRanges(cacheDb).knownTop(chatId);
    const bounds = pageSpan(window, ids, top);
    const span = vouchedSpan(cacheDb, chatId, filter, bounds);
    const gap = span && newestGap(cacheDb, chatId, span, top);
    const migrating =
      filter.types !== undefined && isMigrationPending(cacheDb, MESSAGE_TYPES_MIGRATION);
    const newestAwaitingRaw =
      filter.types !== undefined
        ? history.newestUntyped(chatId, bounds.low, bounds.high, { ...filter, includeDeleted })
        : null;
    const untyped =
      migrating || newestAwaitingRaw !== null ? { migrating, newestAwaitingRaw } : null;

    const missing: MissingPart[] = [];
    if (gap) missing.push("history");
    if (untyped) missing.push("types");
    return {
      page: {
        ...historyPage(cacheDb, chatId, window, rows, "cache"),
        complete: missing.length === 0,
        missing,
        missingBefore: gap?.before ?? null,
      },
      gap,
      untyped,
    } satisfies FilteredPage;
  })();
}

/**
 * One page of a chat, newest first. The cache answers when it holds the
 * whole window without a gap; otherwise, or with `fresh`, Telegram does.
 * With a filter only the cache answers (readFilteredPage).
 */
export async function listHistory(options: ListHistoryOptions) {
  const { cacheDb, chat, window, filter } = options;
  if (filter) {
    return readFilteredPage(cacheDb, chat.chatId, window, options.includeDeleted, filter).page;
  }
  const { rows, source } = await readHistoryPage(options);
  return historyPage(cacheDb, chat.chatId, window, rows, source);
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
  };
}

export interface MessageAround {
  message: MessageSearchRow;
  /** Up to `context` newer messages, newest first */
  newer: MessageSearchRow[];
  /** Up to `context` older messages, newest first */
  older: MessageSearchRow[];
}

function closest(ids: number[], to: number, side: 1 | -1, count: number) {
  return ids
    .filter((id) => side * (id - to) > 0)
    .sort((a, b) => side * (a - b))
    .slice(0, count);
}

/**
 * Fetch a message and `context` messages on each side from Telegram and
 * cache them. Their rows come back in the cache's row shape.
 */
export async function fetchMessageAround(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  messageId: number,
  context: number,
) {
  const { messages, users } = await callHistory(client, chat, aroundRequest(messageId, context));
  const ids = messages.map(rawMessageId);
  if (!ids.includes(messageId)) {
    throw new MessageNotFoundError(chat.chatId, messageId);
  }

  const older = closest(ids, messageId, -1, context);
  const keep = new Set([messageId, ...closest(ids, messageId, 1, context), ...older]);
  const page = messages.filter((message) => keep.has(rawMessageId(message)));
  const rows = cacheHistoryResponse(cacheDb, chat.chatId, page, users, {
    reachedStart: older.length < context,
  });

  const message = rows.find((row) => row.message_id === messageId);
  if (!message) {
    throw new MessageNotFoundError(chat.chatId, messageId);
  }
  const result: MessageAround = {
    message,
    newer: rows.filter((row) => row.message_id > messageId),
    older: rows.filter((row) => row.message_id < messageId),
  };
  return result;
}

export interface GetMessageOptions {
  cacheDb: Database;
  client: CallClient;
  chat: HistoryChat;
  messageId: number;
  /** Messages on each side of the target */
  context: number;
  includeDeleted: boolean;
  fresh: boolean;
}

export interface GetMessageResult {
  chatId: number;
  message: MessageSearchItem;
  /** Newest first, so `[...newer, message, ...older]` reads like a list page */
  newer: MessageSearchItem[];
  /** Newest first */
  older: MessageSearchItem[];
  source: "cache" | "api";
  stale: false;
}

function readAroundFromCache(
  cacheDb: Database,
  chatId: number,
  messageId: number,
  context: number,
  includeDeleted: boolean,
) {
  const history = createMessagesHistory(cacheDb);
  const message = history.get(chatId, messageId);
  if (!message) return null;
  if (context === 0) {
    return { around: { message, newer: [], older: [] }, complete: true };
  }

  const side = (bound: "after" | "before") =>
    readCachedWindow(cacheDb, chatId, { limit: context, [bound]: messageId }, includeDeleted);
  const newer = side("after");
  const older = side("before");
  return {
    around: { message, newer: newer.rows, older: older.rows },
    complete: message.is_deleted === 1 || (newer.whole && older.whole),
  };
}

async function readAround(options: GetMessageOptions) {
  const { cacheDb, client, chat, messageId, context } = options;
  const cached = options.fresh
    ? null
    : readAroundFromCache(cacheDb, chat.chatId, messageId, context, options.includeDeleted);
  if (cached?.complete) {
    return { around: cached.around, source: "cache" as const };
  }

  try {
    const around = await fetchMessageAround(client, cacheDb, chat, messageId, context);
    return { around, source: "api" as const };
  } catch (err) {
    if (cached) {
      verbose(`Serving message ${messageId} from the cache: ${getErrorMessage(err)}`);
      return { around: cached.around, source: "cache" as const };
    }
    throw err;
  }
}

/**
 * One message with up to `context` messages on each side. The cache answers
 * when it holds the message and both sides whole; otherwise, or with
 * `fresh`, one Telegram call fetches the message with both sides. If that
 * call fails and the message is cached, the cache answers with what it
 * holds of the sides; `fresh` reports the failure.
 */
export async function getMessageWithContext(options: GetMessageOptions) {
  const { around, source } = await readAround(options);
  const toItem = messageItemReader(options.cacheDb);

  const result: GetMessageResult = {
    chatId: options.chat.chatId,
    message: toItem(around.message),
    newer: around.newer.map(toItem),
    older: around.older.map(toItem),
    source,
    stale: false,
  };
  return result;
}
