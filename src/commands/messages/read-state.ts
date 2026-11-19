import type { Database } from "bun:sqlite";
import type { TelegramClient, tl } from "@mtcute/bun";

import { createChatsCache } from "../../db/chats-cache";
import { createMessagesHistory } from "../../db/messages-history";
import type { MessageSearchItem } from "../../types";
import { messageRowsToItems } from "./helpers";
import { fetchHistoryPage, type HistoryChat, withPeerHint } from "./history";

type CallClient = Pick<TelegramClient, "call">;

export interface UnreadState {
  /** Unread incoming messages, as Telegram counts them */
  unreadCount: number;
  /** Every incoming message up to this ID is read */
  readInboxMaxId: number;
}

/** The chat as message items print it */
export interface UnreadChatInfo {
  id: number;
  title: string | null;
  username: string | null;
  type: string | null;
}

async function call<T>(promise: Promise<T>) {
  try {
    return await promise;
  } catch (err) {
    throw withPeerHint(err);
  }
}

/**
 * The chat's unread state from its dialog on Telegram, written to its
 * chats_cache row (a chat without a row keeps none)
 */
export async function fetchUnreadState(client: CallClient, cacheDb: Database, chat: HistoryChat) {
  const result = await call(
    client.call({
      _: "messages.getPeerDialogs",
      peers: [{ _: "inputDialogPeer", peer: chat.inputPeer }],
    }),
  );
  const dialog = result.dialogs.find((item): item is tl.RawDialog => item._ === "dialog");
  if (!dialog) {
    throw new Error(`Telegram returned no dialog for chat ${chat.chatId}`);
  }
  createChatsCache(cacheDb).setReadInbox(
    String(chat.chatId),
    dialog.readInboxMaxId,
    dialog.unreadCount,
  );
  return {
    unreadCount: dialog.unreadCount,
    readInboxMaxId: dialog.readInboxMaxId,
  };
}

/**
 * The request that marks a chat read up to `maxId` (0: everything):
 * channels.readHistory for a channel or supergroup, messages.readHistory
 * for a private chat, a basic group or Saved Messages
 */
export function readHistoryRequest(inputPeer: tl.TypeInputPeer, maxId: number) {
  switch (inputPeer._) {
    case "inputPeerChannel": {
      const result: tl.messages.RawReadHistoryRequest | tl.channels.RawReadHistoryRequest = {
        _: "channels.readHistory",
        channel: {
          _: "inputChannel",
          channelId: inputPeer.channelId,
          accessHash: inputPeer.accessHash,
        },
        maxId,
      };
      return result;
    }
    case "inputPeerChannelFromMessage": {
      const result: tl.messages.RawReadHistoryRequest | tl.channels.RawReadHistoryRequest = {
        _: "channels.readHistory",
        channel: {
          _: "inputChannelFromMessage",
          peer: inputPeer.peer,
          msgId: inputPeer.msgId,
          channelId: inputPeer.channelId,
        },
        maxId,
      };
      return result;
    }
    default: {
      const result: tl.messages.RawReadHistoryRequest | tl.channels.RawReadHistoryRequest = {
        _: "messages.readHistory",
        peer: inputPeer,
        maxId,
      };
      return result;
    }
  }
}

export interface MarkReadResult extends UnreadState {
  chatId: number;
  /** The --max-id passed, null for everything */
  maxId: number | null;
  method: "messages.readHistory" | "channels.readHistory";
}

/**
 * Mark the chat's incoming messages read up to `maxId` (null: all of them),
 * then read the chat's new unread state back from Telegram into the cache
 */
export async function markRead(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  maxId: number | null,
) {
  const request = readHistoryRequest(chat.inputPeer, maxId ?? 0);
  await call(client.call(request));
  const state = await fetchUnreadState(client, cacheDb, chat);
  const result: MarkReadResult = { chatId: chat.chatId, maxId, method: request._, ...state };
  return result;
}

export interface UnreadChat extends UnreadState {
  chat: UnreadChatInfo;
  /** Unread messages the cache doesn't hold */
  missing: number;
  returned: number;
  /** Pass as `tg messages read --max-id`, or `tg messages list --after` for the next ones */
  nextAfter: number | null;
  /** The oldest unread messages, at most `limit`, newest first */
  items: MessageSearchItem[];
  source: "cache" | "api";
}

export interface UnreadTarget {
  chat: UnreadChatInfo;
  state: UnreadState;
  /** The chat for a Telegram call, resolved only when one is needed */
  resolve: () => Promise<HistoryChat>;
}

/**
 * The oldest `limit` unread messages of a chat the cache holds: incoming
 * ones above the read boundary, deleted ones left out. With `fresh`, a chat
 * whose cache lacks some of them gets the first `limit` messages above the
 * boundary from Telegram, cached, first.
 */
export async function readUnreadChat(
  cacheDb: Database,
  client: CallClient,
  target: UnreadTarget,
  limit: number,
  fresh: boolean,
) {
  const history = createMessagesHistory(cacheDb);
  const { chat, state } = target;
  const boundary = state.readInboxMaxId;
  const missing = () =>
    Math.max(0, state.unreadCount - history.countIncomingAfter(chat.id, boundary));

  let source: UnreadChat["source"] = "cache";
  if (fresh && missing() > 0) {
    await fetchHistoryPage(client, cacheDb, await target.resolve(), {
      limit,
      after: boundary,
    });
    source = "api";
  }

  const rows = history.list(chat.id, {
    limit,
    after: boundary,
    incomingOnly: true,
  });
  const ids = rows.map((row) => row.message_id);
  return {
    chat,
    ...state,
    missing: missing(),
    returned: rows.length,
    nextAfter: ids.length > 0 ? Math.max(...ids) : null,
    items: messageRowsToItems(cacheDb, rows),
    source,
  };
}

export interface UnreadResult {
  chats: UnreadChat[];
  unreadCount: number;
  missing: number;
  returned: number;
  limit: number;
  source: "cache" | "api";
  stale: false;
}

/** The unread messages of each chat, one chat after another */
export async function readUnread(
  cacheDb: Database,
  client: CallClient,
  targets: UnreadTarget[],
  limit: number,
  fresh: boolean,
) {
  const chats: UnreadChat[] = [];
  for (const target of targets) {
    chats.push(await readUnreadChat(cacheDb, client, target, limit, fresh));
  }
  const sum = (key: "unreadCount" | "missing" | "returned") =>
    chats.reduce((total, chat) => total + chat[key], 0);
  const result: UnreadResult = {
    chats,
    unreadCount: sum("unreadCount"),
    missing: sum("missing"),
    returned: sum("returned"),
    limit,
    source: chats.some((chat) => chat.source === "api") ? "api" : "cache",
    stale: false,
  };
  return result;
}
