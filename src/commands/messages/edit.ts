import { defineCommand } from "citty";

import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { error, success } from "../../utils/output";
import { EditRefusedError, editMessage } from "./edit-message";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from "./helpers";
import { resolveHistoryChat } from "./history";

export const editMessageCommand = defineCommand({
  meta: {
    name: "edit",
    description:
      "Replace the text of a message you sent, or the caption of a file, with plain text, and print the edited message",
  },
  args: {
    chat: {
      type: "string",
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: "string",
      description: "Message ID",
      required: true,
    },
    message: {
      type: "string",
      alias: "m",
      description: "The new text",
      required: true,
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const messageId = parseIntegerArg(args.id, "id", {
      min: 1,
      max: MAX_MESSAGE_ID,
    });
    if (args.message.trim() === "") {
      error(ErrorCodes.INVALID_ARGS, "Message text cannot be empty");
    }
    const { account } = openAccountCache(args.account);

    try {
      const deps = openHistory(account.id, "cli:messages.edit");
      const chat = await resolveHistoryChat(deps.client, args.chat, deps);
      success(await editMessage(deps.client, deps.cacheDb, chat, messageId, args.message));
    } catch (err) {
      if (err instanceof EditRefusedError) {
        error(ErrorCodes.TELEGRAM_ERROR, err.message, err.details);
      }
      reportHistoryError(err, "edit the message");
    }
  },
});
