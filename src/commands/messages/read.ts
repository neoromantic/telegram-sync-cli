import { defineCommand } from "citty";

import { checkedChat } from "../access";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { success } from "../../utils/output";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from "./helpers";
import { resolveHistoryChat } from "./history";
import { markRead } from "./read-state";

export const readMessagesCommand = defineCommand({
  meta: {
    name: "read",
    description:
      "Mark a chat's incoming messages read on Telegram, all of them or up to --max-id, and print its unread count after",
  },
  args: {
    chat: {
      type: "string",
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    "max-id": {
      type: "string",
      description:
        "Mark read only up to this message ID (nextAfter of tg messages unread); default: every message",
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const maxId = parseIntegerArg(args["max-id"], "max-id", {
      min: 1,
      max: MAX_MESSAGE_ID,
    });
    const { account } = openAccountCache(args.account);

    try {
      const deps = openHistory(account.id, "cli:messages.read");
      const chat =
        checkedChat(args, "chat") ?? (await resolveHistoryChat(deps.client, args.chat, deps));
      success(await markRead(deps.client, deps.cacheDb, chat, maxId ?? null));
    } catch (err) {
      reportHistoryError(err, "mark messages read");
    }
  },
});
