import { describe, expect, it, mock } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { DaemonStopError } from "./daemon-utils";
import {
  buildInputPeer,
  extractFloodWaitSeconds,
  fetchMessagesRaw,
  parseRawMessage,
} from "./sync-worker-real-helpers";
import { createChatsCache } from "../db/chats-cache";
import { toLong } from "../utils/long";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";

describe("buildInputPeer", () => {
  it("builds peers from the marked IDs and access hashes it cached, user N apart from basic group N", () => {
    const db = createAccountCacheDb();
    const chatsCache = createChatsCache(db);
    chatsCache.upsertMany(
      [
        fakeDialog({ kind: "user", id: 4001, title: "Alice" }),
        fakeDialog({ kind: "group", id: 4001, title: "Book Club" }),
        fakeDialog({ kind: "channel", id: 3, title: "Channel" }),
        fakeDialog({ kind: "supergroup", id: 1234567890, title: "Team" }),
      ].map(dialogToCacheInput),
    );

    expect(buildInputPeer(4001, chatsCache)).toEqual({
      _: "inputPeerUser",
      userId: 4001,
      accessHash: toLong(777),
    });
    expect(buildInputPeer(-4001, chatsCache)).toEqual({ _: "inputPeerChat", chatId: 4001 });
    expect(buildInputPeer(-1000000000003, chatsCache)).toEqual({
      _: "inputPeerChannel",
      channelId: 3,
      accessHash: toLong(777),
    });
    expect(buildInputPeer(-1001234567890, chatsCache)).toEqual({
      _: "inputPeerChannel",
      channelId: 1234567890,
      accessHash: toLong(777),
    });
    db.close();
  });

  it("builds an uncached user with hash 0 and an uncached basic group, but no uncached channel", () => {
    const db = createAccountCacheDb();
    const chatsCache = createChatsCache(db);

    expect(buildInputPeer(123, chatsCache)).toEqual({
      _: "inputPeerUser",
      userId: 123,
      accessHash: toLong(0),
    });
    expect(buildInputPeer(-42, chatsCache)).toEqual({ _: "inputPeerChat", chatId: 42 });
    expect(buildInputPeer(-1001234567890, chatsCache)).toBeNull();
    db.close();
  });
});

describe("extractFloodWaitSeconds", () => {
  it("takes the wait from error.seconds when the message has none", () => {
    const err = new Error("rate limit") as Error & { seconds?: number };
    err.seconds = 15;
    expect(extractFloodWaitSeconds(err)).toBe(15);
  });
});

describe("fetchMessagesRaw", () => {
  it("makes no request once the daemon is stopping", async () => {
    const call = mock(async () => ({ _: "messages.messages", messages: [], chats: [], users: [] }));
    const shutdown = new AbortController();
    shutdown.abort(new DaemonStopError());

    const error = await fetchMessagesRaw(
      { call } as unknown as TelegramClient,
      { _: "inputPeerUser", userId: 10, accessHash: toLong("1111") },
      { limit: 1 },
      shutdown.signal,
    ).catch((err: unknown) => err);

    expect(error).toBe(shutdown.signal.reason);
    expect(call).not.toHaveBeenCalled();
  });
});

describe("parseRawMessage", () => {
  it("maps forward_from_id for all peer types", () => {
    const base = {
      _: "message",
      id: 10,
      date: 1700000000,
      message: "Forwarded",
    };

    const fromUser = parseRawMessage(
      {
        ...base,
        fwdFrom: {
          _: "messageFwdHeader",
          fromId: { _: "peerUser", userId: 111 },
          date: 1699999999,
        },
      },
      1,
    );

    const fromChat = parseRawMessage(
      {
        ...base,
        id: 11,
        fwdFrom: {
          _: "messageFwdHeader",
          fromId: { _: "peerChat", chatId: 222 },
          date: 1699999998,
        },
      },
      1,
    );

    const fromChannel = parseRawMessage(
      {
        ...base,
        id: 12,
        fwdFrom: {
          _: "messageFwdHeader",
          fromId: { _: "peerChannel", channelId: 333 },
          date: 1699999997,
        },
      },
      1,
    );

    expect(fromUser?.forward_from_id).toBe(111);
    expect(fromChat?.forward_from_id).toBe(-222);
    expect(fromChannel?.forward_from_id).toBe(-1000000000333);
  });

  it("gives a sender its marked ID, and an incoming private message without fromId its user", () => {
    const page = [
      { _: "peerUser", userId: 111 },
      { _: "peerChat", chatId: 222 },
      { _: "peerChannel", channelId: 333 },
      undefined,
    ].map((fromId, index) =>
      parseRawMessage(
        {
          _: "message",
          id: 30 + index,
          peerId: { _: "peerChannel", channelId: 1234567890 },
          ...(fromId ? { fromId } : {}),
          date: 1700000000,
          message: "hello",
        },
        -1001234567890,
      ),
    );
    const direct = parseRawMessage(
      {
        _: "message",
        id: 40,
        peerId: { _: "peerUser", userId: 5550001 },
        date: 1700000000,
        message: "hi",
      },
      5550001,
    );

    expect(page.map((message) => message?.from_id)).toEqual([
      111, -222, -1000000000333, -1001234567890,
    ]);
    expect(direct?.from_id).toBe(5550001);
  });
});
