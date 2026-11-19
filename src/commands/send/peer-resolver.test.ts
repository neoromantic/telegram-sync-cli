import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";

import { dialogToCacheInput } from "../chats/helpers";
import { AmbiguousPeerError, createDmLookup, InvalidPeerError, resolvePeer } from "./peer-resolver";
import { ConfigError } from "../../config";
import { createChatSyncStateService } from "../../db/chat-sync-state";
import { type ChatsCache, createChatsCache } from "../../db/chats-cache";
import { createMessagesCache, type MessagesCache } from "../../db/messages-cache";
import { SyncPriority } from "../../db/sync-schema";
import type { ChatType } from "../../db/types";
import { createUsersCache, type UserCacheInput, type UsersCache } from "../../db/users-cache";
import { toLong } from "../../utils/long";
import { RateLimitError } from "../../utils/telegram-rate-limits";
import { chatRow, createAccountCacheDb } from "../../test/cache-db.test-utils";
import { fakeDialog } from "../../test/fake-dialogs.test-utils";
import { legacyChatRow } from "../../test/legacy-cache.test-utils";

function throwingClient(failure: () => Error = () => new Error("unexpected API call")) {
  const call = mock(async (_request: unknown) => {
    throw failure();
  });
  return { call, client: { call } as unknown as Pick<TelegramClient, "call"> };
}

const phoneNotOccupied = () => new tl.RpcError(400, "PHONE_NOT_OCCUPIED");

describe("resolvePeer", () => {
  it.each(["me", "self", " Me "])(
    "resolves %p to Saved Messages without an API call",
    async (identifier) => {
      const call = mock(async () => {
        throw new Error("unexpected API call");
      });
      const client = { call } as unknown as Pick<TelegramClient, "call">;

      const peer = await resolvePeer(client, identifier, {} as UsersCache, {} as ChatsCache);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerSelf" },
        name: "Saved Messages",
      });
      expect(call).not.toHaveBeenCalled();
    },
  );
});

