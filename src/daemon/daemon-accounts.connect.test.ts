import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as mtcute from "@mtcute/bun";
import {
  type DeleteMessageUpdate,
  type Message,
  PeersIndex,
  RawUpdateInfo,
  type TelegramClient,
  type tl,
} from "@mtcute/bun";
import type { DaemonContext } from "./daemon-context";
import { buildInputPeer } from "./sync-worker-real-helpers";
import type { AccountConnectionState } from "./types";
import type { AccountsDbInterface } from "../db";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import type { Account } from "../types";
import { toLong } from "../utils/long";
import { createSeededAccountsDb } from "../test/accounts.test-utils";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { addAccountRuntime, testDaemonContext } from "../test/daemon-runtime.test-utils";
import { takePartIn } from "../test/participation.test-utils";
import { assertPeerIdInvariants } from "../test/peer-id-invariants.test-utils";

type AccountSeed = Pick<Account, "id" | "phone"> & { user_id?: number | null };
type MessageLike = {
  id: number;
  chat: {
    id: number;
    type: string;
    chatType?: string;
    membersCount?: number;
    raw?: tl.TypeUser | tl.TypeChat;
  };
  sender?: { id: number } | null;
  text: string;
  date: Date;
  isOutgoing: boolean;
  media?: { type: string } | null;
  replyToMessage?: { id: number } | null;
  raw?: {
    fwdFrom?: {
      _: string;
      fromId?: {
        _: string;
        userId?: number;
        chatId?: number;
        channelId?: number;
      };
      date?: number;
    };
  };
  editDate?: Date | null;
};
type DeleteMessageUpdateLike = {
  channelId: number | null;
  messageIds: number[];
};

class MockEvent<TArgs extends unknown[]> {
  handlers: Array<(...args: TArgs) => void> = [];
  add = mock((handler: (...args: TArgs) => void) => {
    this.handlers.push(handler);
  });
  remove = mock((handler: (...args: TArgs) => void) => {
    this.handlers = this.handlers.filter((entry) => entry !== handler);
  });
  emit(...args: TArgs) {
    for (const handler of this.handlers) {
      handler(...args);
    }
  }
}

let testCacheDb: Database;

let nextGetMe: {
  id: number;
  firstName: string;
  lastName: string;
  username?: string;
} = { id: 555, firstName: "Test", lastName: "User" };
let startError: Error | null = null;
let updatesLoopError: Error | null = null;

const createdClients: MockTelegramClient[] = [];
const lifecycle: string[] = [];

class MockTelegramClient {
  options: Record<string, unknown>;
  index: number;
  onNewMessage = new MockEvent<[Message]>();
  onEditMessage = new MockEvent<[Message]>();
  onDeleteMessage = new MockEvent<[DeleteMessageUpdate]>();
  onRawUpdate = new MockEvent<[RawUpdateInfo]>();
  onConnectionState = new MockEvent<[string]>();
  onError = new MockEvent<[Error]>();
  log = { mgr: { level: 2, handler: (() => {}) as unknown } };

  start = mock(async (_opts?: Parameters<TelegramClient["start"]>[0]) => {
    lifecycle.push(`start:${this.index}`);
    if (startError) throw startError;
    return {
      id: nextGetMe.id,
      firstName: nextGetMe.firstName,
    } as Awaited<ReturnType<TelegramClient["start"]>>;
  });
  getMe = mock(async () => {
    return nextGetMe as Awaited<ReturnType<TelegramClient["getMe"]>>;
  });
  startUpdatesLoop = mock(async () => {
    if (updatesLoopError) throw updatesLoopError;
  });
  whileDestroying: (() => Promise<void>) | null = null;
  destroy = mock(async () => {
    lifecycle.push(`destroy:${this.index}`);
    await this.whileDestroying?.();
  });

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.index = createdClients.length;
    createdClients.push(this);
  }
}

const createClient = () => new MockTelegramClient({}) as unknown as TelegramClient;

const asMessage = (input: MessageLike) => input as Message;

async function afterHandling(
  accountState: AccountConnectionState,
  method: "handleNewMessage" | "handleDeleteMessages" | "handleDeleteMessagesWithoutChat",
  emit: () => void,
) {
  const handled = spyOn(accountState.updateHandlers!, method);
  try {
    emit();
    expect(handled).toHaveBeenCalledTimes(1);
    await handled.mock.results[0]?.value;
  } finally {
    handled.mockRestore();
  }
}
const asDeleteUpdate = (input: DeleteMessageUpdateLike) => input as DeleteMessageUpdate;

mock.module("@mtcute/bun", () => ({
  ...mtcute,
  TelegramClient: MockTelegramClient,
}));

