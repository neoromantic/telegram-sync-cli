import { type ArgsDef, defineCommand } from "citty";
import { ErrorCodes, type NextCommand } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { error, success } from "../../utils/output";
import { checkedChat } from "../access";
import { migrateArgs } from "../db";
import { nextCommand, tgCommand } from "../next";
import {
  formatTimeBound,
  parseTimeWindow,
  parseTypeArg,
  SINCE_ARG_DESCRIPTION,
  TYPE_ARG_DESCRIPTION,
  UNTIL_ARG_DESCRIPTION,
} from "./filters";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from "./helpers";
import {
  type FilteredPage,
  type ListHistoryResult,
  listHistory,
  readFilteredPage,
  resolveCachedChat,
  resolveHistoryChat,
} from "./history";

/** The args of `tg messages list`, for the `next` commands that run it */
export const listArgs = {
  chat: {
    type: "string",
    description: CHAT_ARG_DESCRIPTION,
    required: true,
  },
  limit: {
    type: "string",
    description: "Messages per page, 1-100",
    default: "20",
  },
  before: {
    type: "string",
    description: "Only messages older than this message ID (pass nextBefore to page back)",
  },
  after: {
    type: "string",
    description:
      "The messages right after this message ID (pass nextAfter to page forward; 0 starts at the first message)",
  },
  type: {
    type: "string",
    description: `${TYPE_ARG_DESCRIPTION}. With --type, --since or --until the page comes from the cache only, with complete saying whether the cache holds all of it`,
  },
  since: { type: "string", description: SINCE_ARG_DESCRIPTION },
  until: { type: "string", description: UNTIL_ARG_DESCRIPTION },
  includeDeleted: {
    type: "boolean",
    description: "Include deleted messages",
    default: false,
  },
  fresh: {
    type: "boolean",
    description: "Fetch the page from Telegram and cache it",
    default: false,
  },
  account: {
    type: "string",
    description: ACCOUNT_SELECTOR_DESCRIPTION,
  },
} satisfies ArgsDef;

export const listMessagesCommand = defineCommand({
  meta: {
    name: "list",
    description:
      "List the messages of a chat, newest first (cache-first). Page back with --before <nextBefore> and forward with --after <nextAfter> until items is empty; next has the command for the next page",
  },
  args: listArgs,
  async run({ args, rawArgs }) {
    const limit = parseIntegerArg(args.limit, "limit", {
      min: 1,
      max: 100,
      default: 20,
    });
    const before = parseIntegerArg(args.before, "before", {
      min: 1,
      max: MAX_MESSAGE_ID,
    });
    const after = parseIntegerArg(args.after, "after", {
      min: 0,
      max: MAX_MESSAGE_ID - 1,
    });
    if (before !== undefined && after !== undefined && after >= before) {
      error(
        ErrorCodes.INVALID_ARGS,
        `--after (${after}) must be smaller than --before (${before})`,
        { after, before },
      );
    }
    const types = parseTypeArg(rawArgs ?? [], listArgs);
    const { since, until } = parseTimeWindow(args);
    const filtered = types !== undefined || since !== undefined || until !== undefined;
    if (filtered && args.fresh) {
      error(
        ErrorCodes.INVALID_ARGS,
        "--type, --since and --until read only the cache, and --fresh reads an unfiltered page from Telegram",
        undefined,
        "Fetch pages with tg messages list --fresh (no filters), then filter",
      );
    }
    const { account } = openAccountCache(args.account);
    const window = { limit, before, after };
    const includeDeleted = args.includeDeleted ?? false;

    try {
      const deps = openHistory(account.id, "cli:messages.list");
      if (filtered) {
        const chat = checkedChat(args, "chat") ?? (await resolveCachedChat(args.chat, deps));
        const result = readFilteredPage(deps.cacheDb, chat.chatId, window, includeDeleted, {
          types,
          since,
          until,
        });
        const values = {
          ...args,
          type: types?.join(","),
          since: formatTimeBound(since),
          until: formatTimeBound(until),
        };
        success(
          { ...result.page, suggestion: filteredSuggestion(args, result) },
          filteredNext(values, result),
        );
        return;
      }

      const chat = await resolveHistoryChat(deps.client, args.chat, deps);
      const result = await listHistory({
        cacheDb: deps.cacheDb,
        client: deps.client,
        chat,
        window,
        includeDeleted,
        fresh: args.fresh ?? false,
      });
      success(result, nextPage(args, result));
    } catch (err) {
      reportHistoryError(err, "list messages");
    }
  },
});

