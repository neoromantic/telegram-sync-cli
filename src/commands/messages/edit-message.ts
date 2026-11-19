import type { Database } from "bun:sqlite";
import { type TelegramClient, tl } from "@mtcute/bun";

import { getErrorMessage } from "../../daemon/daemon-utils";
import { fetchMessagesByIdRaw, parseRawMessage } from "../../daemon/sync-worker-real-helpers";
import { createMessagesCache } from "../../db/messages-cache";
import { createMessagesHistory } from "../../db/messages-history";
import type { MessageSearchItem } from "../../types";
import { verbose } from "../../utils/output";
import { toPeerIdFromRawPeer } from "../../utils/telegram-peer-ids";
import { type RichFormat, richErrorHints, richMessage } from "../send/rich-message";
import { messageRowsToItems } from "./helpers";
import { type HistoryChat, withPeerHint } from "./history";

type CallClient = Pick<TelegramClient, "call">;

const REFUSALS: Record<string, (messageId: number) => string> = {
  MESSAGE_NOT_MODIFIED: (id) => `Message ${id} already has this text`,
  MESSAGE_ID_INVALID: (id) => `Telegram has no message ${id} in this chat that can be edited`,
  MESSAGE_AUTHOR_REQUIRED: (id) => `You can't edit message ${id}: it was sent by someone else`,
  MESSAGE_EDIT_TIME_EXPIRED: (id) =>
    `Message ${id} is too old: Telegram no longer allows editing it`,
  MESSAGE_TOO_LONG: () => "The text is too long for a message",
  MEDIA_CAPTION_TOO_LONG: () => "The text is too long for the caption of a media message",
  CHAT_WRITE_FORBIDDEN: () => "You do not have permission to edit messages in this chat",
  CHAT_ADMIN_REQUIRED: () => "You do not have permission to edit messages in this chat",
};

/** Telegram refused the edit for a reason the caller can act on */
export class EditRefusedError extends Error {
  readonly details: { chatId: number; messageId: number; telegramError: string };
  readonly suggestion?: string;

  constructor(
    message: string,
    chatId: number,
    messageId: number,
    telegramError: string,
    suggestion?: string,
  ) {
    super(message);
    this.name = "EditRefusedError";
    this.details = { chatId, messageId, telegramError };
    this.suggestion = suggestion;
  }
}

/** Telegram accepts a rich edit of a message with an attachment, then drops the rich text and the old caption */
export class RichCaptionError extends Error {
  readonly details: { chatId: number; messageId: number };

  constructor(chatId: number, messageId: number) {
    super(`Message ${messageId} has an attachment: its caption can only be plain text`);
    this.name = "RichCaptionError";
    this.details = { chatId, messageId };
  }
}

async function hasAttachment(client: CallClient, chat: HistoryChat, messageId: number) {
  const { messages } = await fetchMessagesByIdRaw(client, chat.inputPeer, [messageId]);
  return (messages as tl.TypeMessage[]).some((message) => {
    if (message._ !== "message" || message.id !== messageId) return false;
    if (toPeerIdFromRawPeer(message.peerId) !== chat.chatId) return false;
    const media = message.media?._;
    return media !== undefined && media !== "messageMediaEmpty" && media !== "messageMediaWebPage";
  });
}

/** Plain text carries no entities, so Telegram drops the old formatting; a format replaces the message with a rich one */
export function editMessageRequest(
  inputPeer: tl.TypeInputPeer,
  messageId: number,
  text: string,
  format: RichFormat | null = null,
) {
  return {
    _: "messages.editMessage",
    peer: inputPeer,
    id: messageId,
    ...(format ? { richMessage: richMessage(text, format) } : { message: text }),
  } satisfies tl.messages.RawEditMessageRequest;
}

function editedMessage(result: tl.TypeUpdates, chatId: number, messageId: number) {
  if (!("updates" in result)) return null;
  for (const update of result.updates) {
    if (
      (update._ === "updateEditMessage" || update._ === "updateEditChannelMessage") &&
      update.message.id === messageId &&
      update.message._ !== "messageEmpty" &&
      toPeerIdFromRawPeer(update.message.peerId) === chatId
    ) {
      return update.message;
    }
  }
  return null;
}

function cacheEditedMessage(
  cacheDb: Database,
  chatId: number,
  messageId: number,
  result: tl.TypeUpdates,
) {
  try {
    const message = editedMessage(result, chatId, messageId);
    const input = message ? parseRawMessage(message, chatId) : null;
    if (!input) {
      verbose(`Edited message not cached: no message in ${result._}`);
      return null;
    }
    createMessagesCache(cacheDb).upsert(input);
    const row = createMessagesHistory(cacheDb).get(chatId, messageId);
    return messageRowsToItems(cacheDb, row ? [row] : [])[0] ?? null;
  } catch (err) {
    verbose(`Could not cache the edited message: ${getErrorMessage(err)}`);
    return null;
  }
}

export interface EditMessageResult {
  chatId: number;
  messageId: number;
  edited: true;
  /** How the new text was sent: markdown or html for a rich message, null for plain text */
  format: RichFormat | null;
  /**
   * The message after the edit, as `tg messages get` prints it; null when
   * it could not be stored in the cache
   */
  message: MessageSearchItem | null;
}

/**
 * Replace the text of a message (the caption, for a message with a file)
 * and store the edited message in the cache
 */
export async function editMessage(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  messageId: number,
  text: string,
  format: RichFormat | null = null,
) {
  let result: tl.TypeUpdates;
  try {
    if (format && (await hasAttachment(client, chat, messageId))) {
      throw new RichCaptionError(chat.chatId, messageId);
    }
    result = await client.call(editMessageRequest(chat.inputPeer, messageId, text, format));
  } catch (err) {
    if (tl.RpcError.is(err)) {
      if (format && err.text.startsWith("RICH_MESSAGE_")) {
        throw new EditRefusedError(
          err.message,
          chat.chatId,
          messageId,
          err.text,
          richErrorHints[err.text],
        );
      }
      const refusal = REFUSALS[err.text];
      if (refusal) {
        throw new EditRefusedError(refusal(messageId), chat.chatId, messageId, err.text);
      }
    }
    throw withPeerHint(err);
  }
  return {
    chatId: chat.chatId,
    messageId,
    edited: true,
    format,
    message: cacheEditedMessage(cacheDb, chat.chatId, messageId, result),
  } satisfies EditMessageResult;
}
