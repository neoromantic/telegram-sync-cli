import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { TelegramClient, tl } from "@mtcute/bun";

import { dialogToCacheInput } from "../chats/helpers";
import type { HistoryChat } from "./history";
import { markRead, readHistoryRequest, readUnread, type UnreadState } from "./read-state";
import { createUpdateHandlers, readInboxFromUpdate } from "../../daemon/handlers";
import { createChatSyncStateService } from "../../db/chat-sync-state";
import { createChatsCache } from "../../db/chats-cache";
import { createMessagesCache } from "../../db/messages-cache";
import { toLong } from "../../utils/long";
import { chatRow, createAccountCacheDb } from "../../test/cache-db.test-utils";
import { fakeDialog } from "../../test/fake-dialogs.test-utils";
import { createFakeHistory, type GetHistoryRequest } from "../../test/fake-history.test-utils";
import { takePartIn } from "../../test/participation.test-utils";

const ALICE_ID = 10;
const BOOK_CLUB_RAW_ID = 4242;
const BOOK_CLUB_ID = -4242;
const TEAM_RAW_ID = 1234567890;
const TEAM_ID = -1001234567890;
const NEWS_RAW_ID = 2222222222;
const NEWS_ID = -1002222222222;
const SELF_ID = 999;
const DATE = 1_760_000_000;

const ALICE: HistoryChat = {
  chatId: ALICE_ID,
  inputPeer: { _: "inputPeerUser", userId: ALICE_ID, accessHash: toLong(7) },
};
const NEWS: HistoryChat = {
  chatId: NEWS_ID,
  inputPeer: {
    _: "inputPeerChannel",
    channelId: NEWS_RAW_ID,
    accessHash: toLong(9),
  },
};

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

describe("readHistoryRequest", () => {
  it("passes a channel with its access hash or the message it was seen in, Saved Messages as a peer", () => {
    expect(readHistoryRequest(NEWS.inputPeer, 0)).toEqual({
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

    expect(readHistoryRequest({ _: "inputPeerSelf" }, 0)).toEqual({
      _: "messages.readHistory",
      peer: { _: "inputPeerSelf" },
      maxId: 0,
    });
  });
});

describe("markRead", () => {
  it("reads the chat's dialog back from Telegram after marking it read", async () => {
    const requests: Array<{ _: string } & Record<string, unknown>> = [];
    const call = async (request: { _: string } & Record<string, unknown>) => {
      requests.push(request);
      if (request._ === "channels.readHistory") return true;
      return {
        _: "messages.peerDialogs",
        dialogs: [
          {
            _: "dialog",
            peer: { _: "peerChannel", channelId: NEWS_RAW_ID },
            topMessage: 20,
            readInboxMaxId: 20,
            unreadCount: 0,
          },
        ],
        messages: [],
        chats: [],
        users: [],
      };
    };

    await markRead({ call } as unknown as TelegramClient, createAccountCacheDb(), NEWS, null);

    expect(requests.map((request) => request._)).toEqual([
      "channels.readHistory",
      "messages.getPeerDialogs",
    ]);
    expect(requests[1]).toEqual({
      _: "messages.getPeerDialogs",
      peers: [{ _: "inputDialogPeer", peer: NEWS.inputPeer }],
    });
  });
});

describe("readUnread", () => {
  let db: Database;

  beforeEach(() => {
    db = createAccountCacheDb();
  });

  function target(chat: HistoryChat, state: UnreadState) {
    return {
      chat: { id: chat.chatId, title: null, username: null, type: null },
      state,
      resolve: async () => chat,
    };
  }

  it("leaves deleted and outgoing messages out of the items and the count", async () => {
    cacheMessages(db, ALICE_ID, [8, 9, 10, 11, 12, 13, 14], {
      outgoing: [11],
      deleted: [12],
    });
    const noClient = {
      call: async () => {
        throw new Error("no Telegram call expected");
      },
    } as unknown as TelegramClient;

    const result = await readUnread(
      db,
      noClient,
      [target(ALICE, { unreadCount: 4, readInboxMaxId: 9 })],
      3,
      false,
    );

    const [chat] = result.chats;
    expect(chat?.items.map((item) => item.messageId)).toEqual([14, 13, 10]);
    expect(chat).toMatchObject({ missing: 1, returned: 3 });
  });

  it("with fresh, fetches the first unread page only for a chat whose cache lacks some", async () => {
    cacheMessages(db, NEWS_ID, [120]);
    cacheMessages(db, ALICE_ID, [10, 11]);
    const history = createFakeHistory(Array.from({ length: 30 }, (_, i) => 91 + i));

    const result = await readUnread(
      db,
      history.client,
      [
        target(NEWS, { unreadCount: 20, readInboxMaxId: 100 }),
        target(ALICE, { unreadCount: 2, readInboxMaxId: 9 }),
      ],
      5,
      true,
    );

    const request = history.requests[0] as GetHistoryRequest;
    expect(history.requests).toHaveLength(1);
    expect(request.minId).toBe(100);
    expect(request.limit).toBe(5);
    expect(result.chats.map((chat) => chat.items.map((item) => item.messageId))).toEqual([
      [105, 104, 103, 102, 101],
      [11, 10],
    ]);
    expect(result.chats.map((chat) => [chat.missing, chat.source])).toEqual([
      [14, "api"],
      [0, "cache"],
    ]);
    expect(result.source).toBe("api");
  });
});

describe("chats_cache unread state", () => {
  it("takes the state only from a dialog and keeps it on other writes", () => {
    const chats = createChatsCache(createAccountCacheDb());
    chats.upsert(chatRow(ALICE_ID, "private"));
    expect(chats.hasUnreadState()).toBe(false);

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
    chats.upsert(chatRow(ALICE_ID, "private", { title: "Alice" }));

    expect(chats.getById(String(ALICE_ID))).toMatchObject({
      title: "Alice",
      unread_count: 3,
      read_inbox_max_id: 11,
    });
  });
});

describe("daemon updates keep the unread state current", () => {
  let db: Database;
  let chats: ReturnType<typeof createChatsCache>;
  let handlers: ReturnType<typeof createUpdateHandlers>;
  const ctx = { accountId: 1, receivedAt: 0 };

  beforeEach(() => {
    db = createAccountCacheDb();
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
      chatRow(ALICE_ID, "private", {
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
    chats.upsert(chatRow(ALICE_ID, "private"));
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
      chatRow(TEAM_ID, "supergroup", {
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
