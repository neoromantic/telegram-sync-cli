import { describe, expect, it } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";

import {
  DeleteRefusedError,
  deleteMessages,
  deleteMessagesRequest,
  idsOutsideChat,
} from "./delete-messages";
import type { HistoryChat } from "./history";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { toLong } from "../../utils/long";

const ALICE: HistoryChat = {
  chatId: 10,
  inputPeer: { _: "inputPeerUser", userId: 10, accessHash: toLong(7) },
};

const TEAM: HistoryChat = {
  chatId: -1001234567890,
  inputPeer: {
    _: "inputPeerChannel",
    channelId: 1234567890,
    accessHash: toLong(8),
  },
};

function refusing(code: number, text: string) {
  return {
    call: async () => {
      throw tl.RpcError.fromTl({
        _: "rpc_error",
        errorCode: code,
        errorMessage: text,
      });
    },
  } as unknown as TelegramClient;
}

function rawMessage(id: number, peerId: tl.TypePeer) {
  return { _: "message", id, peerId, date: 1_760_000_000, message: "" } satisfies tl.RawMessage;
}

describe("deleteMessagesRequest", () => {
  it("deletes in a private chat, basic group or Saved Messages without naming the chat", () => {
    for (const inputPeer of [
      ALICE.inputPeer,
      { _: "inputPeerChat", chatId: 4242 } as const,
      { _: "inputPeerSelf" } as const,
    ]) {
      expect(deleteMessagesRequest(inputPeer, [12, 13], true)).toEqual({
        _: "messages.deleteMessages",
        id: [12, 13],
        revoke: true,
      });
    }
  });

  it("deletes in a channel or supergroup through the channel, with no revoke flag", () => {
    expect(deleteMessagesRequest(TEAM.inputPeer, [25], false)).toEqual({
      _: "channels.deleteMessages",
      channel: {
        _: "inputChannel",
        channelId: 1234567890,
        accessHash: toLong(8),
      },
      id: [25],
    });

    const fromMessage: tl.TypeInputPeer = {
      _: "inputPeerChannelFromMessage",
      peer: ALICE.inputPeer,
      msgId: 5,
      channelId: 1234567890,
    };
    expect(deleteMessagesRequest(fromMessage, [25], false)).toEqual({
      _: "channels.deleteMessages",
      channel: {
        _: "inputChannelFromMessage",
        peer: ALICE.inputPeer,
        msgId: 5,
        channelId: 1234567890,
      },
      id: [25],
    });
  });
});

describe("idsOutsideChat", () => {
  it("keeps only IDs whose message is in the chat, by marked peer ID", () => {
    const messages: tl.TypeMessage[] = [
      rawMessage(12, { _: "peerUser", userId: 10 }),
      rawMessage(13, { _: "peerUser", userId: 20 }),
      rawMessage(14, { _: "peerChat", chatId: 10 }),
      { _: "messageEmpty", id: 15 },
    ];

    expect(idsOutsideChat(10, [12, 13, 14, 15, 16], messages)).toEqual([13, 14, 15, 16]);
    expect(idsOutsideChat(-10, [14], messages)).toEqual([]);
  });
});

describe("deleteMessages", () => {
  it.each([
    [
      "MESSAGE_DELETE_FORBIDDEN",
      403,
      "Telegram refused to delete one of these messages, most likely a service message",
    ],
    ["MESSAGE_ID_INVALID", 400, "One of these message IDs is invalid in this chat"],
    ["MSG_ID_INVALID", 400, "One of these message IDs is invalid in this chat"],
    ["CHAT_ADMIN_REQUIRED", 400, "You do not have permission to delete these messages"],
    ["CHANNEL_PRIVATE", 406, "You are not a member of this chat"],
  ])("turns %s into a refusal that says what is wrong", async (name, code, message) => {
    const err = await deleteMessages(
      refusing(code, name),
      createAccountCacheDb(),
      TEAM,
      [25, 26],
      false,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DeleteRefusedError);
    expect((err as DeleteRefusedError).message).toBe(message);
    expect((err as DeleteRefusedError).details).toEqual({
      chatId: TEAM.chatId,
      messageIds: [25, 26],
      telegramError: name,
    });
  });

  it("passes any other Telegram error on, with the hint for an unknown chat", async () => {
    await expect(
      deleteMessages(refusing(400, "CHANNEL_INVALID"), createAccountCacheDb(), TEAM, [25], false),
    ).rejects.toThrow("tg chats list --fresh");
    await expect(
      deleteMessages(refusing(500, "INTERNAL"), createAccountCacheDb(), ALICE, [12], false),
    ).rejects.not.toBeInstanceOf(DeleteRefusedError);
  });
});
