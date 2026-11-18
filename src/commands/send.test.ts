import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";
import { runCommand } from "citty";

type MockCall = <T extends tl.RpcMethod>(request: T) => Promise<tl.RpcCallReturn[T["_"]]>;

type MockClient = {
  call: MockCall;
  getMe: TelegramClient["getMe"];
};

import { dialogToCacheInput } from "./chats/helpers";
import { resolvePeer } from "./send/peer-resolver";
import { type ChatsCache, createChatsCache } from "../db/chats-cache";
import { createMessagesSearch } from "../db/messages-search";
import type { ChatType } from "../db/types";
import { createUsersCache, type UsersCache } from "../db/users-cache";
import { toLong } from "../utils/long";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { createFakeAccountsDb, mockDbModule, testAccount } from "../test/db-mock.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";
import { assertPeer, expectLongEqual } from "../test/input-peer.test-utils";
import { cell, richTlMessage } from "../test/rich-message.test-utils";

let commandCacheDb: Database;
let secondCacheDb: Database;
const commandCall = mock<(request: unknown) => Promise<unknown>>(async (_request) => {
  throw new Error("Unexpected API call");
});
const secondCall = mock<(request: unknown) => Promise<unknown>>(async (_request) => {
  throw new Error("Unexpected API call");
});
let commandClient = { call: commandCall };
let secondClient = { call: secondCall };
const getClientForAccount = mock((accountId: number) =>
  accountId === 2 ? secondClient : commandClient,
);
mock.module("../db", () =>
  mockDbModule({
    cacheFor: (accountId) => (accountId === 2 ? secondCacheDb : commandCacheDb),
    accountsDb: createFakeAccountsDb([
      testAccount({ id: 1 }),
      testAccount({ id: 2, phone: "+15550000002", is_active: 0 }),
    ]),
  }),
);
mock.module("../services/telegram", () => ({ getClientForAccount }));

type UserResult = Awaited<ReturnType<TelegramClient["getMe"]>>;

const createUser = (overrides: Partial<UserResult> = {}) =>
  ({
    id: 123,
    firstName: "Test",
    username: "test",
    ...overrides,
  }) as UserResult;

function createTestUser(overrides = {}) {
  return {
    user_id: "123456",
    username: "testuser",
    first_name: "Test",
    last_name: "User",
    phone: "1234567890",
    access_hash: "9876543210",
    is_contact: 1,
    is_bot: 0,
    is_premium: 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 123456, first_name: "Test" }),
    ...overrides,
  };
}

function createTestChat(overrides = {}) {
  return {
    chat_id: "-789012",
    type: "group" as ChatType,
    title: "Test Group",
    username: "testgroup",
    member_count: 10,
    access_hash: "1234567890",
    is_creator: 0,
    is_admin: 1,
    last_message_id: 100,
    last_message_at: Date.now() - 1000,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ _: "chat", id: 789012, title: "Test Group" }),
    ...overrides,
  };
}

function createMockClient(overrides: Partial<MockClient> = {}) {
  const client = {
    call: mock<MockCall>(async () => {
      throw new Error("Unexpected API call");
    }),
    getMe: mock<TelegramClient["getMe"]>(async () =>
      createUser({
        id: 123,
        firstName: "Test",
        username: "test",
      }),
    ),
    ...overrides,
  } satisfies MockClient;

  return client;
}

