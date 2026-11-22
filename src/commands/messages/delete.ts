import { type ArgsDef, defineCommand } from "citty";

import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { flagValues } from "../../utils/args";
import { error, success } from "../../utils/output";
import { checkedChat } from "../access";
import {
  DeleteRefusedError,
  deleteMessages,
  MAX_DELETE_IDS,
  MessagesNotInChatError,
} from "./delete-messages";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from "./helpers";
import { resolveHistoryChat } from "./history";

const deleteArgs = {
  chat: {
    type: "string",
    description: CHAT_ARG_DESCRIPTION,
    required: true,
  },
  id: {
    type: "string",
    description: `Message ID; repeat for several, up to ${MAX_DELETE_IDS}`,
    required: true,
  },
  revoke: {
    type: "boolean",
    description: "Delete for everyone in a private chat or basic group, not only for this account",
    default: false,
  },
  account: {
    type: "string",
    description: ACCOUNT_SELECTOR_DESCRIPTION,
  },
} satisfies ArgsDef;

function readMessageIds(rawArgs: string[]) {
  const ids = [
    ...new Set(
      flagValues(rawArgs, "id", deleteArgs).map((value) =>
        parseIntegerArg(value, "id", { min: 1, max: MAX_MESSAGE_ID }),
      ),
    ),
  ];
  if (ids.length === 0) {
    error(ErrorCodes.INVALID_ARGS, "No --id given. Nothing was deleted.");
  }
  if (ids.length > MAX_DELETE_IDS) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Too many --id: ${ids.length}. Telegram deletes at most ${MAX_DELETE_IDS} messages per call.`,
      { count: ids.length, max: MAX_DELETE_IDS },
    );
  }
  return ids;
}

export const deleteMessagesCommand = defineCommand({
  meta: {
    name: "delete",
    description:
      "Delete messages of a chat, for this account or with --revoke for everyone (always for everyone in a supergroup or channel). This cannot be undone.",
  },
  args: deleteArgs,
  async run({ args, rawArgs }) {
    const messageIds = readMessageIds(rawArgs);
    const { account } = openAccountCache(args.account);

    try {
      const deps = openHistory(account.id, "cli:messages.delete");
      const chat =
        checkedChat(args, "chat") ??
        (await resolveHistoryChat(deps.client, args.chat, deps, { freshUsername: true }));
      success(await deleteMessages(deps.client, deps.cacheDb, chat, messageIds, args.revoke));
    } catch (err) {
      if (err instanceof DeleteRefusedError || err instanceof MessagesNotInChatError) {
        error(ErrorCodes.TELEGRAM_ERROR, err.message, err.details);
      }
      reportHistoryError(err, "delete the messages");
    }
  },
});
