import { describe, expect, it } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";

import type { HistoryChat } from "./history";
import { PinRefusedError, pinMessage, updatePinnedMessageRequest } from "./pin-message";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { toLong } from "../../utils/long";

const ALICE: HistoryChat = {
  chatId: 10,
  inputPeer: { _: "inputPeerUser", userId: 10, accessHash: toLong(7) },
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

describe("updatePinnedMessageRequest", () => {
  const base = {
    _: "messages.updatePinnedMessage",
    peer: ALICE.inputPeer,
    id: 12,
  } as const;

  it("pins with a notification unless silent", () => {
    expect(updatePinnedMessageRequest(ALICE.inputPeer, 12, { pin: true })).toEqual(base);
    expect(
      updatePinnedMessageRequest(ALICE.inputPeer, 12, {
        pin: true,
        silent: true,
      }),
    ).toEqual({ ...base, silent: true });
  });

  it("unpins without the silent flag, which only applies to a pin", () => {
    expect(
      updatePinnedMessageRequest(ALICE.inputPeer, 12, {
        pin: false,
        silent: true,
      }),
    ).toEqual({ ...base, unpin: true });
  });
});

describe("pinMessage", () => {
  it.each([
    ["MESSAGE_ID_INVALID", 400, true, "Telegram has no message 12 in this chat that can be pinned"],
    [
      "MESSAGE_ID_INVALID",
      400,
      false,
      "Telegram has no message 12 in this chat that can be unpinned",
    ],
    ["PIN_RESTRICTED", 400, true, "You do not have permission to pin messages in this chat"],
    [
      "CHAT_ADMIN_REQUIRED",
      400,
      false,
      "You do not have permission to unpin messages in this chat",
    ],
    ["CHAT_WRITE_FORBIDDEN", 403, true, "You do not have permission to pin messages in this chat"],
    [
      "USER_BANNED_IN_CHANNEL",
      400,
      true,
      "You do not have permission to pin messages in this chat",
    ],
  ])(
    "turns %s (pin: %s) into a refusal that says what is wrong",
    async (name, code, pin, message) => {
      const err = await pinMessage(refusing(code, name), createAccountCacheDb(), ALICE, 12, {
        pin,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PinRefusedError);
      expect((err as PinRefusedError).message).toBe(message);
      expect((err as PinRefusedError).details).toEqual({
        chatId: 10,
        messageId: 12,
        telegramError: name,
      });
    },
  );

  it("passes any other Telegram error on, with the hint for an unknown chat", async () => {
    await expect(
      pinMessage(refusing(400, "PEER_ID_INVALID"), createAccountCacheDb(), ALICE, 12, {
        pin: true,
      }),
    ).rejects.toThrow("tg chats list --fresh");
    await expect(
      pinMessage(refusing(500, "INTERNAL"), createAccountCacheDb(), ALICE, 12, { pin: true }),
    ).rejects.not.toBeInstanceOf(PinRefusedError);
  });

  it.each([true, false])(
    "counts a state Telegram says is unchanged as done (pin: %s)",
    async (pin) => {
      const result = await pinMessage(
        refusing(400, "CHAT_NOT_MODIFIED"),
        createAccountCacheDb(),
        ALICE,
        12,
        { pin },
      );

      expect(result).toEqual({ chatId: 10, messageId: 12, pinned: pin, message: null });
    },
  );
});
