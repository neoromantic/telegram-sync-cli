import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { Chat, type TelegramClient, type tl } from "@mtcute/bun";

import {
  dialogToCacheInput,
  rawChatToCacheInput,
  rawPeerToCacheInput,
  userToPrivateChatCacheInput,
} from "./chats/helpers";
import { fetchChatsFromApi } from "./chats/list";
import { type ChatsCache, createChatsCache } from "../db/chats-cache";
import { toLong } from "../utils/long";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { communityDialog, fakeDialog, fakeRawCommunity } from "../test/fake-dialogs.test-utils";

describe("fetchChatsFromApi", () => {
  let db: Database;
  let chatsCache: ChatsCache;

  beforeEach(() => {
    db = createAccountCacheDb();
    chatsCache = createChatsCache(db);
  });

  let withParams: unknown[] = [];

  function apiClient(communities: () => Promise<Chat[]>) {
    withParams = [];
    return {
      async *iterDialogs() {
        yield fakeDialog({ kind: "user", id: 1001, topMessage: 5 });
      },
      withParams(params: unknown) {
        withParams.push(params);
        return { getJoinedCommunities: communities };
      },
    } as unknown as Pick<TelegramClient, "iterDialogs" | "withParams">;
  }

  it("caches joined communities next to dialogs", async () => {
    const client = apiClient(async () => [
      new Chat(fakeRawCommunity({ id: 5555555555, accessHash: "777" })),
    ]);

    const rows = await fetchChatsFromApi(client, db);

    expect(rows.map((row) => [row.chat_id, row.type])).toEqual([
      ["1001", "private"],
      ["-1005555555555", "community"],
    ]);
    expect(chatsCache.list({ type: "community" })).toMatchObject([
      { chat_id: "-1005555555555", access_hash: "777" },
    ]);
    expect(withParams).toEqual([{ floodSleepThreshold: 0 }]);
  });

  it("still caches the dialogs when the communities request fails", async () => {
    const client = apiClient(async () => {
      throw new Error("RPC_CALL_FAIL");
    });

    const rows = await fetchChatsFromApi(client, db);

    expect(rows.map((row) => row.chat_id)).toEqual(["1001"]);
    expect(chatsCache.getById("1001")).not.toBeNull();
    expect(chatsCache.list({ type: "community" })).toEqual([]);
  });
});

describe("Chat cache rows", () => {
  it("stores each dialog under its marked peer ID", () => {
    const rows = [
      fakeDialog({ kind: "user", id: 1001, title: "John Doe" }),
      fakeDialog({ kind: "group", id: 4001, title: "My Group" }),
      fakeDialog({
        kind: "supergroup",
        id: 1234567890,
        title: "Big Community",
        username: "bigcommunity",
        membersCount: 10000,
      }),
      fakeDialog({ kind: "channel", id: 9876543210, title: "News Channel" }),
    ].map(dialogToCacheInput);

    expect(
      rows.map(({ chat_id, type, title, access_hash }) => ({
        chat_id,
        type,
        title,
        access_hash,
      })),
    ).toEqual([
      {
        chat_id: "1001",
        type: "private",
        title: "John Doe",
        access_hash: "777",
      },
      { chat_id: "-4001", type: "group", title: "My Group", access_hash: null },
      {
        chat_id: "-1001234567890",
        type: "supergroup",
        title: "Big Community",
        access_hash: "777",
      },
      {
        chat_id: "-1009876543210",
        type: "channel",
        title: "News Channel",
        access_hash: "777",
      },
    ]);
  });

  it("stores a raw chat or user under its marked peer ID, forbidden or not", () => {
    const base = { photo: { _: "chatPhotoEmpty" }, date: 1_700_000_000 };
    const user: tl.RawUser = {
      _: "user",
      id: 1001,
      firstName: "John",
      accessHash: toLong("777"),
    };
    const group = {
      ...base,
      _: "chat",
      id: 4001,
      title: "My Group",
      participantsCount: 5,
      version: 1,
    } as tl.RawChat;
    const supergroup = {
      ...base,
      _: "channel",
      id: 1234567890,
      title: "Big Community",
      megagroup: true,
      accessHash: toLong("888"),
    } as tl.RawChannel;

    expect(userToPrivateChatCacheInput(user).chat_id).toBe("1001");
    expect(rawChatToCacheInput(group)).toMatchObject({
      chat_id: "-4001",
      type: "group",
    });
    expect(rawChatToCacheInput(supergroup)).toMatchObject({
      chat_id: "-1001234567890",
      type: "supergroup",
      access_hash: "888",
    });
    expect(rawPeerToCacheInput(supergroup)?.chat_id).toBe("-1001234567890");
    expect(rawPeerToCacheInput(user)?.chat_id).toBe("1001");
    expect(rawChatToCacheInput({ _: "chatForbidden", id: 4001, title: "Old Group" }).chat_id).toBe(
      "-4001",
    );
    expect(
      rawChatToCacheInput({
        _: "channelForbidden",
        id: 1234567890,
        accessHash: toLong("888"),
        title: "Old Channel",
      }),
    ).toMatchObject({ chat_id: "-1001234567890", access_hash: "888" });
  });

  const community: tl.RawCommunity = {
    _: "community",
    id: 5555555556,
    accessHash: toLong("888"),
    title: "Example Community",
    photo: { _: "chatPhotoEmpty" },
    date: 1_700_000_000,
  };

  it("stores a community dialog as a community with its access hash", () => {
    expect(
      dialogToCacheInput(communityDialog({ id: 5555555555, accessHash: "777" })),
    ).toMatchObject({
      chat_id: "-1005555555555",
      type: "community",
      title: "Example Community",
      access_hash: "777",
      username: null,
      member_count: null,
    });
  });

  it("stores a raw community as a community with its access hash, forbidden or not", () => {
    expect(rawChatToCacheInput(community)).toMatchObject({
      chat_id: "-1005555555556",
      type: "community",
      access_hash: "888",
    });
    expect(
      rawChatToCacheInput({
        _: "communityForbidden",
        id: 5555555557,
        accessHash: toLong("889"),
        title: "Example Community",
      }),
    ).toMatchObject({
      chat_id: "-1005555555557",
      type: "community",
      access_hash: "889",
    });
    expect(
      rawChatToCacheInput({
        _: "communityForbidden",
        id: 5555555558,
        title: "Example Community",
      }),
    ).toMatchObject({
      chat_id: "-1005555555558",
      type: "community",
      access_hash: null,
    });
  });

  it("caches a live community but skips a min one", () => {
    expect(rawPeerToCacheInput(community)).toMatchObject({
      chat_id: "-1005555555556",
      type: "community",
      access_hash: "888",
    });
    expect(rawPeerToCacheInput({ ...community, min: true })).toBeNull();
  });
});