describe("Peer Resolution - By Username", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
  });

  describe("cached user lookup", () => {
    it("should resolve @username from users cache", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "111",
          username: "alice",
          first_name: "Alice",
          last_name: "Smith",
          access_hash: "123456789",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "@alice", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(111);
      expectLongEqual(result.inputPeer.accessHash, "123456789");
      expect(result.name).toBe("Alice Smith");
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should use display_name when available", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "222",
          username: "bob",
          first_name: "Robert",
          last_name: null,
          access_hash: "987654321",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "@bob", usersCache, chatsCache);

      expect(result.name).toBe("Robert");
    });

    it("should fallback to @username when no display_name", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "333",
          username: "mystery",
          first_name: null,
          last_name: null,
          access_hash: "111222333",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "@mystery", usersCache, chatsCache);

      expect(result.name).toBe("@mystery");
    });
  });

  describe("cached channel/supergroup lookup", () => {
    it("should resolve @username from chats cache for channel", async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: "-1000000000444",
          type: "channel",
          username: "newschannel",
          title: "News Channel",
          access_hash: "555666777",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "@newschannel", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerChannel");
      expect(result.inputPeer.channelId).toBe(444);
      expectLongEqual(result.inputPeer.accessHash, "555666777");
      expect(result.name).toBe("News Channel");
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should resolve @username from chats cache for supergroup", async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: "-1000000000555",
          type: "supergroup",
          username: "community",
          title: "Community Group",
          access_hash: "888999000",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "@community", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerChannel");
      expect(result.inputPeer.channelId).toBe(555);
      expect(result.name).toBe("Community Group");
    });

    it("should not resolve regular group by username from chats cache", async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: "-666",
          type: "group",
          username: "regulargroup",
          title: "Regular Group",
          access_hash: null,
        }),
      );

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerChat", chatId: 666 },
            users: [],
            chats: [
              {
                _: "chat",
                id: 666,
                title: "Regular Group",
                participantsCount: 10,
                photo: { _: "chatPhotoEmpty" },
                date: Math.floor(Date.now() / 1000),
                version: 1,
              },
            ],
          };

          return result;
        }),
      });

      await resolvePeer(mockClient, "@regulargroup", usersCache, chatsCache);

      expect(mockClient.call).toHaveBeenCalled();
    });
  });

  describe("API resolution fallback", () => {
    it("should resolve username via API when not in cache", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 777 },
            users: [
              {
                _: "user",
                id: 777,
                firstName: "John",
                lastName: "Doe",
                accessHash: toLong("111222333444"),
              },
            ],
            chats: [],
          };

          return result;
        }),
      });

      const result = await resolvePeer(mockClient, "@johndoe", usersCache, chatsCache);

      expect(mockClient.call).toHaveBeenCalledWith({
        _: "contacts.resolveUsername",
        username: "johndoe",
      });
      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(777);
      expect(result.name).toBe("John Doe");
    });

    it("should resolve channel via API when not in cache", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerChannel", channelId: 888 },
            users: [],
            chats: [
              {
                _: "channel",
                id: 888,
                title: "Tech Channel",
                accessHash: toLong("444555666777"),
                photo: { _: "chatPhotoEmpty" },
                date: Math.floor(Date.now() / 1000),
              },
            ],
          };

          return result;
        }),
      });

      const result = await resolvePeer(mockClient, "@techchannel", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerChannel");
      expect(result.inputPeer.channelId).toBe(888);
      expect(result.name).toBe("Tech Channel");
    });

    it("should throw error when username cannot be resolved", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 0 },
            users: [],
            chats: [],
          };

          return result;
        }),
      });

      await expect(resolvePeer(mockClient, "@nonexistent", usersCache, chatsCache)).rejects.toThrow(
        "Could not resolve @nonexistent",
      );
    });

    it("should handle API returning user with no accessHash", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 999 },
            users: [
              {
                _: "user",
                id: 999,
                firstName: "No",
                lastName: "Hash",
                accessHash: undefined,
              },
            ],
            chats: [],
          };

          return result;
        }),
      });

      const result = await resolvePeer(mockClient, "@nohash", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expectLongEqual(result.inputPeer.accessHash, 0);
      expect(result.name).toBe("No Hash");
    });
  });
});