describe("resolvePeer with numeric IDs", () => {
  let db: Database;
  let usersCache: UsersCache;
  let chatsCache: ChatsCache;
  let messagesCache: MessagesCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    usersCache = createUsersCache(db);
    chatsCache = createChatsCache(db);
    messagesCache = createMessagesCache(db);
  });

  function cacheMessage(chatId: number) {
    messagesCache.upsert({
      chat_id: chatId,
      message_id: 1,
      from_id: chatId,
      text: "hi",
      message_type: "text",
      date: 1_760_000_000,
      raw_json: "{}",
    });
  }

  function resolvedPeer(users: tl.TypeUser[]) {
    const result: tl.contacts.RawResolvedPeer = {
      _: "contacts.resolvedPeer",
      peer: { _: "peerUser", userId: 0 },
      users,
      chats: [],
    };
    return result;
  }

  function cacheChat(
    chatId: string,
    type: ChatType,
    title: string,
    accessHash: string | null = null,
  ) {
    chatsCache.upsert(chatRow(chatId, type, { title, access_hash: accessHash }));
  }

  function cacheUser(user: Omit<UserCacheInput, "fetched_at" | "raw_json">) {
    usersCache.upsert({ ...user, fetched_at: 1_760_000_000_000, raw_json: "{}" });
  }

  function resolve(identifier: string, client: Pick<TelegramClient, "call">) {
    return resolvePeer(client, identifier, usersCache, chatsCache, createDmLookup(db));
  }

  describe("marked IDs, as every tg command prints them", () => {
    it("resolves a cached channel with its access hash", async () => {
      cacheChat("-1001234567890", "supergroup", "Team Chat", "2222");
      const { call, client } = throwingClient();

      const peer = await resolve("-1001234567890", client);

      expect(peer).toEqual({
        inputPeer: {
          _: "inputPeerChannel",
          channelId: 1234567890,
          accessHash: toLong("2222"),
        },
        name: "Team Chat",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("resolves a cached basic group", async () => {
      cacheChat("-4242", "group", "Book Club");
      const { call, client } = throwingClient();

      const peer = await resolve("-4242", client);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerChat", chatId: 4242 },
        name: "Book Club",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("does not take user 4242 for group -4242", async () => {
      cacheChat("4242", "private", "Alice Able", "1111");
      const { call, client } = throwingClient();

      const peer = await resolve("-4242", client);

      expect(peer.inputPeer).toEqual({ _: "inputPeerChat", chatId: 4242 });
      expect(call).not.toHaveBeenCalled();
    });

    it("builds an uncached channel without an API call", async () => {
      const { call, client } = throwingClient();

      const peer = await resolve("-1009999999999", client);

      expect(peer.inputPeer).toEqual({
        _: "inputPeerChannel",
        channelId: 9999999999,
        accessHash: toLong(0),
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("builds an uncached basic group without an API call", async () => {
      const { call, client } = throwingClient();

      const peer = await resolve("-4343", client);

      expect(peer.inputPeer).toEqual({ _: "inputPeerChat", chatId: 4343 });
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe("@username", () => {
    it.each(["channel", "supergroup"] as const)(
      "resolves a cached %s to its bare channel ID",
      async (kind) => {
        chatsCache.upsert(
          dialogToCacheInput(
            fakeDialog({ kind, id: 1234567890, title: "Team Chat", username: "teamchat" }),
          ),
        );
        const { call, client } = throwingClient();

        const peer = await resolve("@teamchat", client);

        expect(peer).toEqual({
          inputPeer: {
            _: "inputPeerChannel",
            channelId: 1234567890,
            accessHash: toLong(777),
          },
          name: "Team Chat",
        });
        expect(call).not.toHaveBeenCalled();
      },
    );

    it("resolves a cached user before a cached channel with the same username", async () => {
      cacheUser({
        user_id: "10",
        username: "alice",
        first_name: "Alice",
        last_name: "Able",
        access_hash: "1111",
      });
      chatsCache.upsert(
        chatRow("-1009100000001", "channel", { username: "alice", access_hash: "2222" }),
      );
      const { call, client } = throwingClient();

      const peer = await resolve("@alice", client);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerUser", userId: 10, accessHash: toLong("1111") },
        name: "Alice Able",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("passes over a cached user without an access hash to the cached channel", async () => {
      cacheUser({ user_id: "10", username: "alice", first_name: "Alice" });
      chatsCache.upsert(
        chatRow("-1009100000001", "channel", { username: "alice", access_hash: "2222" }),
      );
      const { call, client } = throwingClient();

      const peer = await resolve("@alice", client);

      expect(peer.inputPeer).toEqual({
        _: "inputPeerChannel",
        channelId: 9100000001,
        accessHash: toLong("2222"),
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("asks Telegram for the username of a cached basic group", async () => {
      chatsCache.upsert(chatRow("-666", "group", { username: "bookclub" }));
      const call = mock(async (_request: unknown) => ({
        _: "contacts.resolvedPeer",
        peer: { _: "peerChat", chatId: 666 },
        users: [],
        chats: [
          {
            _: "chat",
            id: 666,
            title: "Book Club",
            participantsCount: 10,
            photo: { _: "chatPhotoEmpty" },
            date: 1_760_000_000,
            version: 1,
          },
        ],
      }));

      const peer = await resolve("@bookclub", { call } as unknown as Pick<TelegramClient, "call">);

      expect(call).toHaveBeenCalledTimes(1);
      expect(peer.inputPeer).toEqual({ _: "inputPeerChat", chatId: 666 });
    });

    it("takes a user Telegram returns without an access hash with hash 0", async () => {
      const call = mock(async () => resolvedPeer([{ _: "user", id: 10, firstName: "Alice" }]));

      const peer = await resolve("@alice", { call } as unknown as Pick<TelegramClient, "call">);

      expect(peer.inputPeer).toEqual({ _: "inputPeerUser", userId: 10, accessHash: toLong(0) });
    });

    it("fails for a username Telegram does not know", async () => {
      const call = mock(async () => resolvedPeer([]));

      await expect(
        resolve("@nobody", { call } as unknown as Pick<TelegramClient, "call">),
      ).rejects.toThrow("Could not resolve @nobody");
    });

    it("keeps a cached channel's dialog metadata when it resolves a new username", async () => {
      chatsCache.upsert(
        chatRow("-1009100000006", "channel", {
          title: "Made-up News",
          username: "made_up_old_alias",
          member_count: 123,
          access_hash: "777",
          last_message_id: 77,
          last_message_at: 1_760_000_000_000,
        }),
      );
      const channel = {
        _: "channel",
        id: 9_100_000_006,
        broadcast: true,
        title: "Made-up News",
        username: "made_up_new_alias",
        accessHash: toLong(777),
        photo: { _: "chatPhotoEmpty" },
        date: 1_760_000_000,
      };
      const client = {
        call: async () => ({
          _: "contacts.resolvedPeer",
          peer: { _: "peerChannel", channelId: 9_100_000_006 },
          chats: [channel],
          users: [],
        }),
      } as unknown as TelegramClient;

      const peer = await resolve("@made_up_new_alias", client);

      expect(peer).toEqual({
        inputPeer: {
          _: "inputPeerChannel",
          channelId: 9_100_000_006,
          accessHash: toLong(777),
        },
        name: "Made-up News",
      });
      expect(chatsCache.getById("-1009100000006")).toMatchObject({
        type: "channel",
        username: "made_up_new_alias",
        access_hash: "777",
        member_count: 123,
        last_message_id: 77,
        last_message_at: 1_760_000_000_000,
      });
    });
  });

  describe("bare chat IDs from 0.2.0", () => {
    it("resolves the bare ID of a cached channel without a phone lookup", async () => {
      cacheChat("-1001234567890", "supergroup", "Team Chat", "2222");
      const { call, client } = throwingClient();

      const bare = await resolve("1234567890", client);

      expect(bare).toEqual(await resolve("-1001234567890", client));
      expect(bare.inputPeer).toEqual({
        _: "inputPeerChannel",
        channelId: 1234567890,
        accessHash: toLong("2222"),
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("resolves the bare ID of a cached basic group", async () => {
      cacheChat("-4242", "group", "Book Club");
      const { call, client } = throwingClient();

      const peer = await resolve("4242", client);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerChat", chatId: 4242 },
        name: "Book Club",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("takes a positive ID as the cached user before a cached group", async () => {
      cacheChat("4242", "private", "Alice Able", "1111");
      cacheChat("-4242", "group", "Book Club");
      const { call, client } = throwingClient();

      const peer = await resolve("4242", client);

      expect(peer).toEqual({
        inputPeer: {
          _: "inputPeerUser",
          userId: 4242,
          accessHash: toLong("1111"),
        },
        name: "Alice Able",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("takes a positive ID with DM sync state as that user before a cached group", async () => {
      cacheChat("-4242", "group", "Book Club");
      createChatSyncStateService(db).upsert({
        chat_id: 4242,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });
      const { call, client } = throwingClient();

      const peer = await resolve("4242", client);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerUser", userId: 4242, accessHash: toLong(0) },
        name: "User 4242",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("does not take a bare group row from an older binary for a user", async () => {
      chatsCache.upsert(legacyChatRow({ kind: "group", id: 4242, title: "Book Club" }));
      const { call, client } = throwingClient();

      const peer = await resolve("4242", client);

      expect(peer.inputPeer._).not.toBe("inputPeerUser");
      expect(peer.inputPeer).toEqual({ _: "inputPeerChat", chatId: 4242 });
      expect(call).not.toHaveBeenCalled();
    });

    it.each([
      ["channel", 4242, "Example News"],
      ["supergroup", 1234567890, "Team Chat"],
    ] as const)(
      "takes a bare %s row %d from an older binary for that chat, with no phone lookup",
      async (kind, id, title) => {
        chatsCache.upsert(legacyChatRow({ kind, id, title }));
        const { call, client } = throwingClient(phoneNotOccupied);

        const peer = await resolve(String(id), client);

        expect(peer).toEqual({
          inputPeer: {
            _: "inputPeerChannel",
            channelId: id,
            accessHash: toLong(777),
          },
          name: title,
        });
        expect(call).not.toHaveBeenCalled();
      },
    );

    it("rejects a bare ID that names a cached group and a cached channel", async () => {
      cacheChat("-4242", "group", "Book Club");
      cacheChat("-1000000004242", "channel", "Example News", "2222");
      const { call, client } = throwingClient();

      const failure = resolve("4242", client);

      await expect(failure).rejects.toBeInstanceOf(AmbiguousPeerError);
      await expect(failure).rejects.toMatchObject({
        identifier: "4242",
        candidates: [-4242, -1000000004242],
      });
      expect(call).not.toHaveBeenCalled();
    });
  });

  describe("bare numbers", () => {
    it("resolves a cached 10-digit user ID without a phone lookup", async () => {
      usersCache.upsert({
        user_id: "1234567890",
        first_name: "Alice",
        last_name: "Able",
        access_hash: "3333",
        fetched_at: Date.now(),
        raw_json: "{}",
      });
      const { call, client } = throwingClient();

      const peer = await resolve("1234567890", client);

      expect(peer).toEqual({
        inputPeer: {
          _: "inputPeerUser",
          userId: 1234567890,
          accessHash: toLong("3333"),
        },
        name: "Alice Able",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it.each([12, 7_000_000_001])(
      "resolves %p as a user when only its private chat is cached",
      async (userId) => {
        cacheMessage(userId);
        const { call, client } = throwingClient();

        const peer = await resolve(String(userId), client);

        expect(peer).toEqual({
          inputPeer: { _: "inputPeerUser", userId, accessHash: toLong(0) },
          name: `User ${userId}`,
        });
        expect(call).not.toHaveBeenCalled();
      },
    );

    it("resolves a cached user without an access hash as a user, not a group", async () => {
      usersCache.upsert({
        user_id: "11",
        first_name: "Bob",
        last_name: "Baker",
        fetched_at: Date.now(),
        raw_json: "{}",
      });
      const { call, client } = throwingClient();

      const peer = await resolve("11", client);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerUser", userId: 11, accessHash: toLong(0) },
        name: "Bob Baker",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty cache", () => {}],
      ["messages cached only in group -4242", () => cacheMessage(-4242)],
    ])(
      "takes an unknown positive ID as a user and -N as the basic group, with %s",
      async (_name, seed) => {
        seed();
        const { call, client } = throwingClient();

        const user = await resolve("4242", client);
        const group = await resolve("-4242", client);

        expect(user).toEqual({
          inputPeer: {
            _: "inputPeerUser",
            userId: 4242,
            accessHash: toLong(0),
          },
          name: "User 4242",
        });
        expect(group.inputPeer).toEqual({ _: "inputPeerChat", chatId: 4242 });
        expect(call).not.toHaveBeenCalled();
      },
    );

    it.each(["-12.5", "1e1", "0x10", "12.0", "", "0", "-0", "+1e5"])(
      "rejects the malformed number %p without an API call",
      async (identifier) => {
        cacheChat("12", "private", "Alice Able", "1111");
        const { call, client } = throwingClient();

        const failure = resolve(identifier, client);

        await expect(failure).rejects.toBeInstanceOf(InvalidPeerError);
        await expect(failure).rejects.toThrow(`Invalid peer identifier: ${identifier}`);
        expect(call).not.toHaveBeenCalled();
      },
    );

    it("still looks up an uncached 10-digit number as a phone", async () => {
      const { call, client } = throwingClient(phoneNotOccupied);

      await expect(resolve("5550000000", client)).rejects.toThrow(
        "Could not resolve phone number 5550000000",
      );
      expect(call).toHaveBeenCalledTimes(1);
      expect(call.mock.calls[0]?.[0]).toEqual({
        _: "contacts.resolvePhone",
        phone: "5550000000",
      });
    });

    it("always takes the phone path for a number with +", async () => {
      cacheChat("15550000000", "private", "Bob Baker", "4444");
      const { call, client } = throwingClient(phoneNotOccupied);

      await expect(resolve("+15550000000", client)).rejects.toThrow(
        "Could not resolve phone number +15550000000",
      );
      expect(call.mock.calls[0]?.[0]).toEqual({
        _: "contacts.resolvePhone",
        phone: "15550000000",
      });
    });

    it.each(["+1 (555) 000-0000", "+1-555-000-0000", "+1 555 000 0000"])(
      "looks up %p as a phone number, not a username",
      async (identifier) => {
        const { call, client } = throwingClient(phoneNotOccupied);

        await expect(resolve(identifier, client)).rejects.toThrow(
          `Could not resolve phone number ${identifier}`,
        );
        expect(call).toHaveBeenCalledTimes(1);
        expect(call.mock.calls[0]?.[0]).toEqual({
          _: "contacts.resolvePhone",
          phone: "15550000000",
        });
      },
    );

    it("resolves a cached phone number in any format without an API call", async () => {
      cacheUser({
        user_id: "10",
        first_name: "Alice",
        last_name: "Able",
        phone: "15550000000",
        access_hash: "1111",
      });
      const { call, client } = throwingClient();

      const peer = await resolve("+1 (555) 000-0000", client);

      expect(peer).toEqual({
        inputPeer: { _: "inputPeerUser", userId: 10, accessHash: toLong("1111") },
        name: "Alice Able",
      });
      expect(call).not.toHaveBeenCalled();
    });

    it("asks Telegram for a phone whose cached user has no access hash", async () => {
      cacheUser({ user_id: "10", first_name: "Alice", phone: "15550000000" });
      const { call, client } = throwingClient(phoneNotOccupied);

      await expect(resolve("+15550000000", client)).rejects.toThrow(
        "Could not resolve phone number +15550000000",
      );
      expect(call).toHaveBeenCalledTimes(1);
    });

    it.each(["+", "+alice", "+1 555 abc"])(
      "rejects %p, which has no phone number after +",
      async (identifier) => {
        const { call, client } = throwingClient();

        await expect(resolve(identifier, client)).rejects.toBeInstanceOf(InvalidPeerError);
        expect(call).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["@alice", { _: "contacts.resolveUsername", username: "alice" }],
      ["+15550000000", { _: "contacts.resolvePhone", phone: "15550000000" }],
    ])(
      "resolves %p through Telegram and caches the user, so its ID hits the cache next",
      async (identifier, lookup) => {
        const alice: tl.RawUser = {
          _: "user",
          id: 10,
          firstName: "Alice",
          lastName: "Able",
          username: "alice",
          phone: "15550000000",
          accessHash: toLong("1111"),
        };
        const call = mock(async (_request: unknown) => resolvedPeer([alice]));
        const client = { call } as unknown as Pick<TelegramClient, "call">;

        const resolved = await resolve(identifier, client);
        const byId = await resolve("10", throwingClient().client);

        expect(call.mock.calls).toEqual([[lookup]]);
        expect(resolved).toEqual(byId);
        expect(byId).toEqual({
          inputPeer: {
            _: "inputPeerUser",
            userId: 10,
            accessHash: toLong("1111"),
          },
          name: "Alice Able",
        });
      },
    );

    it("does not cache a min user", async () => {
      const call = mock(async () =>
        resolvedPeer([{ _: "user", id: 10, min: true, firstName: "Alice" } as tl.RawUser]),
      );

      await resolve("@alice", { call } as unknown as Pick<TelegramClient, "call">);

      expect(usersCache.getById("10")).toBeNull();
    });

    it.each([
      [
        "missing credentials",
        () => new ConfigError("TELEGRAM_API_ID environment variable is required", []),
      ],
      ["a blocked method", () => new RateLimitError("contacts.resolvePhone", 30)],
      ["a FLOOD_WAIT", () => new tl.RpcError(420, "FLOOD_WAIT_30")],
      ["a lost connection", () => new Error("Connection closed")],
    ])("passes on %s from the phone lookup", async (_name, failure) => {
      const { client } = throwingClient(failure);

      await expect(resolve("+15550000000", client)).rejects.toThrow(failure().message);
    });
  });
});
