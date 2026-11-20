import { describe, expect, it } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";

import {
  EditRefusedError,
  editMessage,
  editMessageRequest,
  RichCaptionError,
} from "./edit-message";
import type { HistoryChat } from "./history";
import { createMessagesHistory } from "../../db/messages-history";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { toLong } from "../../utils/long";

const ALICE: HistoryChat = {
  chatId: 10,
  inputPeer: { _: "inputPeerUser", userId: 10, accessHash: toLong(7) },
};

function clientThat(call: (request: { _: string }) => Promise<unknown>) {
  return { call } as unknown as TelegramClient;
}

function holding(message: object, edit: () => Promise<unknown>) {
  const methods: string[] = [];
  const client = clientThat(async (request) => {
    methods.push(request._);
    if (request._ !== "messages.getMessages") return edit();
    return {
      _: "messages.messages",
      messages: [{ _: "message", id: 12, peerId: { _: "peerUser", userId: 10 }, ...message }],
      chats: [],
      users: [],
    };
  });
  return { client, methods };
}

function rpcError(code: number, text: string) {
  return tl.RpcError.fromTl({ _: "rpc_error", errorCode: code, errorMessage: text });
}

function refusing(code: number, text: string) {
  return clientThat(async () => {
    throw rpcError(code, text);
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

  it.each([
    ["markdown", { _: "inputRichMessageMarkdown", markdown: "# Plan" }],
    ["html", { _: "inputRichMessageHTML", html: "# Plan" }],
  ] as const)("sends %s as a rich message in place of the text", (format, richMessage) => {
    expect(editMessageRequest(ALICE.inputPeer, 12, "# Plan", format)).toEqual({
      _: "messages.editMessage",
      peer: ALICE.inputPeer,
      id: 12,
      richMessage,
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

  it("turns a refused rich message into a refusal with what to change", async () => {
    const { client } = holding({ message: "Old text" }, async () => {
      throw rpcError(400, "RICH_MESSAGE_TABLE_COLS_TOO_MANY");
    });
    const attempt = editMessage(client, createAccountCacheDb(), ALICE, 12, "| a |", "markdown");

    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EditRefusedError);
    expect((err as EditRefusedError).details.telegramError).toBe(
      "RICH_MESSAGE_TABLE_COLS_TOO_MANY",
    );
    expect((err as EditRefusedError).suggestion).toBe("Use at most 20 table columns.");
  });

  it.each([
    ["a file", { _: "messageMediaDocument", document: { _: "document", attributes: [] } }],
    ["a photo that expired", { _: "messageMediaPhoto" }],
    ["media this version doesn't know", { _: "messageMediaUnsupported" }],
  ])("refuses a rich edit of a message with %s and sends nothing", async (_kind, media) => {
    const { client, methods } = holding({ message: "Notes from Monday", media }, async () => ({
      _: "updates",
      updates: [],
    }));

    const attempt = editMessage(client, createAccountCacheDb(), ALICE, 12, "# Notes", "markdown");

    const err = await attempt.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RichCaptionError);
    expect((err as RichCaptionError).details).toEqual({ chatId: 10, messageId: 12 });
    expect(methods).toEqual(["messages.getMessages"]);
  });

  it("makes a text message with a link preview rich", async () => {
    const { client, methods } = holding(
      { message: "example.com", media: { _: "messageMediaWebPage", webpage: { _: "webPage" } } },
      async () => ({ _: "updates", updates: [] }),
    );

    const result = await editMessage(client, createAccountCacheDb(), ALICE, 12, "# Hi", "markdown");

    expect(result.format).toBe("markdown");
    expect(methods).toEqual(["messages.getMessages", "messages.editMessage"]);
  });

  it.each([
    ["no message", []],
    [
      "the same ID in another chat",
      [
        {
          _: "updateEditMessage",
          message: {
            _: "message",
            id: 12,
            out: true,
            peerId: { _: "peerUser", userId: 11 },
            date: 1_760_000_000,
            editDate: 1_760_003_600,
            message: "Not this chat.",
          },
          pts: 1,
          ptsCount: 1,
        },
      ],
    ],
  ])("reports the edit without a message when the response holds %s", async (_what, updates) => {
    const db = createAccountCacheDb();
    const client = clientThat(async () => ({
      _: "updates",
      updates,
      users: [],
      chats: [],
      date: 1_760_003_600,
      seq: 0,
    }));

    expect(await editMessage(client, db, ALICE, 12, "Hi.")).toEqual({
      chatId: 10,
      messageId: 12,
      edited: true,
      format: null,
      message: null,
    });
    expect(createMessagesHistory(db).get(10, 12)).toBeNull();
  });
});