describe("Peer Resolution - By Phone Number", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
  });

  describe("phone number detection", () => {
    it("should detect phone with + prefix", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "111",
          phone: "15551234567",
          access_hash: "123456",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "+15551234567", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(111);
    });

    it("should detect 10+ digit numbers as phone", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "222",
          phone: "1234567890",
          access_hash: "654321",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "1234567890", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(222);
    });
  });

  describe("cached phone lookup", () => {
    it("should resolve phone number from users cache", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "333",
          phone: "9876543210",
          first_name: "Phone",
          last_name: "User",
          access_hash: "111222333",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "+9876543210", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(333);
      expectLongEqual(result.inputPeer.accessHash, "111222333");
      expect(result.name).toBe("Phone User");
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should normalize phone numbers when looking up cache", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "444",
          phone: "15551234567",
          access_hash: "444555666",
        }),
      );

      const mockClient = createMockClient();

      const result1 = await resolvePeer(mockClient, "+1 (555) 123-4567", usersCache, chatsCache);
      assertPeer(result1.inputPeer, "inputPeerUser");
      expect(result1.inputPeer.userId).toBe(444);

      const result2 = await resolvePeer(mockClient, "+15551234567", usersCache, chatsCache);
      assertPeer(result2.inputPeer, "inputPeerUser");
      expect(result2.inputPeer.userId).toBe(444);

      const result3 = await resolvePeer(mockClient, "15551234567", usersCache, chatsCache);
      assertPeer(result3.inputPeer, "inputPeerUser");
      expect(result3.inputPeer.userId).toBe(444);
    });
  });

  describe("API resolution fallback", () => {
    it("should resolve phone via API when not in cache", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolvePhone") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 555 },
            users: [
              {
                _: "user",
                id: 555,
                firstName: "API",
                lastName: "User",
                accessHash: toLong("777888999"),
              },
            ],
            chats: [],
          };

          return result;
        }),
      });

      const result = await resolvePeer(mockClient, "+11234567890", usersCache, chatsCache);

      expect(mockClient.call).toHaveBeenCalledWith({
        _: "contacts.resolvePhone",
        phone: "11234567890",
      });
      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(555);
      expect(result.name).toBe("API User");
    });

    it("should throw error when phone cannot be resolved", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolvePhone") {
            throw new Error("Unexpected API call");
          }
          throw new tl.RpcError(400, "PHONE_NOT_OCCUPIED");
        }),
      });

      await expect(resolvePeer(mockClient, "+15559999999", usersCache, chatsCache)).rejects.toThrow(
        "Could not resolve phone number +15559999999",
      );
    });

    it("should throw when API returns no users", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolvePhone") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 0 },
            users: [],
            chats: [],
          };

          return result;
        }),
      });

      await expect(resolvePeer(mockClient, "+15558888888", usersCache, chatsCache)).rejects.toThrow(
        "Could not resolve phone number +15558888888",
      );
    });
  });
});

describe("Peer Resolution - By Numeric ID", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
  });

  describe("user ID lookup", () => {
    it("should resolve user ID from users cache", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "123456789",
          first_name: "Numeric",
          last_name: "User",
          access_hash: "999888777",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "123456789", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(123456789);
      expectLongEqual(result.inputPeer.accessHash, "999888777");
      expect(result.name).toBe("Numeric User");
    });

    it("should use fallback name for user without display_name", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "111222",
          first_name: null,
          last_name: null,
          access_hash: "333444",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "111222", usersCache, chatsCache);

      expect(result.name).toBe("User 111222");
    });
  });

  describe("chat ID lookup", () => {
    it("should resolve private chat ID from chats cache", async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: "555666",
          type: "private",
          title: "Private Chat",
          access_hash: "777888",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "555666", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(555666);
      expect(result.name).toBe("Private Chat");
    });

    it("should resolve a marked group chat ID from chats cache", async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: "-777888",
          type: "group",
          title: "Group Chat",
          access_hash: null,
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "-777888", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerChat");
      expect(result.inputPeer.chatId).toBe(777888);
      expect(result.name).toBe("Group Chat");
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should resolve a marked channel ID with the cached access hash", async () => {
      chatsCache.upsert(
        createTestChat({
          chat_id: "-1000000888999",
          type: "channel",
          title: "My Channel",
          access_hash: "111222333",
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "-1000000888999", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerChannel");
      expect(result.inputPeer.channelId).toBe(888999);
      expectLongEqual(result.inputPeer.accessHash, "111222333");
      expect(result.name).toBe("My Channel");
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should resolve a marked supergroup ID from chats cache", async () => {
      chatsCache.upsert(
        dialogToCacheInput(fakeDialog({ kind: "supergroup", id: 999000, title: "Supergroup" })),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "-1000000999000", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerChannel");
      expect(result.inputPeer.channelId).toBe(999000);
      expectLongEqual(result.inputPeer.accessHash, "777");
      expect(result.name).toBe("Supergroup");
    });

    it("should resolve the bare channel ID that 0.2.0 printed without a phone lookup", async () => {
      chatsCache.upsert(
        dialogToCacheInput(
          fakeDialog({
            kind: "supergroup",
            id: 1234567890,
            title: "Team Chat",
          }),
        ),
      );

      const mockClient = createMockClient();
      const bare = await resolvePeer(mockClient, "1234567890", usersCache, chatsCache);
      const marked = await resolvePeer(mockClient, "-1001234567890", usersCache, chatsCache);

      expect(bare).toEqual(marked);
      assertPeer(bare.inputPeer, "inputPeerChannel");
      expect(bare.inputPeer.channelId).toBe(1234567890);
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should reject a bare ID that names a cached group and a cached channel", async () => {
      chatsCache.upsertMany(
        [
          fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
          fakeDialog({ kind: "channel", id: 4242, title: "Example News" }),
        ].map(dialogToCacheInput),
      );

      const mockClient = createMockClient();

      await expect(resolvePeer(mockClient, "4242", usersCache, chatsCache)).rejects.toMatchObject({
        name: "AmbiguousPeerError",
        candidates: [-4242, -1000000004242],
      });
      expect(mockClient.call).not.toHaveBeenCalled();
    });
  });

  describe("fallback behavior", () => {
    it("should take an unknown positive ID as a user with access hash 0", async () => {
      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "12345", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(12345);
      expectLongEqual(result.inputPeer.accessHash, 0);
      expect(result.name).toBe("User 12345");
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should throw error for invalid numeric identifier", async () => {
      const mockClient = createMockClient();

      await expect(resolvePeer(mockClient, "12.5", usersCache, chatsCache)).rejects.toThrow(
        "Invalid peer identifier: 12.5",
      );
    });
  });
});

