import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import Long from "long";

import { buildApiRequest } from "./api";
import { createDmLookup, resolvePeer } from "./send/peer-resolver";
import { createChatsCache } from "../db/chats-cache";
import { createUsersCache } from "../db/users-cache";
import { toLong } from "../utils/long";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

describe("buildApiRequest", () => {
  let db: Database;
  let call: ReturnType<typeof mock>;

  beforeEach(() => {
    db = createAccountCacheDb();
    createUsersCache(db).upsert({
      user_id: "1001",
      username: "alice",
      first_name: "Alice",
      last_name: null,
      phone: "15550001001",
      access_hash: "5555",
      is_contact: 1,
      is_bot: 0,
      is_premium: 0,
      fetched_at: Date.now(),
      raw_json: "{}",
    });
    call = mock(async (request: { _: string }) => {
      if (request._ !== "contacts.resolveUsername") {
        throw new Error(`unexpected API call ${request._}`);
      }
      return {
        _: "contacts.resolvedPeer",
        peer: { _: "peerUser", userId: 2002 },
        users: [{ _: "user", id: 2002, accessHash: toLong("7777") }],
        chats: [],
      };
    });
  });

  function build(method: string, params: Record<string, unknown>) {
    const client = { call } as unknown as Pick<TelegramClient, "call">;
    return buildApiRequest(method, params, async (id) => {
      const peer = await resolvePeer(
        client,
        id,
        createUsersCache(db),
        createChatsCache(db),
        createDmLookup(db),
      );
      return peer.inputPeer;
    });
  }

  it("messages.sendMessage resolves @user through Telegram and adds a random ID", async () => {
    const request = (await build("messages.sendMessage", {
      peer: "@user",
      message: "Hi",
    })) as unknown as Record<string, unknown>;

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toMatchObject({
      _: "contacts.resolveUsername",
      username: "user",
    });
    const { randomId, ...rest } = request;
    expect(rest).toEqual({
      _: "messages.sendMessage",
      peer: { _: "inputPeerUser", userId: 2002, accessHash: toLong("7777") },
      message: "Hi",
    });
    expect(Long.isLong(randomId)).toBe(true);
  });

  it("keeps a randomId the caller gives, as a Long", async () => {
    const request = (await build("messages.sendMessage", {
      peer: "me",
      message: "Hi",
      randomId: "9007199254740993",
    })) as unknown as Record<string, unknown>;

    expect(request.randomId).toEqual(toLong("9007199254740993"));
  });

  it("turns users.getFullUser --id into an InputUser", async () => {
    expect(await build("users.getFullUser", { id: 1001 })).toEqual({
      _: "users.getFullUser",
      id: { _: "inputUser", userId: 1001, accessHash: toLong("5555") },
    } as never);
    expect(await build("users.getFullUser", { id: "me" })).toEqual({
      _: "users.getFullUser",
      id: { _: "inputUserSelf" },
    } as never);
  });

  it("turns a marked channel ID into an InputChannel", async () => {
    expect(await build("channels.getFullChannel", { channel: -1001234567890 })).toEqual({
      _: "channels.getFullChannel",
      channel: {
        _: "inputChannel",
        channelId: 1234567890,
        accessHash: toLong(0),
      },
    } as never);
  });

  it("resolves every chat of a vector", async () => {
    expect(await build("users.getUsers", { id: ["me", "@alice"] })).toEqual({
      _: "users.getUsers",
      id: [{ _: "inputUserSelf" }, { _: "inputUser", userId: 1001, accessHash: toLong("5555") }],
    } as never);
  });

  it("gives messages.getDialogs an empty offset peer", async () => {
    expect(await build("messages.getDialogs", { limit: 5 })).toEqual({
      _: "messages.getDialogs",
      limit: 5,
      offsetDate: 0,
      offsetId: 0,
      offsetPeer: { _: "inputPeerEmpty" },
      hash: toLong(0),
    } as never);
  });

  it("leaves optional fields out and strings that are no long as given", async () => {
    expect(
      await build("contacts.getTopPeers", {
        correspondents: true,
        hash: "abc",
      }),
    ).toEqual({
      _: "contacts.getTopPeers",
      correspondents: true,
      offset: 0,
      limit: 0,
      hash: "abc",
    } as never);
  });

  it("leaves a required vector out", async () => {
    expect(await build("messages.getMessages", {})).toEqual({
      _: "messages.getMessages",
    } as never);
  });

  it("sends a method the schema does not know as given", async () => {
    expect(await build("messages.noSuchMethod", { peer: "me" })).toEqual({
      _: "messages.noSuchMethod",
      peer: "me",
    } as never);
  });
});
