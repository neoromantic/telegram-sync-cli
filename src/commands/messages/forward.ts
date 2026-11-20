import { defineCommand } from "citty";

import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { flagValues } from "../../utils/args";
import { error, success } from "../../utils/output";
import { checkedChat } from "../access";
import { AmbiguousPeerError, InvalidPeerError } from "../send/peer-resolver";
import { ForwardRefusedError, forwardMessages, MAX_FORWARD_IDS } from "./forward-message";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from "./helpers";
import { resolveHistoryChat } from "./history";

function readMessageIds(id: string, rawArgs: string[]) {
  const values = flagValues(rawArgs, "id");
  const ids = [
    ...new Set(
      (values.length > 0 ? values : [id]).map((value) =>
        parseIntegerArg(value, "id", { min: 1, max: MAX_MESSAGE_ID }),
      ),
    ),
  ];
  if (ids.length > MAX_FORWARD_IDS) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Telegram forwards at most ${MAX_FORWARD_IDS} messages per call; got ${ids.length}`,
      { count: ids.length, max: MAX_FORWARD_IDS },
    );
  }
  return ids;
}

export const forwardMessagesCommand = defineCommand({
  meta: {
    name: "forward",
    description:
      "Forward messages from one chat to another as you; the copies cannot be unsent with tg",
  },
  args: {
    from: {
      type: "string",
      description: CHAT_ARG_DESCRIPTION.replace("Chat:", "Source chat:"),
      required: true,
    },
    to: {
      type: "string",
      description: CHAT_ARG_DESCRIPTION.replace("Chat:", "Target chat:"),
      required: true,
    },
    id: {
      type: "string",
      description: `Message ID in the source chat; repeat for up to ${MAX_FORWARD_IDS}`,
      required: true,
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args, rawArgs }) {
    const messageIds = readMessageIds(args.id, rawArgs ?? []);
    const { account } = openAccountCache(args.account);

    try {
      const deps = openHistory(account.id, "cli:messages.forward");
      const resolve = async (flag: "from" | "to", input: string) => {
        try {
          return (
            checkedChat(args, flag) ??
            (await resolveHistoryChat(deps.client, input, deps, { freshUsername: true }))
          );
        } catch (err) {
          if (err instanceof InvalidPeerError) {
            error(
              ErrorCodes.INVALID_ARGS,
              `Invalid --${flag}: ${input}. Expected @username, a user or chat ID, a phone number (+…) or me.`,
              { [flag]: input },
            );
          }
          if (err instanceof AmbiguousPeerError) {
            error(ErrorCodes.INVALID_ARGS, err.message, {
              [flag]: input,
              candidates: err.candidates,
            });
          }
          throw err;
        }
      };
      const from = await resolve("from", args.from);
      const to = await resolve("to", args.to);
      success(await forwardMessages(deps.client, deps.cacheDb, from, to, messageIds));
    } catch (err) {
      if (err instanceof ForwardRefusedError) {
        error(ErrorCodes.TELEGRAM_ERROR, err.message, { ...err.details });
      }
      reportHistoryError(err, "forward the messages");
    }
  },
});