describe("Message Sending", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
  });

  describe("sendMessage request building", () => {
    it("should build basic sendMessage request", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "123",
          username: "recipient",
          access_hash: "456",
        }),
      );

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "messages.sendMessage") {
            throw new Error("Unexpected API call");
          }

          const result: tl.RawUpdateShortSentMessage = {
            _: "updateShortSentMessage",
            id: 12345,
            date: Math.floor(Date.now() / 1000),
            pts: 1,
            ptsCount: 1,
            out: true,
            media: undefined,
            entities: undefined,
          };

          return result;
        }),
      });

      const { inputPeer } = await resolvePeer(mockClient, "@recipient", usersCache, chatsCache);

      const request: tl.messages.RawSendMessageRequest = {
        _: "messages.sendMessage",
        peer: inputPeer,
        message: "Hello, world!",
        randomId: toLong(123456),
        noWebpage: false,
        silent: false,
      };

      await mockClient.call(request);

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: "messages.sendMessage",
          message: "Hello, world!",
          silent: false,
        }),
      );
    });

    it("should include silent flag when specified", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "123",
          username: "recipient",
          access_hash: "456",
        }),
      );

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "messages.sendMessage") {
            throw new Error("Unexpected API call");
          }

          const result: tl.RawUpdateShortSentMessage = {
            _: "updateShortSentMessage",
            id: 12346,
            date: Math.floor(Date.now() / 1000),
            pts: 1,
            ptsCount: 1,
            out: true,
            media: undefined,
            entities: undefined,
          };

          return result;
        }),
      });

      const { inputPeer } = await resolvePeer(mockClient, "@recipient", usersCache, chatsCache);

      const request: tl.messages.RawSendMessageRequest = {
        _: "messages.sendMessage",
        peer: inputPeer,
        message: "Silent message",
        randomId: toLong(123457),
        noWebpage: false,
        silent: true,
      };

      await mockClient.call(request);

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: "messages.sendMessage",
          silent: true,
        }),
      );
    });

    it("should include replyTo when specified", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "123",
          username: "recipient",
          access_hash: "456",
        }),
      );

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "messages.sendMessage") {
            throw new Error("Unexpected API call");
          }

          const result: tl.RawUpdateShortSentMessage = {
            _: "updateShortSentMessage",
            id: 12347,
            date: Math.floor(Date.now() / 1000),
            pts: 1,
            ptsCount: 1,
            out: true,
            media: undefined,
            entities: undefined,
          };

          return result;
        }),
      });

      const { inputPeer } = await resolvePeer(mockClient, "@recipient", usersCache, chatsCache);

      const request: tl.messages.RawSendMessageRequest = {
        _: "messages.sendMessage",
        peer: inputPeer,
        message: "Reply message",
        randomId: toLong(123458),
        noWebpage: false,
        silent: false,
        replyTo: {
          _: "inputReplyToMessage",
          replyToMsgId: 999,
        },
      };

      await mockClient.call(request);

      expect(mockClient.call).toHaveBeenCalledWith(
        expect.objectContaining({
          _: "messages.sendMessage",
          replyTo: {
            _: "inputReplyToMessage",
            replyToMsgId: 999,
          },
        }),
      );
    });
  });

  describe("response handling", () => {
    it("should extract message ID from updateShortSentMessage", () => {
      const result = {
        _: "updateShortSentMessage",
        id: 12345,
        date: 1700000000,
      };

      let messageId: number | null = null;
      let timestamp: number | null = null;

      if (result._ === "updateShortSentMessage") {
        messageId = result.id;
        timestamp = result.date;
      }

      expect(messageId).toBe(12345);
      expect(timestamp).toBe(1700000000);
    });

    it("should extract message ID from updates array", () => {
      const result = {
        _: "updates",
        updates: [
          {
            _: "updateMessageID",
            id: 54321,
          },
          {
            _: "updateNewMessage",
            message: {
              id: 54321,
              date: 1700000001,
            },
          },
        ],
      };

      let messageId: number | null = null;

      for (const update of result.updates) {
        if (
          update._ === "updateMessageID" ||
          update._ === "updateNewMessage" ||
          update._ === "updateNewChannelMessage"
        ) {
          if (update._ === "updateMessageID") {
            messageId = update.id ?? null;
          } else {
            messageId = update.message?.id ?? null;
          }
          break;
        }
      }

      expect(messageId).toBe(54321);
    });
  });
});

