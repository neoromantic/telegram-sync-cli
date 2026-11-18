import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { TelegramClient, tl } from "@mtcute/bun";

import { dialogToCacheInput } from "../commands/chats/helpers";
import type { HistoryChat } from "../commands/messages/history";
import {
  markRead,
  readHistoryRequest,
  readUnread,
  type UnreadState,
  type UnreadTarget,
} from "../commands/messages/read-state";
import { createUpdateHandlers, readInboxFromUpdate } from "../daemon/handlers";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { type CachedChatInput, createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import { initCacheSchema } from "../db/schema";
import { initSyncSchema } from "../db/sync-schema";
import type { ChatType } from "../db/types";
import { toLong } from "../utils/long";
import { fakeDialog } from "./helpers/fake-dialogs";
import { createFakeHistory, type GetHistoryRequest } from "./helpers/fake-history";
import { takePartIn } from "./helpers/participation";

const ALICE_ID = 10;
const BOOK_CLUB_RAW_ID = 4242;
const BOOK_CLUB_ID = -4242;
const TEAM_RAW_ID = 1234567890;
const TEAM_ID = -1001234567890;
const NEWS_RAW_ID = 2222222222;
const NEWS_ID = -1002222222222;
const SELF_ID = 999;
const DATE = 1_760_000_000;

const PEERS: Record<string, HistoryChat> = {
  private: {
    chatId: ALICE_ID,
    inputPeer: { _: "inputPeerUser", userId: ALICE_ID, accessHash: toLong(7) },
  },
  group: {
    chatId: BOOK_CLUB_ID,
    inputPeer: { _: "inputPeerChat", chatId: BOOK_CLUB_RAW_ID },
  },
  supergroup: {
    chatId: TEAM_ID,
    inputPeer: {
      _: "inputPeerChannel",
      channelId: TEAM_RAW_ID,
      accessHash: toLong(8),
    },
  },
  channel: {
    chatId: NEWS_ID,
    inputPeer: {
      _: "inputPeerChannel",
      channelId: NEWS_RAW_ID,
      accessHash: toLong(9),
    },
  },
};

function createCacheDb(): Database {
  const db = new Database(":memory:");
  initCacheSchema(db);
  initSyncSchema(db);
  return db;
}

function chatInput(
  chatId: number,
  type: ChatType,
  extra: Partial<CachedChatInput> = {},
): CachedChatInput {
  return {
    chat_id: String(chatId),
    type,
    title: `Chat ${chatId}`,
    username: null,
    member_count: null,
    access_hash: null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: "{}",
    ...extra,
  };
}

function cacheMessages(
  db: Database,
  chatId: number,
  ids: number[],
  extra: { outgoing?: number[]; deleted?: number[] } = {},
) {
  takePartIn(db, BOOK_CLUB_ID, TEAM_ID, NEWS_ID);
  const messages = createMessagesCache(db);
  messages.upsertBatch(
    ids.map((id) => ({
      chat_id: chatId,
      message_id: id,
      text: `msg ${id}`,
      message_type: "text",
      date: DATE + id,
      is_outgoing: extra.outgoing?.includes(id) ?? false,
      raw_json: "{}",
    })),
  );
  if (extra.deleted) messages.markDeleted(chatId, extra.deleted);
}

function createReadClient(topMessage: number, unreadAbove: (n: number) => number) {
  const requests: Array<{ _: string } & Record<string, unknown>> = [];
  let readMaxId: number | null = null;
  const call = async (request: { _: string } & Record<string, unknown>) => {
    requests.push(request);
    switch (request._) {
      case "messages.readHistory":
      case "channels.readHistory":
        readMaxId = request.maxId as number;
        return request._ === "channels.readHistory"
          ? true
          : { _: "messages.affectedMessages", pts: 1, ptsCount: 1 };
      case "messages.getPeerDialogs": {
        const boundary = readMaxId === 0 ? topMessage : (readMaxId ?? 0);
        return {
          _: "messages.peerDialogs",
          dialogs: [
            {
              _: "dialog",
              peer: { _: "peerUser", userId: ALICE_ID },
              topMessage,
              readInboxMaxId: boundary,
              unreadCount: unreadAbove(boundary),
            },
          ],
          messages: [],
          chats: [],
          users: [],
        };
      }
      default:
        throw new Error(`unexpected ${request._}`);
    }
  };
  return { client: { call } as unknown as TelegramClient, requests };
}

describe("readHistoryRequest", () => {
  it.each([
    ["private", "messages.readHistory"],
    ["group", "messages.readHistory"],
    ["supergroup", "channels.readHistory"],
    ["channel", "channels.readHistory"],
  ] as const)("marks a %s read with %s", (type, method) => {
    const peer = PEERS[type] as HistoryChat;
    const request = readHistoryRequest(peer.inputPeer, 42);
    expect(request._).toBe(method);
    expect(request.maxId).toBe(42);
  });

  it("reads Saved Messages with messages.readHistory", () => {
    expect(readHistoryRequest({ _: "inputPeerSelf" }, 0)).toEqual({
      _: "messages.readHistory",
      peer: { _: "inputPeerSelf" },
      maxId: 0,
    });
  });

  it("passes a channel with its access hash, or the message it was seen in", () => {
    expect(readHistoryRequest(PEERS.channel?.inputPeer as tl.TypeInputPeer, 0)).toEqual({
      _: "channels.readHistory",
      channel: {
        _: "inputChannel",
        channelId: NEWS_RAW_ID,
        accessHash: toLong(9),
      },
      maxId: 0,
    });

    const fromMessage: tl.TypeInputPeer = {
      _: "inputPeerChannelFromMessage",
      peer: { _: "inputPeerUser", userId: ALICE_ID, accessHash: toLong(7) },
      msgId: 5,
      channelId: NEWS_RAW_ID,
    };
    expect(readHistoryRequest(fromMessage, 7)).toEqual({
      _: "channels.readHistory",
      channel: {
        _: "inputChannelFromMessage",
        peer: { _: "inputPeerUser", userId: ALICE_ID, accessHash: toLong(7) },
        msgId: 5,
        channelId: NEWS_RAW_ID,
      },
      maxId: 7,
    });
  });
});

describe("markRead", () => {
  let db: Database;

  beforeEach(() => {
    db = createCacheDb();
  });

  it.each([
    ["private", "messages.readHistory"],
    ["group", "messages.readHistory"],
    ["supergroup", "channels.readHistory"],
    ["channel", "channels.readHistory"],
  ] as const)("marks a whole %s read with %s and max_id 0", async (type, method) => {
    const peer = PEERS[type] as HistoryChat;
    createChatsCache(db).upsert(
      chatInput(peer.chatId, type, {
        unread_count: 5,
        read_inbox_max_id: 15,
      }),
    );
    const { client, requests } = createReadClient(20, () => 0);

    const result = await markRead(client, db, peer, null);

    expect(requests.map((request) => request._)).toEqual([method, "messages.getPeerDialogs"]);
    expect(requests[0]?.maxId).toBe(0);
    expect(requests[1]?.peers).toEqual([{ _: "inputDialogPeer", peer: peer.inputPeer }]);
    expect(result).toEqual({
      chatId: peer.chatId,
      maxId: null,
      method,
      unreadCount: 0,
      readInboxMaxId: 20,
    });
    expect(createChatsCache(db).getById(String(peer.chatId))).toMatchObject({
      unread_count: 0,
      read_inbox_max_id: 20,
    });
  });

  it("marks read up to --max-id and keeps the count Telegram reports", async () => {
    const peer = PEERS.supergroup as HistoryChat;
    createChatsCache(db).upsert(
      chatInput(TEAM_ID, "supergroup", {
        unread_count: 5,
        read_inbox_max_id: 15,
      }),
    );
    const { client, requests } = createReadClient(20, (n) => 20 - n);

    const result = await markRead(client, db, peer, 18);

    expect(requests[0]).toMatchObject({ _: "channels.readHistory", maxId: 18 });
    expect(result).toMatchObject({
      maxId: 18,
      unreadCount: 2,
      readInboxMaxId: 18,
    });
    expect(createChatsCache(db).getById(String(TEAM_ID))).toMatchObject({
      unread_count: 2,
      read_inbox_max_id: 18,
    });
  });
});

describe("readUnread", () => {
  let db: Database;

  beforeEach(() => {
    db = createCacheDb();
  });

  function target(chat: HistoryChat, state: UnreadState): UnreadTarget {
    return {
      chat: { id: chat.chatId, title: null, username: null, type: null },
      state,
      resolve: async () => chat,
    };
  }

  const noClient = {
    call: async () => {
      throw new Error("no Telegram call expected");
    },
  } as unknown as TelegramClient;

  it("returns the oldest unread incoming messages the cache holds, newest first", async () => {
    const alice = PEERS.private as HistoryChat;
    cacheMessages(db, ALICE_ID, [8, 9, 10, 11, 12, 13, 14], {
      outgoing: [11],
      deleted: [12],
    });

    const result = await readUnread(
      db,
      noClient,
      [target(alice, { unreadCount: 4, readInboxMaxId: 9 })],
      3,
      false,
    );

    const [chat] = result.chats;
    expect(chat?.items.map((item) => item.messageId)).toEqual([14, 13, 10]);
    expect(chat).toMatchObject({
      unreadCount: 4,
      readInboxMaxId: 9,
      missing: 1,
      returned: 3,
      nextAfter: 14,
      source: "cache",
    });
    expect(result).toMatchObject({
      unreadCount: 4,
      missing: 1,
      returned: 3,
      limit: 3,
      source: "cache",
      stale: false,
    });
  });

  it("says how many unread messages the cache lacks, without asking Telegram", async () => {
    const news = PEERS.channel as HistoryChat;
    cacheMessages(db, NEWS_ID, [120]);

    const result = await readUnread(
      db,
      noClient,
      [target(news, { unreadCount: 20, readInboxMaxId: 100 })],
      5,
      false,
    );

    expect(result.chats[0]).toMatchObject({ returned: 1, missing: 19 });
  });

  it("with fresh, fetches the first unread page of a chat that lacks some", async () => {
    const news = PEERS.channel as HistoryChat;
    cacheMessages(db, NEWS_ID, [120]);
    const history = createFakeHistory(Array.from({ length: 30 }, (_, i) => 91 + i));

    const result = await readUnread(
      db,
      history.client,
      [target(news, { unreadCount: 20, readInboxMaxId: 100 })],
      5,
      true,
    );

    const request = history.requests[0] as GetHistoryRequest;
    expect(history.requests).toHaveLength(1);
    expect(request.minId).toBe(100);
    expect(request.limit).toBe(5);
    expect(result.chats[0]?.items.map((item) => item.messageId)).toEqual([105, 104, 103, 102, 101]);
    expect(result.chats[0]).toMatchObject({ missing: 14, source: "api" });
    expect(result.source).toBe("api");
  });

  it("with fresh, leaves a chat whose cache holds every unread message to the cache", async () => {
    const alice = PEERS.private as HistoryChat;
    cacheMessages(db, ALICE_ID, [10, 11]);

    const result = await readUnread(
      db,
      noClient,
      [target(alice, { unreadCount: 2, readInboxMaxId: 9 })],
      20,
      true,
    );

    expect(result.chats[0]).toMatchObject({ missing: 0, source: "cache" });
  });
});

describe("chats_cache unread state", () => {
  let db: Database;
  let chats: ReturnType<typeof createChatsCache>;

  beforeEach(() => {
    db = createCacheDb();
    chats = createChatsCache(db);
  });

  it("takes the state from a dialog and keeps it on other writes", () => {
    chats.upsert(
      dialogToCacheInput(
        fakeDialog({
          kind: "user",
          id: ALICE_ID,
          topMessage: 14,
          unreadCount: 3,
          readInboxMaxId: 11,
        }),
      ),
    );
    chats.upsert(chatInput(ALICE_ID, "private", { title: "Alice" }));

    expect(chats.getById(String(ALICE_ID))).toMatchObject({
      title: "Alice",
      unread_count: 3,
      read_inbox_max_id: 11,
    });
  });

  it("lists only chats with unread messages, newest first", () => {
    chats.upsertMany([
      chatInput(ALICE_ID, "private", { unread_count: 2, last_message_at: 3 }),
      chatInput(TEAM_ID, "supergroup", { unread_count: 0, last_message_at: 2 }),
      chatInput(NEWS_ID, "channel", { unread_count: 7, last_message_at: 4 }),
      chatInput(BOOK_CLUB_ID, "group", { last_message_at: 5 }),
    ]);

    expect(chats.list({ unread: true }).map((chat) => chat.chat_id)).toEqual([
      String(NEWS_ID),
      String(ALICE_ID),
    ]);
    expect(chats.list({ unread: true, type: "private" }).map((chat) => chat.chat_id)).toEqual([
      String(ALICE_ID),
    ]);
    expect(chats.hasUnreadState()).toBe(true);
  });

  it("has no unread state before a dialog list", () => {
    chats.upsert(chatInput(ALICE_ID, "private"));
    expect(chats.hasUnreadState()).toBe(false);
  });
});

describe("daemon updates keep the unread state current", () => {
  let db: Database;
  let chats: ReturnType<typeof createChatsCache>;
  let handlers: ReturnType<typeof createUpdateHandlers>;
  const ctx = { accountId: 1, receivedAt: 0 };

  beforeEach(() => {
    db = createCacheDb();
    chats = createChatsCache(db);
    handlers = createUpdateHandlers({
      db,
      messagesCache: createMessagesCache(db),
      chatSyncState: createChatSyncStateService(db),
      chatsCache: chats,
    });
  });

  function receive(messageId: number, isOutgoing = false) {
    return handlers.handleNewMessage(ctx, {
      chatId: ALICE_ID,
      chatType: "private",
      messageId,
      text: "hi",
      date: DATE + messageId,
      isOutgoing,
      rawMessage: { _: "message", id: messageId },
      rawChat: {
        _: "user",
        id: ALICE_ID,
        accessHash: toLong(7),
        firstName: "Alice",
      } as tl.RawUser,
    });
  }

  it("counts each new incoming message once, and no outgoing one", async () => {
    chats.upsert(
      chatInput(ALICE_ID, "private", {
        unread_count: 1,
        read_inbox_max_id: 9,
        last_message_id: 10,
      }),
    );

    await receive(11);
    await receive(11);
    await receive(12, true);
    await receive(13);

    expect(chats.getById(String(ALICE_ID))).toMatchObject({
      unread_count: 3,
      read_inbox_max_id: 9,
      last_message_id: 13,
      last_message_at: (DATE + 13) * 1000,
    });
  });

  it("leaves an unknown count unknown", async () => {
    chats.upsert(chatInput(ALICE_ID, "private"));
    await receive(11);
    expect(chats.getById(String(ALICE_ID))?.unread_count).toBeNull();
  });

  it("starts a chat new to the cache with its first message unread", async () => {
    await receive(50);
    await receive(51);
    expect(chats.getById(String(ALICE_ID))).toMatchObject({
      unread_count: 2,
      read_inbox_max_id: 49,
    });
  });

  it("takes a read on another device from its update", async () => {
    chats.upsert(
      chatInput(TEAM_ID, "supergroup", {
        unread_count: 9,
        read_inbox_max_id: 1,
      }),
    );
    const read = readInboxFromUpdate({
      _: "updateReadChannelInbox",
      channelId: TEAM_RAW_ID,
      maxId: 40,
      stillUnreadCount: 2,
      pts: 1,
    });
    expect(read).toEqual({ chatId: TEAM_ID, maxId: 40, stillUnreadCount: 2 });

    await handlers.handleReadInbox(ctx, read as NonNullable<typeof read>);

    expect(chats.getById(String(TEAM_ID))).toMatchObject({
      unread_count: 2,
      read_inbox_max_id: 40,
    });
  });

  it("reads private chats and basic groups from updateReadHistoryInbox", () => {
    const update = (peer: tl.TypePeer, topMsgId?: number) =>
      readInboxFromUpdate({
        _: "updateReadHistoryInbox",
        peer,
        topMsgId,
        maxId: 7,
        stillUnreadCount: 0,
        pts: 1,
        ptsCount: 1,
      });

    expect(update({ _: "peerUser", userId: SELF_ID })?.chatId).toBe(SELF_ID);
    expect(update({ _: "peerChat", chatId: BOOK_CLUB_RAW_ID })?.chatId).toBe(BOOK_CLUB_ID);
    expect(update({ _: "peerUser", userId: ALICE_ID }, 3)).toBeNull();
    expect(readInboxFromUpdate({ _: "updateConfig" })).toBeNull();
  });
});
