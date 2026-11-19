import type { Database } from "bun:sqlite";
import { type TelegramClient, tl } from "@mtcute/bun";
import { isInputPeerChannel, toInputChannel } from "@mtcute/bun/utils.js";

import { getErrorMessage } from "../../daemon/daemon-utils";
import { createMessagesCache } from "../../db/messages-cache";
import { verbose } from "../../utils/output";
import { toPeerIdFromRawPeer } from "../../utils/telegram-peer-ids";
import { type HistoryChat, withPeerHint } from "./history";

type CallClient = Pick<TelegramClient, "call">;

/** Telegram deletes at most this many messages per call */
export const MAX_DELETE_IDS = 100;

const FORBIDDEN = "You do not have permission to delete these messages";

const REFUSALS: Record<string, string> = {
  MESSAGE_DELETE_FORBIDDEN:
    "Telegram refused to delete one of these messages, most likely a service message",
  MESSAGE_ID_INVALID: "One of these message IDs is invalid in this chat",
  MSG_ID_INVALID: "One of these message IDs is invalid in this chat",
  CHAT_ADMIN_REQUIRED: FORBIDDEN,
  CHANNEL_PRIVATE: "You are not a member of this chat",
};

/** Telegram refused the delete for a reason the caller can act on */
export class DeleteRefusedError extends Error {
  readonly details: {
    chatId: number;
    messageIds: number[];
    telegramError: string;
  };

  constructor(message: string, chatId: number, messageIds: number[], telegramError: string) {
    super(message);
    this.name = "DeleteRefusedError";
    this.details = { chatId, messageIds, telegramError };
  }
}

/** Some IDs name no message of the chat: nothing was deleted */
export class MessagesNotInChatError extends Error {
  readonly details: { chatId: number; missingIds: number[] };

  constructor(chatId: number, missingIds: number[]) {
    super(
      `Chat ${chatId} has no ${missingIds.length === 1 ? "message" : "messages"} ${missingIds.join(", ")}: nothing was deleted`,
    );
    this.name = "MessagesNotInChatError";
    this.details = { chatId, missingIds };
  }
}

/**
 * channels.deleteMessages for a channel or supergroup, which always deletes
 * for everyone; messages.deleteMessages for a private chat, a basic group
 * or Saved Messages
 */
export function deleteMessagesRequest(
  inputPeer: tl.TypeInputPeer,
  messageIds: number[],
  revoke: boolean,
) {
  if (isInputPeerChannel(inputPeer)) {
    return {
      _: "channels.deleteMessages",
      channel: toInputChannel(inputPeer),
      id: messageIds,
    } satisfies tl.channels.RawDeleteMessagesRequest;
  }
  return {
    _: "messages.deleteMessages",
    id: messageIds,
    revoke,
  } satisfies tl.messages.RawDeleteMessagesRequest;
}

async function fetchMessages(client: CallClient, chat: HistoryChat, messageIds: number[]) {
  const id = messageIds.map((messageId) => ({
    _: "inputMessageID" as const,
    id: messageId,
  }));
  const result = isInputPeerChannel(chat.inputPeer)
    ? await client.call({
        _: "channels.getMessages",
        channel: toInputChannel(chat.inputPeer),
        id,
      })
    : await client.call({ _: "messages.getMessages", id });
  return "messages" in result ? result.messages : [];
}

/** The IDs among `messageIds` that no returned message of the chat has */
export function idsOutsideChat(chatId: number, messageIds: number[], messages: tl.TypeMessage[]) {
  const inChat = new Set(
    messages
      .filter(
        (message) => message._ !== "messageEmpty" && toPeerIdFromRawPeer(message.peerId) === chatId,
      )
      .map((message) => message.id),
  );
  return messageIds.filter((id) => !inChat.has(id));
}

// WARNING: messages.deleteMessages names no chat, so an ID of another chat would be deleted there
async function checkIdsInChat(client: CallClient, chat: HistoryChat, messageIds: number[]) {
  const missing = idsOutsideChat(
    chat.chatId,
    messageIds,
    await fetchMessages(client, chat, messageIds),
  );
  if (missing.length > 0) {
    throw new MessagesNotInChatError(chat.chatId, missing);
  }
}

export interface DeleteMessagesResult {
  chatId: number;
  /** The IDs asked for, without duplicates */
  messageIds: number[];
  /** How many messages Telegram reports deleted (ptsCount) */
  deletedCount: number;
  /** Deleted for every member; always true in a channel or supergroup */
  forEveryone: boolean;
}

/**
 * Delete messages of a chat on Telegram and mark them deleted in the
 * cache. A delete can't be undone.
 */
export async function deleteMessages(
  client: CallClient,
  cacheDb: Database,
  chat: HistoryChat,
  messageIds: number[],
  revoke: boolean,
) {
  const request = deleteMessagesRequest(chat.inputPeer, messageIds, revoke);
  let affected: tl.messages.TypeAffectedMessages;
  try {
    if (request._ === "messages.deleteMessages") {
      await checkIdsInChat(client, chat, messageIds);
    }
    affected = await client.call(request);
  } catch (err) {
    if (tl.RpcError.is(err)) {
      const refusal = REFUSALS[err.text];
      if (refusal) {
        throw new DeleteRefusedError(refusal, chat.chatId, messageIds, err.text);
      }
    }
    throw withPeerHint(err);
  }

  try {
    const gone =
      affected.ptsCount === messageIds.length
        ? messageIds
        : idsOutsideChat(chat.chatId, messageIds, await fetchMessages(client, chat, messageIds));
    createMessagesCache(cacheDb).markDeleted(chat.chatId, gone);
  } catch (err) {
    verbose(`Could not mark the messages deleted: ${getErrorMessage(err)}`);
  }
  return {
    chatId: chat.chatId,
    messageIds,
    deletedCount: affected.ptsCount,
    forEveryone: request._ === "channels.deleteMessages" || revoke,
  } satisfies DeleteMessagesResult;
}
