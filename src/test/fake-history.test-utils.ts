import type { TelegramClient, tl } from "@mtcute/bun";
import { toPeerIdFromInputPeer } from "../utils/telegram-peer-ids";

export interface GetHistoryRequest {
  _: string;
  peer?: tl.TypeInputPeer;
  offsetId: number;
  addOffset: number;
  limit: number;
  minId: number;
  maxId: number;
}

export function rawMessage(id: number) {
  return { _: "message", id, date: 1_700_000_000 + id, message: `msg ${id}` };
}

export function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** The messages.getHistory answer for a chat that holds these message IDs */
export function historyPage(ids: Iterable<number>, request: GetHistoryRequest) {
  const { offsetId, addOffset, limit, minId, maxId } = request;

  const newestFirst = [...ids]
    .filter((id) => (!minId || id > minId) && (!maxId || id < maxId))
    .sort((a, b) => b - a);

  const olderIndex = newestFirst.findIndex((id) => id < offsetId);
  const start = offsetId > 0 ? (olderIndex === -1 ? newestFirst.length : olderIndex) : 0;
  const from = Math.max(0, start + addOffset);
  const to = Math.max(0, start + addOffset + limit);

  return {
    _: "messages.messagesSlice",
    count: newestFirst.length,
    messages: newestFirst.slice(from, to).map(rawMessage),
  };
}

/**
 * One chat's history behind a fake client. `onCall` runs before each answer,
 * which waits for it
 */
export function createFakeHistory(initialIds: Iterable<number>, onCall?: () => unknown) {
  const ids = new Set(initialIds);
  const requests: GetHistoryRequest[] = [];

  const call = async (request: GetHistoryRequest) => {
    requests.push(request);
    if (onCall) await onCall();
    return historyPage(ids, request);
  };

  return {
    client: { call } as unknown as TelegramClient,
    requests,
    add(...newIds: number[]) {
      for (const id of newIds) ids.add(id);
    },
  };
}

/**
 * Histories of many chats behind one client. A request goes to the chat
 * whose marked peer ID matches its `peer`; an unknown chat is empty.
 */
export function createMultiChatHistory() {
  const chats = new Map<number, Set<number>>();
  const requestsByChat = new Map<number, GetHistoryRequest[]>();
  let requestCount = 0;

  const call = async (request: GetHistoryRequest) => {
    requestCount++;
    const chatId = request.peer ? (toPeerIdFromInputPeer(request.peer, null) ?? 0) : 0;
    const requests = requestsByChat.get(chatId) ?? [];
    requests.push(request);
    requestsByChat.set(chatId, requests);
    return historyPage(chats.get(chatId) ?? [], request);
  };

  return {
    client: { call } as unknown as TelegramClient,
    set(chatId: number, ids: Iterable<number>) {
      chats.set(chatId, new Set(ids));
    },
    requestsFor(chatId: number) {
      return requestsByChat.get(chatId) ?? [];
    },
    get requestCount() {
      return requestCount;
    },
  };
}