describe("Error Handling", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
  });

  describe("peer resolution errors", () => {
    it("should throw for invalid identifier format", async () => {
      const mockClient = createMockClient();

      await expect(resolvePeer(mockClient, "-12.5", usersCache, chatsCache)).rejects.toThrow(
        "Invalid peer identifier",
      );
      expect(mockClient.call).not.toHaveBeenCalled();
    });

    it("should throw when username resolution fails", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 0 },
            users: [],
            chats: [],
          };

          return result;
        }),
      });

      await expect(
        resolvePeer(mockClient, "@doesnotexist", usersCache, chatsCache),
      ).rejects.toThrow("Could not resolve @doesnotexist");
    });

    it("should throw when phone resolution fails", async () => {
      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolvePhone") {
            throw new Error("Unexpected API call");
          }
          throw new tl.RpcError(400, "PHONE_NOT_OCCUPIED");
        }),
      });

      await expect(resolvePeer(mockClient, "+10000000000", usersCache, chatsCache)).rejects.toThrow(
        "Could not resolve phone number +10000000000",
      );
    });
  });

  describe("Telegram API errors", () => {
    it("should detect PEER_ID_INVALID error", () => {
      const error = new Error("PEER_ID_INVALID");
      expect(error.message.includes("PEER_ID_INVALID")).toBe(true);
    });

    it("should detect USER_IS_BOT error", () => {
      const error = new Error("USER_IS_BOT");
      expect(error.message.includes("USER_IS_BOT")).toBe(true);
    });

    it("should detect CHAT_WRITE_FORBIDDEN error", () => {
      const error = new Error("CHAT_WRITE_FORBIDDEN");
      expect(error.message.includes("CHAT_WRITE_FORBIDDEN")).toBe(true);
    });
  });

  describe("cache edge cases", () => {
    it("should skip cache entry without access_hash for username lookup", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "111",
          username: "noaccess",
          access_hash: null,
        }),
      );

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolveUsername") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 111 },
            users: [
              {
                _: "user",
                id: 111,
                firstName: "Has",
                lastName: "Access",
                accessHash: toLong("999"),
              },
            ],
            chats: [],
          };

          return result;
        }),
      });

      const result = await resolvePeer(mockClient, "@noaccess", usersCache, chatsCache);

      expect(mockClient.call).toHaveBeenCalled();
      assertPeer(result.inputPeer, "inputPeerUser");
      expectLongEqual(result.inputPeer.accessHash, "999");
    });

    it("should skip cache entry without access_hash for phone lookup", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "222",
          phone: "5555555555",
          access_hash: null,
        }),
      );

      const mockClient = createMockClient({
        call: mock<MockCall>(async (request) => {
          if (request._ !== "contacts.resolvePhone") {
            throw new Error("Unexpected API call");
          }

          const result: tl.contacts.RawResolvedPeer = {
            _: "contacts.resolvedPeer",
            peer: { _: "peerUser", userId: 222 },
            users: [
              {
                _: "user",
                id: 222,
                firstName: "Phone",
                lastName: "User",
                accessHash: toLong("888"),
              },
            ],
            chats: [],
          };

          return result;
        }),
      });

      const result = await resolvePeer(mockClient, "+5555555555", usersCache, chatsCache);

      expect(mockClient.call).toHaveBeenCalled();
      assertPeer(result.inputPeer, "inputPeerUser");
      expectLongEqual(result.inputPeer.accessHash, "888");
    });

    it("should skip cache entry without access_hash for user ID lookup", async () => {
      usersCache.upsert(
        createTestUser({
          user_id: "333333",
          access_hash: null,
        }),
      );

      const mockClient = createMockClient();
      const result = await resolvePeer(mockClient, "333333", usersCache, chatsCache);

      assertPeer(result.inputPeer, "inputPeerUser");
      expect(result.inputPeer.userId).toBe(333333);
      expectLongEqual(result.inputPeer.accessHash, 0);
    });
  });
});

