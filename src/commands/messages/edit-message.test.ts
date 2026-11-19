import { describe, expect, it } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";

import { EditRefusedError, editMessage, editMessageRequest } from "./edit-message";
import type { HistoryChat } from "./history";
import { createMessagesHistory } from "../../db/messages-history";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { toLong } from "../../utils/long";

const ALICE: HistoryChat = {
  chatId: 10,
  inputPeer: { _: "inputPeerUser", userId: 10, accessHash: toLong(7) },
};

function clientThat(call: () => Promise<unknown>) {
  return { call } as unknown as TelegramClient;
}

function refusing(code: number, text: string) {
  return clientThat(async () => {
    throw tl.RpcError.fromTl({
      _: "rpc_error",
      errorCode: code,
      errorMessage: text,
    });
  });
}

describe("editMessageRequest", () => {
  it("sends the text alone, so Telegram stores it as plain text", () => {
    expect(editMessageRequest(ALICE.inputPeer, 12, "See you at ten.")).toEqual({
      _: "messages.editMessage",
      peer: ALICE.inputPeer,
      id: 12,
      message: "See you at ten.",
    });
  });
});

describe("editMessage", () => {
  it.each([
    ["MESSAGE_NOT_MODIFIED", 400, "Message 12 already has this text"],
    ["MESSAGE_ID_INVALID", 400, "Telegram has no message 12 in this chat that can be edited"],
    ["MESSAGE_AUTHOR_REQUIRED", 403, "You can't edit message 12: it was sent by someone else"],
    [
      "MESSAGE_EDIT_TIME_EXPIRED",
      400,
      "Message 12 is too old: Telegram no longer allows editing it",
    ],
    ["MESSAGE_TOO_LONG", 400, "The text is too long for a message"],
    ["MEDIA_CAPTION_TOO_LONG", 400, "The text is too long for the caption of a media message"],
    ["CHAT_WRITE_FORBIDDEN", 403, "You do not have permission to edit messages in this chat"],
    ["CHAT_ADMIN_REQUIRED", 400, "You do not have permission to edit messages in this chat"],
  ])("turns %s into a refusal that says what is wrong", async (name, code, message) => {
    const attempt = editMessage(refusing(code, name), createAccountCacheDb(), ALICE, 12, "Hi.");

    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditRefusedError);
    expect((err as EditRefusedError).message).toBe(message);
    expect((err as EditRefusedError).details).toEqual({
      chatId: 10,
      messageId: 12,
      telegramError: name,
    });
  });

  it("passes any other Telegram error on, with the hint for an unknown chat", async () => {
    await expect(
      editMessage(refusing(400, "PEER_ID_INVALID"), createAccountCacheDb(), ALICE, 12, "Hi."),
    ).rejects.toThrow("tg chats list --fresh");
    await expect(
      editMessage(refusing(500, "INTERNAL"), createAccountCacheDb(), ALICE, 12, "Hi."),
    ).rejects.not.toBeInstanceOf(EditRefusedError);
  });

  it("reports the edit without a message when the response holds none", async () => {
    const db = createAccountCacheDb();
    const client = clientThat(async () => ({
      _: "updates",
      updates: [],
      users: [],
      chats: [],
      date: 1_760_003_600,
      seq: 0,
    }));

    expect(await editMessage(client, db, ALICE, 12, "Hi.")).toEqual({
      chatId: 10,
      messageId: 12,
      edited: true,
      message: null,
    });
    expect(createMessagesHistory(db).get(10, 12)).toBeNull();
  });
});