function createAccountsDb(seed: AccountSeed[]) {
  const accountsDb = createSeededAccountsDb(
    seed.map(({ phone, user_id }) => ({ phone, user_id: user_id ?? undefined })),
  );
  expect(accountsDb.getAll().map((account) => account.id)).toEqual(seed.map((acc) => acc.id));
  return accountsDb;
}

function createContext(accountsDb: AccountsDbInterface) {
  const ctx = testDaemonContext({ accountsDb });
  for (const account of accountsDb.getAll()) {
    addAccountRuntime(ctx, account.id, testCacheDb);
  }
  const result: DaemonContext = ctx;
  return result;
}

describe("daemon-accounts: connection + event wiring", () => {
  beforeEach(() => {
    testCacheDb = createAccountCacheDb();
    takePartIn(testCacheDb, -4242, -5151, -1001234567890);

    nextGetMe = { id: 555, firstName: "Test", lastName: "User" };
    startError = null;
    updatesLoopError = null;
    createdClients.length = 0;
    lifecycle.length = 0;
  });

  afterEach(() => {
    testCacheDb.close();
    delete process.env.TELEGRAM_PROXY;
  });

  it("registers handlers and persists mapped message fields", async () => {
    const accountsDb = createAccountsDb([{ id: 1, phone: "+111", user_id: null }]);
    const ctx = createContext(accountsDb);

    const { setupEventHandlers } = await import("./daemon-accounts");

    const client = createClient();
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+111",
      name: null,
      status: "connected",
      client,
    };

    setupEventHandlers(ctx, accountState);

    const now = new Date("2024-01-01T00:00:00Z");
    const channelId = -1000000001000;
    const message = {
      id: 42,
      chat: { id: channelId, type: "chat", chatType: "channel" },
      sender: { id: 777 },
      text: "Photo message",
      date: now,
      isOutgoing: false,
      media: { type: "photo" },
      replyToMessage: { id: 9 },
      raw: {
        fwdFrom: {
          _: "messageFwdHeader",
          fromId: { _: "peerUser", userId: 333 },
          date: Math.floor(now.getTime() / 1000),
        },
      },
    } satisfies MessageLike;

    accountState.eventHandlers?.onNewMessage(asMessage(message));

    const messagesCache = createMessagesCache(testCacheDb);
    const chatSyncState = createChatSyncStateService(testCacheDb);

    const cached = messagesCache.get(channelId, 42);
    expect(cached).not.toBeNull();
    expect(cached?.message_type).toBe("photo");
    expect(cached?.has_media).toBe(1);
    expect(cached?.reply_to_id).toBe(9);
    expect(cached?.forward_from_id).toBe(333);
    expect(JSON.parse(cached?.raw_json ?? "{}").fwdFrom?.fromId?.userId).toBe(333);

    const state = chatSyncState.get(channelId);
    expect(state?.chat_type).toBe("channel");
    expect(state?.sync_enabled).toBe(0);
    expect(accountState.lastActivity).toBeDefined();
    expect(client.onNewMessage.add).toHaveBeenCalled();
  });

  it("stores a live post of a channel turned off, without moving its cursor (#125)", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+111" }]));
    const { setupEventHandlers } = await import("./daemon-accounts");
    const client = createClient();
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+111",
      name: null,
      status: "connected",
      client,
    };
    setupEventHandlers(ctx, accountState);

    const channelId = -1000000002000;
    const chatSyncState = createChatSyncStateService(testCacheDb);
    chatSyncState.upsert({
      chat_id: channelId,
      chat_type: "channel",
      sync_priority: 3,
      sync_enabled: false,
      forward_cursor: 40,
    });
    chatSyncState.setSyncMode(channelId, "off");

    accountState.eventHandlers?.onNewMessage(
      asMessage({
        id: 50,
        chat: { id: channelId, type: "chat", chatType: "channel" },
        sender: { id: channelId },
        text: "Example post",
        date: new Date("2024-01-01T00:00:00Z"),
        isOutgoing: false,
      }),
    );

    expect(createMessagesCache(testCacheDb).get(channelId, 50)?.text).toBe("Example post");
    expect(chatSyncState.get(channelId)).toMatchObject({
      sync_mode: "off",
      sync_enabled: 0,
      forward_cursor: 40,
    });
  });

  it("stores a live forward from a channel or a group under its marked ID", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+111", user_id: null }]));
    const { setupEventHandlers } = await import("./daemon-accounts");
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+111",
      name: null,
      status: "connected",
      client: createClient(),
    };
    setupEventHandlers(ctx, accountState);

    const forwarded = (
      id: number,
      fromId: NonNullable<NonNullable<MessageLike["raw"]>["fwdFrom"]>["fromId"],
    ) =>
      asMessage({
        id,
        chat: { id: 5550001, type: "user" },
        sender: { id: 5550001 },
        text: "Forwarded",
        date: new Date("2024-01-01T00:00:00Z"),
        isOutgoing: false,
        raw: {
          fwdFrom: { _: "messageFwdHeader", fromId, date: 1_704_067_200 },
        },
      });
    accountState.eventHandlers?.onNewMessage(forwarded(1, { _: "peerChannel", channelId: 333 }));
    accountState.eventHandlers?.onNewMessage(forwarded(2, { _: "peerChat", chatId: 222 }));

    const messagesCache = createMessagesCache(testCacheDb);
    expect(messagesCache.get(5550001, 1)?.forward_from_id).toBe(-1000000000333);
    expect(messagesCache.get(5550001, 2)?.forward_from_id).toBe(-222);
    assertPeerIdInvariants(testCacheDb);
  });

  it("stores the sender a history page stores for a message without fromId (#44)", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+111" }]));
    const { setupEventHandlers } = await import("./daemon-accounts");
    const { cacheHistoryResponse } = await import("../commands/messages/history");
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+111",
      name: null,
      status: "connected",
      client: createClient(),
    };
    setupEventHandlers(ctx, accountState);

    const date = 1_704_067_200;
    const alice: tl.RawUser = {
      _: "user",
      id: 5550001,
      firstName: "Alice",
      accessHash: toLong("1111"),
    };
    const self: tl.RawUser = {
      _: "user",
      id: 5550099,
      self: true,
      firstName: "Me",
      accessHash: toLong("9999"),
    };
    const news: tl.RawChannel = {
      _: "channel",
      id: 1234567890,
      title: "Example News",
      broadcast: true,
      accessHash: toLong("2222"),
      photo: { _: "chatPhotoEmpty" },
      date,
    };
    const bookClub: tl.RawChat = {
      _: "chat",
      id: 4242,
      title: "Book Club",
      photo: { _: "chatPhotoEmpty" },
      participantsCount: 5,
      date,
      version: 1,
    };
    const messages: Array<tl.RawMessage | tl.RawMessageService> = [
      {
        _: "message",
        id: 1,
        peerId: { _: "peerUser", userId: alice.id },
        date,
        message: "incoming",
      },
      {
        _: "message",
        id: 2,
        post: true,
        peerId: { _: "peerChannel", channelId: news.id },
        date,
        message: "channel post",
      },
      {
        _: "message",
        id: 3,
        peerId: { _: "peerUser", userId: self.id },
        date,
        message: "saved",
      },
      {
        _: "message",
        id: 4,
        out: true,
        fromId: { _: "peerUser", userId: self.id },
        peerId: { _: "peerUser", userId: alice.id },
        date,
        message: "outgoing",
      },
      {
        _: "messageService",
        id: 5,
        peerId: { _: "peerChat", chatId: bookClub.id },
        date,
        action: { _: "messageActionChatEditTitle", title: "Book Club" },
      },
    ];
    const peers = mtcute.PeersIndex.from({
      users: [alice, self],
      chats: [news, bookClub],
    });
    const historyDb = createAccountCacheDb();
    takePartIn(historyDb, -4242, -1001234567890);

    const senders = messages.map((raw) => {
      const msg = new mtcute.Message(raw, peers);
      accountState.eventHandlers?.onNewMessage(msg);
      cacheHistoryResponse(historyDb, msg.chat.id, [raw], [alice, self], {});
      const live = createMessagesCache(testCacheDb).get(msg.chat.id, msg.id);
      const history = createMessagesCache(historyDb).get(msg.chat.id, msg.id);
      return [live?.from_id, history?.from_id, msg.sender.id];
    });
    historyDb.close();

    expect(senders).toEqual([
      [5550001, 5550001, 5550001],
      [-1001234567890, -1001234567890, -1001234567890],
      [5550099, 5550099, 5550099],
      [5550099, 5550099, 5550099],
      [-4242, -4242, -4242],
    ]);
  });

  it("passes a live group message member count to the sync policy", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+111" }]));
    const { setupEventHandlers } = await import("./daemon-accounts");
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+111",
      name: null,
      status: "connected",
      client: createClient(),
    };
    setupEventHandlers(ctx, accountState);

    accountState.eventHandlers?.onNewMessage(
      asMessage({
        id: 1,
        chat: { id: -4001, type: "chat", chatType: "group", membersCount: 10 },
        sender: { id: 777 },
        text: "Hi all",
        date: new Date("2024-01-01T00:00:00Z"),
        isOutgoing: false,
      }),
    );

    const state = createChatSyncStateService(testCacheDb).get(-4001);
    expect(state?.member_count).toBe(10);
    expect(state?.sync_enabled).toBe(1);
  });

  it("caches the chat of a live message from a chat no dialog pass listed", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+111" }]));
    const { setupEventHandlers } = await import("./daemon-accounts");
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+111",
      name: null,
      status: "connected",
      client: createClient(),
    };
    setupEventHandlers(ctx, accountState);

    const chatsCache = createChatsCache(testCacheDb);
    expect(chatsCache.getById("5550001")).toBeNull();

    accountState.eventHandlers?.onNewMessage(
      asMessage({
        id: 1,
        chat: {
          id: 5550001,
          type: "user",
          raw: {
            _: "user",
            id: 5550001,
            accessHash: toLong(777),
            firstName: "Alex",
            username: "alex_example",
          } as tl.RawUser,
        },
        sender: { id: 5550001 },
        text: "Hello",
        date: new Date("2024-01-01T00:00:00Z"),
        isOutgoing: false,
      }),
    );

    expect(chatsCache.getById("5550001")).toMatchObject({
      type: "private",
      title: "Alex",
      username: "alex_example",
      access_hash: "777",
    });
    expect(createChatSyncStateService(testCacheDb).get(5550001)?.sync_enabled).toBe(1);
    expect(buildInputPeer(5550001, chatsCache)).toEqual({
      _: "inputPeerUser",
      userId: 5550001,
      accessHash: toLong(777),
    });
  });

  describe("deletes of a message ID that several chats cache", () => {
    async function wireWithMessages(chatIds: number[], messageIds = [7]) {
      const accountsDb = createAccountsDb([{ id: 1, phone: "+15550000001", user_id: 101 }]);
      const ctx = createContext(accountsDb);
      const { setupEventHandlers } = await import("./daemon-accounts");
      const accountState: AccountConnectionState = {
        accountId: 1,
        phone: "+15550000001",
        name: null,
        status: "connected",
        client: createClient(),
      };
      setupEventHandlers(ctx, accountState);

      const messagesCache = createMessagesCache(testCacheDb);
      for (const chatId of chatIds) {
        for (const messageId of messageIds) {
          messagesCache.upsert({
            chat_id: chatId,
            message_id: messageId,
            text: `made-up message ${messageId} in ${chatId}`,
            message_type: "text",
            date: 1_760_000_000 + messageId,
            raw_json: "{}",
          });
        }
      }
      return { ctx, accountState, messagesCache };
    }

    it("marks only the channel message on a channel delete", async () => {
      const { accountState, messagesCache } = await wireWithMessages([4242, -1001234567890]);

      await afterHandling(accountState, "handleDeleteMessages", () =>
        accountState.eventHandlers?.onDeleteMessage(
          asDeleteUpdate({ channelId: -1001234567890, messageIds: [7] }),
        ),
      );

      expect(messagesCache.get(-1001234567890, 7)?.is_deleted).toBe(1);
      expect(messagesCache.get(4242, 7)?.is_deleted).toBe(0);
    });

    it("marks the unique ID of a delete and warns about the ambiguous one", async () => {
      const { ctx, accountState, messagesCache } = await wireWithMessages([4242, -5151]);
      messagesCache.upsert({
        chat_id: 4242,
        message_id: 8,
        text: "made-up reply in 4242",
        message_type: "text",
        date: 1_760_000_100,
        raw_json: "{}",
      });

      await afterHandling(accountState, "handleDeleteMessagesWithoutChat", () =>
        accountState.eventHandlers?.onDeleteMessage(
          asDeleteUpdate({ channelId: null, messageIds: [7, 8] }),
        ),
      );

      expect(messagesCache.get(4242, 8)?.is_deleted).toBe(1);
      expect(messagesCache.get(4242, 7)?.is_deleted).toBe(0);
      expect(messagesCache.get(-5151, 7)?.is_deleted).toBe(0);
      const warn = ctx.logger.warn as ReturnType<typeof mock>;
      expect(warn).toHaveBeenCalledTimes(1);
      const [line] = warn.mock.calls[0] as [string];
      expect(line).toStartWith("[Account 1] Left 1 message ID(s)");
      expect(line).toContain("(7 in -5151, 4242)");
    });

    it("lists at most five ambiguous IDs in the warning", async () => {
      const { ctx, accountState, messagesCache } = await wireWithMessages(
        [4242, -5151],
        [1, 2, 3, 4, 5, 6],
      );

      await afterHandling(accountState, "handleDeleteMessagesWithoutChat", () =>
        accountState.eventHandlers?.onDeleteMessage(
          asDeleteUpdate({ channelId: null, messageIds: [1, 2, 3, 4, 5, 6] }),
        ),
      );

      expect(messagesCache.get(4242, 6)?.is_deleted).toBe(0);
      const warn = ctx.logger.warn as ReturnType<typeof mock>;
      expect(warn).toHaveBeenCalledTimes(1);
      const [line] = warn.mock.calls[0] as [string];
      expect(line).toContain("Left 6 message ID(s)");
      expect(line).toContain("5 in -5151, 4242; 1 more)");
      expect(line).not.toContain("6 in");
    });
  });

  it("merges duplicate user_id by keeping real phone account", async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: "user:555", user_id: 555 },
      { id: 2, phone: "+1999", user_id: null },
    ]);
    const ctx = createContext(accountsDb);

    nextGetMe = { id: 555, firstName: "Test", lastName: "User" };

    const { connectAccount } = await import("./daemon-accounts");

    const connected = await connectAccount(ctx, 2, "+1999", null);

    expect(connected).toBe(true);
    expect(accountsDb.getById(1)).toBeNull();
    const account = accountsDb.getById(2);
    expect(account?.user_id).toBe(555);
    expect(createdClients[0]?.startUpdatesLoop).toHaveBeenCalled();
    expect(ctx.runtime.accounts.has(1)).toBe(false);
    expect(ctx.runtime.accounts.has(2)).toBe(true);
  });

  it("daemon clients use the daemon platform", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: 555 }]));
    const { attemptReconnect, connectAccount } = await import("./daemon-accounts");
    const { daemonPlatform } = await import("./daemon-platform");

    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    const accountState = ctx.state.accounts.get(1)!;
    accountState.status = "error";
    expect(await attemptReconnect(ctx, accountState)).toBe(true);

    expect(createdClients).toHaveLength(2);
    for (const client of createdClients) {
      expect(client.options.platform).toBe(daemonPlatform);
    }
  });

  it("uses the proxy transport when connecting an account", async () => {
    process.env.TELEGRAM_PROXY = "socks5://127.0.0.1:1080";
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000000", user_id: null }]));
    const { connectAccount } = await import("./daemon-accounts");
    expect(await connectAccount(ctx, 1, "+15550000000", null)).toBe(true);
    expect(createdClients[0]?.options.transport).toEqual(
      mtcute.proxyTransportFromUrl(process.env.TELEGRAM_PROXY),
    );
  });

  it("merges duplicate user_id by keeping existing real phone account", async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: "+1555", user_id: 555 },
      { id: 2, phone: "user:555", user_id: null },
    ]);
    const ctx = createContext(accountsDb);

    nextGetMe = { id: 555, firstName: "Test", lastName: "User" };

    const { connectAccount } = await import("./daemon-accounts");

    const connected = await connectAccount(ctx, 2, "user:555", null);

    expect(connected).toBe(false);
    expect(accountsDb.getActive()?.id).toBe(1);
    expect(accountsDb.getById(2)).toBeNull();
    expect(ctx.state.accounts.has(2)).toBe(false);
    expect(createdClients[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.runtime.accounts.has(2)).toBe(false);
    expect(ctx.runtime.accounts.has(1)).toBe(true);

    const { disconnectAllAccounts } = await import("./daemon-accounts");
    await disconnectAllAccounts(ctx);
    expect(createdClients[0]?.destroy).toHaveBeenCalledTimes(1);
  });

  it("a connect that fails at start closes its client and logs one line without source or the phone number (#128)", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: null }]));
    const { connectAccount, disconnectAllAccounts } = await import("./daemon-accounts");
    const failure = new Error("Could not connect to DC 2");
    failure.stack = `Error: Could not connect to DC 2\n    at connect (/$bunfs/root/tg:1:2)\n${"x".repeat(500)}`;
    startError = failure;

    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(false);

    const client = createdClients[0]!;
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.state.accounts.get(1)).toMatchObject({
      status: "error",
      lastError: "Could not connect to DC 2",
    });
    expect(ctx.state.accounts.get(1)?.client).toBeUndefined();
    expect((ctx.logger.error as ReturnType<typeof mock>).mock.calls).toEqual([
      ["Failed to connect account #1 (+15*******01): Could not connect to DC 2"],
    ]);

    await disconnectAllAccounts(ctx);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("a connect whose updates loop fails removes the handlers it added and closes its client", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: null }]));
    const { connectAccount } = await import("./daemon-accounts");
    updatesLoopError = new Error("AUTH_KEY_UNREGISTERED");

    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(false);

    const client = createdClients[0]!;
    const accountState = ctx.state.accounts.get(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(client.onNewMessage.handlers).toHaveLength(0);
    expect(accountState?.client).toBeUndefined();
    expect(accountState?.eventHandlers).toBeUndefined();
    expect(accountState).toMatchObject({ status: "error", lastError: "AUTH_KEY_UNREGISTERED" });
  });

  it("names the account by its username, never its phone or name (#128)", async () => {
    nextGetMe = {
      id: 555,
      firstName: "Test",
      lastName: "User",
      username: "example_user",
    };
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: null }]));
    const { connectAccount } = await import("./daemon-accounts");

    expect(await connectAccount(ctx, 1, "+15550000001", "Test User")).toBe(true);

    const lines = Object.values(ctx.logger).flatMap((fn) =>
      (fn as ReturnType<typeof mock>).mock.calls.map((call) => String(call[0])),
    );
    expect(lines).toContain("Connected account #1 (@example_user)");
    for (const line of lines) {
      expect(line).not.toContain("5550000001");
      expect(line).not.toContain("Test User");
    }
  });

  it("routes the client's errors and mtcute's log through the daemon logger (#128)", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: null }]));
    const { connectAccount } = await import("./daemon-accounts");
    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    const client = createdClients[0]!;

    expect(client.onError.handlers).toHaveLength(1);
    const failure = new Error("Could not connect to DC 2");
    failure.stack = "Error: Could not connect to DC 2\n    at source dump";
    client.onError.emit(failure);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "[Account 1] Telegram client error: Could not connect to DC 2",
    );

    expect(client.log.mgr.level).toBe(1);
  });

  it("watches the client's connection state for catch-up (#124)", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: null }]));
    const { connectAccount, disconnectAllAccounts } = await import("./daemon-accounts");
    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    const client = createdClients[0]!;
    const accountState = ctx.state.accounts.get(1)!;

    client.onConnectionState.emit("offline");
    expect(accountState.watch?.online).toBe(false);
    client.onConnectionState.emit("connected");
    expect(accountState.watch?.online).toBe(true);

    await disconnectAllAccounts(ctx);
    expect(client.onConnectionState.handlers).toHaveLength(0);
  });

  it("disconnectAllAccounts closes every client once on shutdown", async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: "+15550000001", user_id: null },
      { id: 2, phone: "+15550000002", user_id: null },
      { id: 3, phone: "+15550000003", user_id: null },
    ]);
    const ctx = createContext(accountsDb);
    const { connectAccount, disconnectAllAccounts } = await import("./daemon-accounts");

    nextGetMe = { id: 5550001, firstName: "Alex", lastName: "Example" };
    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    nextGetMe = { id: 5550002, firstName: "Sam", lastName: "Example" };
    expect(await connectAccount(ctx, 2, "+15550000002", null)).toBe(true);
    startError = new Error("connection refused");
    expect(await connectAccount(ctx, 3, "+15550000003", null)).toBe(false);

    expect(createdClients).toHaveLength(3);
    expect(createdClients[0]!.destroy).not.toHaveBeenCalled();
    expect(createdClients[1]!.destroy).not.toHaveBeenCalled();

    await disconnectAllAccounts(ctx);

    for (const client of createdClients) {
      expect(client.destroy).toHaveBeenCalledTimes(1);
      expect(client.onNewMessage.handlers).toHaveLength(0);
      expect(client.onEditMessage.handlers).toHaveLength(0);
      expect(client.onDeleteMessage.handlers).toHaveLength(0);
      expect(client.onRawUpdate.handlers).toHaveLength(0);
    }
    for (const accountState of ctx.state.accounts.values()) {
      expect(accountState.status).toBe("disconnected");
      expect(accountState.client).toBeUndefined();
      expect(accountState.eventHandlers).toBeUndefined();
    }

    await disconnectAllAccounts(ctx);
    for (const client of createdClients) {
      expect(client.destroy).toHaveBeenCalledTimes(1);
    }
  });

  it("releaseClient keeps the update handlers until destroy() returns", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: null }]));
    const { connectAccount, disconnectAllAccounts } = await import("./daemon-accounts");
    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);

    const client = createdClients[0]!;
    let handlersDuringDestroy = -1;
    client.whileDestroying = async () => {
      handlersDuringDestroy = client.onNewMessage.handlers.length;
      client.onNewMessage.emit(
        asMessage({
          id: 9,
          chat: { id: 5550002, type: "user" },
          sender: { id: 5550002 },
          text: "sent as the daemon stopped",
          date: new Date("2026-01-02T12:00:00Z"),
          isOutgoing: false,
        }),
      );
    };

    await disconnectAllAccounts(ctx);

    expect(handlersDuringDestroy).toBe(1);
    expect(createMessagesCache(testCacheDb).get(5550002, 9)?.text).toBe(
      "sent as the daemon stopped",
    );
    expect(client.onNewMessage.handlers).toHaveLength(0);
    expect(client.onEditMessage.handlers).toHaveLength(0);
    expect(client.onDeleteMessage.handlers).toHaveLength(0);
    expect(ctx.state.accounts.get(1)?.eventHandlers).toBeUndefined();
  });

  it("disconnectAllAccounts closes the other clients when one fails to close", async () => {
    const ctx = createContext(
      createAccountsDb([
        { id: 1, phone: "+15550000001", user_id: null },
        { id: 2, phone: "+15550000002", user_id: null },
      ]),
    );
    const { connectAccount, disconnectAllAccounts } = await import("./daemon-accounts");

    nextGetMe = { id: 5550001, firstName: "Alex", lastName: "Example" };
    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    nextGetMe = { id: 5550002, firstName: "Sam", lastName: "Example" };
    expect(await connectAccount(ctx, 2, "+15550000002", null)).toBe(true);

    createdClients[0]!.whileDestroying = async () => {
      throw new Error("Database has closed");
    };

    await disconnectAllAccounts(ctx);

    expect(createdClients[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(createdClients[1]!.destroy).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to close client (shutdown): Error: Database has closed"),
    );
    expect(ctx.logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("already closed"));
    expect(ctx.state.accounts.get(1)?.status).toBe("disconnected");
    expect(ctx.state.accounts.get(2)?.status).toBe("disconnected");
  });

  it("attemptReconnect restores real-time updates and sync on a new client", async () => {
    const accountsDb = createAccountsDb([{ id: 1, phone: "+15550000001", user_id: 555 }]);
    const ctx = createContext(accountsDb);

    const { attemptReconnect, connectAccount } = await import("./daemon-accounts");
    const { initializeScheduler } = await import("./daemon-scheduler");

    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    await initializeScheduler(ctx);

    const oldClient = createdClients[0]!;
    const oldWorker = ctx.runtime.accounts.get(1)?.worker;
    expect(oldClient.onNewMessage.handlers).toHaveLength(1);
    expect(oldClient.onRawUpdate.handlers).toHaveLength(1);
    expect(oldWorker?.client).toBe(oldClient as unknown as TelegramClient);

    const accountState = ctx.state.accounts.get(1)!;
    accountState.status = "error";
    accountState.lastError = "connection reset";
    accountState.reconnectAttempts = 2;

    expect(await attemptReconnect(ctx, accountState)).toBe(true);

    expect(createdClients).toHaveLength(2);
    const newClient = createdClients[1]!;
    const reconnected = ctx.state.accounts.get(1);
    expect(reconnected?.client).toBe(newClient as unknown as TelegramClient);
    expect(reconnected?.status).toBe("connected");
    expect(reconnected?.reconnectAttempts).toBe(0);
    expect(reconnected?.lastError).toBeUndefined();

    expect(oldClient.onNewMessage.handlers).toHaveLength(0);
    expect(oldClient.onEditMessage.handlers).toHaveLength(0);
    expect(oldClient.onDeleteMessage.handlers).toHaveLength(0);
    expect(oldClient.onRawUpdate.handlers).toHaveLength(0);
    expect(oldClient.destroy).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(["start:0", "destroy:0", "start:1"]);

    expect(newClient.onNewMessage.handlers).toHaveLength(1);
    expect(newClient.onEditMessage.handlers).toHaveLength(1);
    expect(newClient.onDeleteMessage.handlers).toHaveLength(1);
    expect(newClient.onRawUpdate.handlers).toHaveLength(1);
    expect(newClient.startUpdatesLoop).toHaveBeenCalledTimes(1);
    expect(newClient.destroy).not.toHaveBeenCalled();

    newClient.onNewMessage.emit(
      asMessage({
        id: 7,
        chat: { id: 2000, type: "user" },
        sender: { id: 2000 },
        text: "After reconnect",
        date: new Date("2024-01-02T00:00:00Z"),
        isOutgoing: false,
      }),
    );
    const cached = createMessagesCache(testCacheDb).get(2000, 7);
    expect(cached?.text).toBe("After reconnect");

    const worker = ctx.runtime.accounts.get(1)?.worker;
    expect(worker).not.toBe(oldWorker);
    expect(worker?.client).toBe(newClient as unknown as TelegramClient);

    const { disconnectAllAccounts } = await import("./daemon-accounts");
    await disconnectAllAccounts(ctx);
    expect(oldClient.destroy).toHaveBeenCalledTimes(1);
    expect(newClient.destroy).toHaveBeenCalledTimes(1);
    expect(newClient.onNewMessage.handlers).toHaveLength(0);
    expect(newClient.onRawUpdate.handlers).toHaveLength(0);
  });

  it("asks for a contacts check after each connect and reconnect", async () => {
    const accountsDb = createAccountsDb([{ id: 1, phone: "+15550000001", user_id: 555 }]);
    const ctx = createContext(accountsDb);
    const { attemptReconnect, connectAccount } = await import("./daemon-accounts");
    const { checkAt } = ctx.runtime.contacts;

    const beforeConnect = Date.now();
    expect(await connectAccount(ctx, 1, "+15550000001", null)).toBe(true);
    const connectedAt = checkAt.get(1);
    expect(connectedAt).toBeGreaterThanOrEqual(beforeConnect);
    expect(connectedAt).toBeLessThanOrEqual(Date.now());

    checkAt.delete(1);
    const accountState = ctx.state.accounts.get(1)!;
    accountState.status = "error";
    const beforeReconnect = Date.now();
    expect(await attemptReconnect(ctx, accountState)).toBe(true);
    const reconnectedAt = checkAt.get(1);
    expect(reconnectedAt).toBeGreaterThanOrEqual(beforeReconnect);
    expect(reconnectedAt).toBeLessThanOrEqual(Date.now());
  });

  it("a failed reconnect closes its new client and schedules the next attempt", async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: "+15550000001", user_id: 555 }]));
    const { attemptReconnect } = await import("./daemon-accounts");
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+15550000001",
      name: null,
      status: "error",
      reconnectAttempts: 0,
    };

    startError = new Error("boom");
    expect(await attemptReconnect(ctx, accountState)).toBe(false);

    expect(createdClients[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(accountState).toMatchObject({
      status: "error",
      lastError: "boom",
      reconnectAttempts: 1,
    });

    startError = null;
    updatesLoopError = new Error("updates unavailable");
    const before = Date.now();
    expect(await attemptReconnect(ctx, accountState)).toBe(false);

    const client = createdClients[1]!;
    expect(client.onNewMessage.handlers).toHaveLength(0);
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(accountState.client).toBeUndefined();
    expect(accountState.eventHandlers).toBeUndefined();
    expect(accountState).toMatchObject({
      status: "error",
      lastError: "updates unavailable",
      reconnectAttempts: 2,
    });
    expect(accountState.nextReconnectAt).toBeGreaterThan(before);
  });

  describe("with two accounts", () => {
    let otherDb: Database;

    beforeEach(() => {
      otherDb = createAccountCacheDb();
    });

    afterEach(() => {
      otherDb.close();
    });

    async function wireBoth() {
      const accountsDb = createAccountsDb([
        { id: 1, phone: "+15550000001", user_id: 101 },
        { id: 2, phone: "+15550000002", user_id: 202 },
      ]);
      const ctx = testDaemonContext({ accountsDb });
      addAccountRuntime(ctx, 1, testCacheDb);
      addAccountRuntime(ctx, 2, otherDb);
      const { setupEventHandlers } = await import("./daemon-accounts");
      const states = [1, 2].map((accountId) => {
        const state: AccountConnectionState = {
          accountId,
          phone: `+1555000000${accountId}`,
          name: null,
          status: "connected",
          client: createClient(),
        };
        setupEventHandlers(ctx, state);
        return state;
      });
      return { ctx, first: states[0]!, second: states[1]! };
    }

    it("caches a live message only in the receiving account's cache", async () => {
      const { ctx, second } = await wireBoth();

      await afterHandling(second, "handleNewMessage", () =>
        second.eventHandlers?.onNewMessage(
          asMessage({
            id: 7,
            chat: { id: 4242, type: "user" },
            sender: { id: 4242 },
            text: "lunch at one",
            date: new Date("2026-01-02T12:00:00Z"),
            isOutgoing: false,
          }),
        ),
      );

      expect(createMessagesCache(otherDb).get(4242, 7)?.text).toBe("lunch at one");
      expect(createMessagesCache(testCacheDb).get(4242, 7)).toBeNull();
      expect(ctx.runtime.accounts.get(2)?.messagesSynced).toBe(1);
      expect(ctx.runtime.accounts.get(1)?.messagesSynced).toBe(0);
    });

    it("leaves the other account's message with the same ID when a delete has no chat", async () => {
      const { ctx, first } = await wireBoth();
      for (const [db, text] of [
        [testCacheDb, "lunch at noon"],
        [otherDb, "lunch at one"],
      ] as const) {
        createMessagesCache(db).upsert({
          chat_id: 4242,
          message_id: 7,
          text,
          message_type: "text",
          date: 1_760_000_000,
          raw_json: "{}",
        });
      }

      await afterHandling(first, "handleDeleteMessagesWithoutChat", () =>
        first.eventHandlers?.onDeleteMessage(asDeleteUpdate({ channelId: null, messageIds: [7] })),
      );

      expect(createMessagesCache(testCacheDb).get(4242, 7)?.is_deleted).toBe(1);
      expect(createMessagesCache(otherDb).get(4242, 7)?.is_deleted).toBe(0);
      expect(ctx.logger.warn).not.toHaveBeenCalled();
    });

    it("applies a contact update only to the receiving account's cache", async () => {
      const { second } = await wireBoth();
      const user = {
        _: "user",
        id: 4242,
        firstName: "Robin",
        contact: true,
      } as tl.RawUser;
      const client = second.client as unknown as MockTelegramClient;
      expect(client.onRawUpdate.handlers).toHaveLength(1);

      client.onRawUpdate.emit(
        new RawUpdateInfo(
          {
            _: "updatePeerSettings",
            peer: { _: "peerUser", userId: 4242 },
            settings: { _: "peerSettings" },
          },
          PeersIndex.from({ users: [user] }),
        ),
      );

      const isContact = (db: Database) =>
        (
          db.query("SELECT is_contact FROM users_cache WHERE user_id = '4242'").get() as {
            is_contact: number;
          } | null
        )?.is_contact;
      expect(isContact(otherDb)).toBe(1);
      expect(isContact(testCacheDb)).toBeUndefined();
    });
  });
});