describe("Input Validation", () => {
  describe("identifier type detection", () => {
    it("should detect @username format", () => {
      const identifier = "@testuser";
      const isUsername = identifier.startsWith("@");
      expect(isUsername).toBe(true);
    });

    it("should detect phone with + prefix", () => {
      const identifier = "+1234567890";
      const isPhone = identifier.startsWith("+") || /^\d{10,}$/.test(identifier);
      expect(isPhone).toBe(true);
    });

    it("should detect 10+ digit phone without +", () => {
      const identifier = "12345678901";
      const isPhone = identifier.startsWith("+") || /^\d{10,}$/.test(identifier);
      expect(isPhone).toBe(true);
    });

    it("should not detect short numbers as phone", () => {
      const identifier = "123456789";
      const isPhone = identifier.startsWith("+") || /^\d{10,}$/.test(identifier);
      expect(isPhone).toBe(false);
    });

    it("should detect numeric ID (short number)", () => {
      const identifier = "12345";
      const isUsername = identifier.startsWith("@");
      const isPhone = identifier.startsWith("+") || /^\d{10,}$/.test(identifier);
      const isNumericId = !isUsername && !isPhone && !Number.isNaN(Number.parseInt(identifier, 10));
      expect(isNumericId).toBe(true);
    });
  });

  describe("phone number normalization", () => {
    it("should remove + from phone", () => {
      const phone = "+1234567890";
      const normalized = phone.replace(/[\s\-+()]/g, "");
      expect(normalized).toBe("1234567890");
    });

    it("should remove spaces from phone", () => {
      const phone = "+1 234 567 890";
      const normalized = phone.replace(/[\s\-+()]/g, "");
      expect(normalized).toBe("1234567890");
    });

    it("should remove dashes from phone", () => {
      const phone = "+1-234-567-890";
      const normalized = phone.replace(/[\s\-+()]/g, "");
      expect(normalized).toBe("1234567890");
    });

    it("should remove parentheses from phone", () => {
      const phone = "+1 (234) 567-890";
      const normalized = phone.replace(/[\s\-+()]/g, "");
      expect(normalized).toBe("1234567890");
    });
  });

  describe("username normalization", () => {
    it("should strip @ from username", () => {
      const identifier = "@testuser";
      const username = identifier.startsWith("@") ? identifier.slice(1) : identifier;
      expect(username).toBe("testuser");
    });

    it("should keep username without @", () => {
      const identifier = "testuser";
      const username = identifier.startsWith("@") ? identifier.slice(1) : identifier;
      expect(username).toBe("testuser");
    });
  });
});

describe("Resolution Priority", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
  });

  it("should prefer users cache over chats cache for @username", async () => {
    usersCache.upsert(
      createTestUser({
        user_id: "111",
        username: "shared",
        access_hash: "222",
      }),
    );
    chatsCache.upsert(
      createTestChat({
        chat_id: "-1000000000333",
        type: "channel",
        username: "shared",
        access_hash: "444",
      }),
    );

    const mockClient = createMockClient();
    const result = await resolvePeer(mockClient, "@shared", usersCache, chatsCache);

    assertPeer(result.inputPeer, "inputPeerUser");
    expect(result.inputPeer.userId).toBe(111);
  });

  it("should take a positive ID as the cached user before a cached group", async () => {
    usersCache.upsert(
      createTestUser({
        user_id: "4242",
        access_hash: "666",
      }),
    );
    chatsCache.upsert(
      dialogToCacheInput(fakeDialog({ kind: "group", id: 4242, title: "Book Club" })),
    );

    const mockClient = createMockClient();
    const result = await resolvePeer(mockClient, "4242", usersCache, chatsCache);

    assertPeer(result.inputPeer, "inputPeerUser");
    expect(result.inputPeer.userId).toBe(4242);
    expectLongEqual(result.inputPeer.accessHash, "666");

    const group = await resolvePeer(mockClient, "-4242", usersCache, chatsCache);
    assertPeer(group.inputPeer, "inputPeerChat");
    expect(group.inputPeer.chatId).toBe(4242);
    expect(group.name).toBe("Book Club");
  });

  it("should fall through to chats cache when user has no access_hash", async () => {
    usersCache.upsert(
      createTestUser({
        user_id: "666",
        username: "fallthrough",
        access_hash: null,
      }),
    );
    chatsCache.upsert(
      createTestChat({
        chat_id: "-1000000000777",
        type: "channel",
        username: "fallthrough",
        access_hash: "888",
      }),
    );

    const mockClient = createMockClient({
      call: mock<MockCall>(async (request) => {
        if (request._ !== "contacts.resolveUsername") {
          throw new Error("Unexpected API call");
        }

        const result: tl.contacts.RawResolvedPeer = {
          _: "contacts.resolvedPeer",
          peer: { _: "peerUser", userId: 0 },
          users: [],
          chats: [],
        };

        return result;
      }),
    });

    const result = await resolvePeer(mockClient, "@fallthrough", usersCache, chatsCache);

    assertPeer(result.inputPeer, "inputPeerChannel");
    expect(result.inputPeer.channelId).toBe(777);
    expect(mockClient.call).not.toHaveBeenCalled();
  });
});

