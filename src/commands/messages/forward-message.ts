import type { Database } from "bun:sqlite";
import type { TelegramClient, tl } from "@mtcute/bun";

import { getErrorMessage } from "../../daemon/daemon-utils";
import { createMessagesCache } from "../../db/messages-cache";
import { createMessagesHistory } from "../../db/messages-history";
import type { MessageSearchItem } from "../../types";
import { toLong } from "../../utils/long";
import { verbose } from "../../utils/output";
import { newMessageInputs } from "../send/sent-message-cache";
import { messageRowsToItems } from "./helpers";
import { type HistoryChat, withPeerHint } from "./history";

type CallClient = Pick<TelegramClient, "call">;

/** Telegram takes at most this many message IDs per messages.forwardMessages */
export const MAX_FORWARD_IDS = 100;

const NO_SOURCE_MESSAGE = "Telegram has no message with this ID in the source chat";
const NO_PERMISSION = "You do not have permission to post in the target chat";

const REFUSALS: Record<string, string> = {
  CHAT_FORWARDS_RESTRICTED:
    "The source chat protects its content: Telegram does not allow forwarding from it",
  MESSAGE_ID_INVALID: NO_SOURCE_MESSAGE,
  MSG_ID_INVALID: NO_SOURCE_MESSAGE,
  MESSAGE_IDS_EMPTY: "Telegram found none of these messages in the source chat",
  CHAT_WRITE_FORBIDDEN: NO_PERMISSION,
  CHAT_ADMIN_REQUIRED: NO_PERMISSION,
  CHAT_RESTRICTED: NO_PERMISSION,
  CHAT_GUEST_SEND_FORBIDDEN: NO_PERMISSION,
  USER_BANNED_IN_CHANNEL: NO_PERMISSION,
  CHANNEL_PRIVATE: "You are not a member of one of these chats",
  USER_IS_BLOCKED: "The recipient has blocked you",
  YOU_BLOCKED_USER: "You blocked the recipient: unblock them to forward to them",
  PEER_ID_INVALID:
    "Telegram does not know one of these chats: run tg chats list --fresh or pass the @username",
  SLOWMODE_MULTI_MSGS_DISABLED:
    "Slow mode in the target chat allows forwarding only one message at a time",
};

const SEND_KIND_FORBIDDEN = /^CHAT_SEND_(\w+)_FORBIDDEN$/;

function refusalMessage(telegramError: string) {
  const refusal = REFUSALS[telegramError];
  if (refusal) return refusal;
  const kind = SEND_KIND_FORBIDDEN.exec(telegramError)?.[1];
  return kind
    ? `The target chat does not allow this kind of message (${kind.toLowerCase()})`
    : undefined;
}

export interface ForwardRefusalDetails {
  fromChatId: number;
  toChatId: number;
  messageIds: number[];
  telegramError: string;
}

/** Telegram refused the forward for a reason the caller can act on */
export class ForwardRefusedError extends Error {
  readonly details: ForwardRefusalDetails;

  constructor(message: string, details: ForwardRefusalDetails) {
    super(message);
    this.name = "ForwardRefusedError";
    this.details = details;
  }
}

/** One fresh random ID per message, so the response pairs each copy back */
export function forwardMessagesRequest(
  from: tl.TypeInputPeer,
  to: tl.TypeInputPeer,
  messageIds: number[],
) {
  return {
    _: "messages.forwardMessages",
    fromPeer: from,
    toPeer: to,
    id: messageIds,
    randomId: messageIds.map(() =>
      toLong(BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))),
    ),
  } satisfies tl.messages.RawForwardMessagesRequest;
}

/**
 * The new ID of each forwarded message, in the order of `request.id`: the
 * response's updateMessageID maps the random ID sent with a message to its
 * new ID. Null for a message the response has no updateMessageID for.
 */
export function pairForwardedIds(
  request: Pick<tl.messages.RawForwardMessagesRequest, "id" | "randomId">,
  result: tl.TypeUpdates,
) {
  const newIds = new Map<string, number>();
  if ("updates" in result) {
    for (const update of result.updates) {
      if (update._ === "updateMessageID") {
        newIds.set(update.randomId.toString(), update.id);
      }
    }
  }
  return request.id.map((_, i) => newIds.get(request.randomId[i]?.toString() ?? "") ?? null);
}

function cacheForwardedMessages(
  cacheDb: Database,
  toChatId: number,
  newIds: number[],
  result: tl.TypeUpdates,
) {
  try {
    const inputs = "updates" in result ? newMessageInputs(result.updates) : [];
    if (inputs.length === 0) {
      verbose(`Forwarded messages not cached: no message in ${result._}`);
      return new Map<number, MessageSearchItem>();
    }
    createMessagesCache(cacheDb).upsertBatch(inputs);
    const history = createMessagesHistory(cacheDb);
    const rows = newIds.map((id) => history.get(toChatId, id)).filter((row) => row !== null);
    return new Map(messageRowsToItems(cacheDb, rows).map((item) => [item.messageId, item]));
  } catch (err) {
    verbose(`Could not cache the forwarded messages: ${getErrorMessage(err)}`);
    return new Map<number, MessageSearchItem>();
  }
}

export interface ForwardedMessage {
  /** The ID in the source chat */
  messageId: number;
  /** The ID of the copy in the target chat; null if the response lacks it */
  newMessageId: number | null;
  /** The copy as `tg messages get` prints it; null if it could not be cached */
  message: MessageSearchItem | null;
}

export interface ForwardMessagesResult {
  fromChatId: number;
  toChatId: number;
  /** In the order the IDs were given */
  forwarded: ForwardedMessage[];
}

/** Forward messages in one call and store the copies in the cache */
export async function forwardMessages(
  client: CallClient,
  cacheDb: Database,
  from: HistoryChat,
  to: HistoryChat,
  messageIds: number[],
) {
  const request = forwardMessagesRequest(from.inputPeer, to.inputPeer, messageIds);
  let result: tl.TypeUpdates;
  try {
    result = await client.call(request);
  } catch (err) {
    const { RpcError } = (await import("@mtcute/bun")).tl;
    if (RpcError.is(err)) {
      const refusal = refusalMessage(err.text);
      if (refusal) {
        throw new ForwardRefusedError(refusal, {
          fromChatId: from.chatId,
          toChatId: to.chatId,
          messageIds,
          telegramError: err.text,
        });
      }
    }
    throw withPeerHint(err);
  }

  const newIds = pairForwardedIds(request, result);
  const items = cacheForwardedMessages(
    cacheDb,
    to.chatId,
    newIds.filter((id) => id !== null),
    result,
  );
  return {
    fromChatId: from.chatId,
    toChatId: to.chatId,
    forwarded: messageIds.map((messageId, i) => {
      const newMessageId = newIds[i] ?? null;
      return {
        messageId,
        newMessageId,
        message: newMessageId === null ? null : (items.get(newMessageId) ?? null),
      };
    }),
  } satisfies ForwardMessagesResult;
}
