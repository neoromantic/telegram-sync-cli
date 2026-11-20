import { defineCommand } from "citty";

import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { error, success } from "../../utils/output";
import { checkedChat } from "../access";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from "./helpers";
import { resolveHistoryChat } from "./history";
import { type PinChange, PinRefusedError, pinMessage } from "./pin-message";

const TARGET_ARGS = {
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
} as const;

const ACCOUNT_ARG = {
  account: {
    type: "string",
    description: ACCOUNT_SELECTOR_DESCRIPTION,
  },
} as const;

async function runPinChange(
  args: { chat: string; id: string; account?: string },
  change: PinChange,
) {
  const messageId = parseIntegerArg(args.id, "id", {
    min: 1,
    max: MAX_MESSAGE_ID,
  });
  const { account } = openAccountCache(args.account);
  const command = change.pin ? "pin" : "unpin";

  try {
    const deps = openHistory(account.id, `cli:messages.${command}`);
    const chat =
      checkedChat(args, "chat") ??
      (await resolveHistoryChat(deps.client, args.chat, deps, { freshUsername: true }));
    success(await pinMessage(deps.client, deps.cacheDb, chat, messageId, change));
  } catch (err) {
    if (err instanceof PinRefusedError) {
      error(ErrorCodes.TELEGRAM_ERROR, err.message, err.details);
    }
    reportHistoryError(err, `${command} the message`);
  }
}

export const pinMessageCommand = defineCommand({
  meta: {
    name: "pin",
    description:
      "Pin a message. Everyone in the chat sees the pin, and Telegram notifies them unless --silent",
  },
  args: {
    ...TARGET_ARGS,
    silent: {
      type: "boolean",
      description: "Pin without notifying the chat's members",
      default: false,
    },
    ...ACCOUNT_ARG,
  },
  async run({ args }) {
    await runPinChange(args, { pin: true, silent: args.silent });
  },
});

export const unpinMessageCommand = defineCommand({
  meta: {
    name: "unpin",
    description: "Unpin a message for everyone in the chat, without a notification",
  },
  args: { ...TARGET_ARGS, ...ACCOUNT_ARG },
  async run({ args }) {
    await runPinChange(args, { pin: false });
  },
});