describe("send command", () => {
  beforeEach(() => {
    commandCacheDb = createAccountCacheDb();
    secondCacheDb = createAccountCacheDb();
    commandCall.mockReset();
    commandCall.mockImplementation(async () => {
      throw new Error("Unexpected API call");
    });
    secondCall.mockReset();
    secondCall.mockImplementation(async () => {
      throw new Error("Unexpected API call");
    });
    getClientForAccount.mockClear();
    commandClient = { call: commandCall };
    secondClient = { call: secondCall };
  });

  const sentUpdates = async () => ({
    _: "updates",
    updates: [],
    users: [],
    chats: [],
    date: 1_760_000_000,
    seq: 0,
  });

  const apiActivity = (db: Database) => db.query("SELECT method, success FROM api_activity").all();

  it("sends from the account --account selects, with that account's access hash", async () => {
    createUsersCache(commandCacheDb).upsert(createTestUser({ access_hash: "111" }));
    createUsersCache(secondCacheDb).upsert(createTestUser({ access_hash: "222" }));
    secondCall.mockImplementationOnce(sentUpdates);
    const { sendCommand } = await import("./send");
    const run = sendCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await run({
        args: {
          to: "123456",
          message: "hi",
          account: "2",
          silent: false,
          _: [],
        },
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(getClientForAccount.mock.calls).toEqual([[2]]);
    expect(commandCall).not.toHaveBeenCalled();
    expect(secondCall).toHaveBeenCalledTimes(1);
    const request = secondCall.mock.calls[0]?.[0] as {
      _: string;
      peer: tl.TypeInputPeer;
    };
    expect(request._).toBe("messages.sendMessage");
    assertPeer(request.peer, "inputPeerUser");
    expect(request.peer.userId).toBe(123456);
    expectLongEqual(request.peer.accessHash, "222");
    expect(apiActivity(secondCacheDb)).toEqual([{ method: "messages.sendMessage", success: 1 }]);
    expect(apiActivity(commandCacheDb)).toEqual([]);
  });

  it("sends from the active account without --account", async () => {
    createUsersCache(commandCacheDb).upsert(createTestUser({ access_hash: "111" }));
    createUsersCache(secondCacheDb).upsert(createTestUser({ access_hash: "222" }));
    commandCall.mockImplementationOnce(sentUpdates);
    const { sendCommand } = await import("./send");
    const run = sendCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await run({ args: { to: "123456", message: "hi", silent: false, _: [] } });
    } finally {
      logSpy.mockRestore();
    }

    expect(getClientForAccount.mock.calls).toEqual([[1]]);
    expect(secondCall).not.toHaveBeenCalled();
    const request = commandCall.mock.calls[0]?.[0] as {
      peer: tl.TypeInputPeer;
    };
    assertPeer(request.peer, "inputPeerUser");
    expectLongEqual(request.peer.accessHash, "111");
    expect(apiActivity(secondCacheDb)).toEqual([]);
  });

  it("rejects a bare ID that names a cached group and a cached channel with INVALID_ARGS", async () => {
    createChatsCache(commandCacheDb).upsertMany(
      [
        fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
        fakeDialog({ kind: "channel", id: 4242, title: "Example News" }),
      ].map(dialogToCacheInput),
    );
    const { sendCommand } = await import("./send");
    const run = sendCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        run({ args: { to: "4242", message: "hi", silent: false, _: [] } }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGS",
        details: { to: "4242", candidates: [-4242, -1000000004242] },
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(commandCall).not.toHaveBeenCalled();
  });

  it("sends to user 4242, not basic group 4242, when the cache does not know the ID", async () => {
    commandCall.mockImplementationOnce(async () => ({
      _: "updates",
      updates: [],
      users: [],
      chats: [],
      date: 1_760_000_000,
      seq: 0,
    }));
    const { sendCommand } = await import("./send");
    const run = sendCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const logSpy = spyOn(console, "log").mockImplementation(() => {});

    try {
      await run({ args: { to: "4242", message: "hi", silent: false, _: [] } });
    } finally {
      logSpy.mockRestore();
    }
    expect(commandCall).toHaveBeenCalledTimes(1);
    const request = commandCall.mock.calls[0]?.[0] as {
      _: string;
      peer: tl.TypeInputPeer;
    };
    expect(request._).toBe("messages.sendMessage");
    assertPeer(request.peer, "inputPeerUser");
    expect(request.peer.userId).toBe(4242);
    expectLongEqual(request.peer.accessHash, 0);
  });

  type SendRun = (input: { args: Record<string, unknown> }) => Promise<void>;
  type SentRequest = {
    message: string;
    richMessage?: tl.TypeInputRichMessage;
  };

  const sendTo4242 = async (
    message: string,
    format?: "markdown" | "html",
    reply?: tl.TypeUpdates,
  ) => {
    commandCall.mockResolvedValueOnce(reply ?? (await sentUpdates()));
    const { sendCommand } = await import("./send");
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    let printed: string;
    try {
      await runCommand(sendCommand, {
        rawArgs: ["--to", "4242", "-m", message, ...(format ? [`--${format}`] : [])],
      });
      printed = String(logSpy.mock.calls[0]?.[0]);
    } finally {
      logSpy.mockRestore();
    }
    return {
      request: commandCall.mock.calls[0]?.[0] as SentRequest,
      data: JSON.parse(printed).data as { format: string | null },
    };
  };

  const table = "# Prices\n\n| Item | Price |\n|:-----|------:|\n| Tea | 3 |";

  it("sends --markdown as a rich message Telegram parses, with no text", async () => {
    const { request, data } = await sendTo4242(table, "markdown");

    expect(request.message).toBe("");
    expect(request.richMessage).toEqual({
      _: "inputRichMessageMarkdown",
      markdown: table,
    });
    expect(data.format).toBe("markdown");
  });

  it("sends --html as a rich message", async () => {
    const html = "<table><tr><td>Tea</td></tr></table>";
    const message = richTlMessage({ _: "peerUser", userId: 4242 }, 17, [
      {
        _: "pageBlockTable",
        title: { _: "textEmpty" },
        rows: [{ _: "pageTableRow", cells: [cell("Tea")] }],
      },
    ]);
    const { request, data } = await sendTo4242(html, "html", {
      _: "updates",
      users: [],
      chats: [],
      date: message.date,
      seq: 1,
      updates: [{ _: "updateNewMessage", message, pts: 1, ptsCount: 1 }],
    });
    expect(createMessagesSearch(commandCacheDb).search("Tea")[0]?.text).toContain("| Tea |");
    expect(commandCall).toHaveBeenCalledTimes(1);

    expect(request.message).toBe("");
    expect(request.richMessage).toEqual({ _: "inputRichMessageHTML", html });
    expect(data.format).toBe("html");
  });

  it("sends a message without --markdown or --html as plain text", async () => {
    const { request, data } = await sendTo4242("**not bold**");

    expect(request.message).toBe("**not bold**");
    expect(request.richMessage).toBeUndefined();
    expect(data.format).toBeNull();
  });

  it("keeps a local recipient error even when the address contains an RPC name", async () => {
    const { sendCommand } = await import("./send");
    const stderr = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runCommand(sendCommand, {
          rawArgs: ["--to", "+RICH_MESSAGE_EMPTY", "--html", "-m", "hi"],
        }),
      ).rejects.toThrow("Invalid peer identifier");
      expect(commandCall).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ["RICH_MESSAGE_UNSUPPORTED", "plain text"],
    ["RICH_MESSAGE_TABLE_COLS_TOO_MANY", "20 table columns"],
    ["RICH_MESSAGE_EMPTY", "visible content"],
  ])("explains %s from Telegram", async (name, hint) => {
    commandCall.mockRejectedValueOnce(
      tl.RpcError.fromTl({
        _: "rpc_error",
        errorCode: 400,
        errorMessage: name,
      }),
    );
    const { sendCommand } = await import("./send");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        (sendCommand.run as SendRun)({
          args: { to: "4242", message: table, markdown: true, _: [] },
        }),
      ).rejects.toMatchObject({
        code: "TELEGRAM_ERROR",
        details: { telegramError: name },
        retryable: false,
        suggestion: expect.stringContaining(hint),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