function nextPage(
  args: Record<string, unknown>,
  { items, limit, after, nextBefore, nextAfter }: ListHistoryResult,
) {
  if (items.length < limit) return [];
  if (after !== null) {
    return [
      nextCommand(
        "messages list",
        listArgs,
        { ...args, after: nextAfter },
        "The next page of newer messages.",
      ),
    ];
  }
  if (nextBefore === null || nextBefore <= 1) return [];
  return [
    nextCommand(
      "messages list",
      listArgs,
      { ...args, before: nextBefore },
      "The next page of older messages.",
    ),
  ];
}

function fillCommands(args: Record<string, unknown>, { gap, untyped }: FilteredPage) {
  const fetch = (before: number | null, why: string) =>
    nextCommand(
      "messages list",
      listArgs,
      {
        chat: args.chat,
        account: args.account,
        limit: 100,
        before: before ?? undefined,
        fresh: true,
      },
      why,
    );

  const fills: NextCommand[] = [];
  if (gap?.fillable) {
    const page =
      gap.before === null ? "the newest 100 messages" : `the 100 messages below ${gap.before}`;
    fills.push(
      fetch(
        gap.before,
        `The cache lacks messages ${gap.low}-${gap.high} of this page: this caches ${page} from Telegram.`,
      ),
    );
  }
  if (untyped?.migrating) {
    fills.push(
      nextCommand(
        "db migrate",
        migrateArgs,
        { account: args.account },
        "Older cached messages are still being typed: this finishes the migration.",
      ),
    );
  }
  return fills.filter((fill, i) => fills.findIndex((f) => f.command === fill.command) === i);
}

function filteredNext(args: Record<string, unknown>, result: FilteredPage) {
  const fills = fillCommands(args, result);
  if (fills.length === 0) return nextPage(args, result.page);
  return [
    ...fills,
    nextCommand(
      "messages list",
      listArgs,
      args,
      "Then read this page again: it stays incomplete until nothing is missing.",
    ),
  ];
}

/**
 * The clause that offers one manual refetch of a message cached without its
 * raw message, in place of a `next` that would repeat it for good when
 * Telegram no longer returns the message
 */
export function refetchClause(chat: string, account: string | undefined, messageId: number) {
  const command = tgCommand("messages list", listArgs, {
    chat,
    account,
    limit: 100,
    before: messageId < MAX_MESSAGE_ID ? messageId + 1 : undefined,
    fresh: true,
  });
  return `${command} fetches it and the messages below it again; run it once, as a message Telegram no longer returns keeps its type unknown`;
}

function filteredSuggestion(
  args: { chat: string; account?: string },
  { page, gap, untyped }: FilteredPage,
) {
  if (page.complete) return null;
  const parts: string[] = [];
  if (gap) {
    parts.push(
      gap.fillable
        ? `the cache lacks messages ${gap.low}-${gap.high}: next fetches them, then reads this page again (tg chats sync turns on history sync for a long gap)`
        : `the cache lacks messages ${gap.low}-${gap.high}, and it keeps out a group's messages from a time you didn't take part in it, so an unfiltered tg messages list reads them from Telegram`,
    );
  }
  if (untyped) {
    parts.push(
      untyped.migrating || untyped.newestAwaitingRaw === null
        ? "older cached messages are still being typed: next finishes the migration"
        : `message ${untyped.newestAwaitingRaw} and maybe older media messages were cached without their type: ${refetchClause(args.chat, args.account, untyped.newestAwaitingRaw)}`,
    );
  }
  return `This page may lack matches: ${parts.join("; ")}.`;
}
