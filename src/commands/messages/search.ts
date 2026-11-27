import type { Database } from "bun:sqlite";
import { type ArgsDef, defineCommand } from "citty";

import { isMigrationPending } from "../../db/background-migrations";
import {
  createMessagesSearch,
  hasFts5Syntax,
  isFts5QueryError,
  toFts5Query,
  MESSAGE_SEARCH_SORTS,
  type MessageSearchOptions,
  type MessageSearchSort,
} from "../../db/messages-search";
import { findQueryForms } from "../../db/word-forms";
import { MESSAGE_TYPES_MIGRATION } from "../../db/raw-json-migrations";
import { ErrorCodes, type NextCommand } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { visibleTranscriptHits } from "../../db/message-transcripts";
import { normalizeUsername } from "../../utils/identifiers";
import { error, success } from "../../utils/output";
import { buildSnippet, snippetTerms } from "../../utils/search-snippet";
import { allowedChatIds } from "../access";
import { migrateArgs } from "../db";
import { nextCommand } from "../next";
import {
  formatTimeBound,
  parseTimeWindow,
  parseTypeArg,
  SINCE_ARG_DESCRIPTION,
  TYPE_ARG_DESCRIPTION,
  UNTIL_ARG_DESCRIPTION,
} from "./filters";
import { messageItemReader } from "./helpers";
import { refetchClause } from "./list";

function parseIdentifier(
  input: string | undefined,
  name: "chat" | "sender",
  selfId: number | null,
) {
  if (!input) return undefined;
  const value = input.trim();

  if (value.toLowerCase() === "me") {
    if (selfId === null) {
      error(
        ErrorCodes.INVALID_ARGS,
        `--${name} me: the account's own user ID is not known yet`,
        { [name]: input },
        "Run tg me once (it saves the ID), or pass your user ID",
      );
    }
    return { id: selfId };
  }
  if (/^-?\d+$/.test(value)) return { id: Number(value) };
  if (/^@?[a-z]\w*$/i.test(value)) return { username: normalizeUsername(value) };

  error(
    ErrorCodes.INVALID_ARGS,
    `Invalid --${name}: ${input}`,
    { [name]: input },
    "Use an ID as tg prints it, an @username or me",
  );
}

const searchArgs = {
  query: {
    type: "string",
    description:
      'Words to find (all of them, any order), or an FTS5 query: error OR timeout, "exact phrase", sender:alice, chat:team, word*',
    required: true,
  },
  phrase: {
    type: "boolean",
    description: "Match the whole query as one exact phrase",
    default: false,
  },
  forms: {
    type: "boolean",
    description:
      "Also match other forms of each plain word that occur in the cache (квартира: квартиру, квартирой; meeting: meetings), ё read as е",
    default: false,
  },
  limit: {
    type: "string",
    description: "Maximum number of results (default: 50)",
    default: "50",
  },
  offset: {
    type: "string",
    description: "Offset for pagination (default: 0)",
    default: "0",
  },
  chat: {
    type: "string",
    description: "Filter by chat ID, @username or me (Saved Messages)",
  },
  sender: {
    type: "string",
    description: "Filter by sender ID, @username or me (your own messages)",
  },
  includeDeleted: {
    type: "boolean",
    description: "Include deleted messages",
    default: false,
  },
  since: {
    type: "string",
    description: SINCE_ARG_DESCRIPTION,
  },
  until: {
    type: "string",
    description: UNTIL_ARG_DESCRIPTION,
  },
  type: {
    type: "string",
    description: TYPE_ARG_DESCRIPTION,
  },
  sort: {
    type: "string",
    description: "Order: date (newest first, default) or relevance (best match first)",
    default: "date",
  },
  snippet: {
    type: "boolean",
    description:
      "Add a snippet to each result: the text around the first match, matched words in **",
    default: false,
  },
  count: {
    type: "boolean",
    description: "Also count every message that matches the query and filters (a second query)",
    default: false,
  },
  fresh: {
    type: "boolean",
    description:
      "Refused: search reads only the cache. tg messages list --chat <chat> --fresh fetches a chat's messages from Telegram",
    default: false,
  },
  account: {
    type: "string",
    description: ACCOUNT_SELECTOR_DESCRIPTION,
  },
} satisfies ArgsDef;

/**
 * One page of search results, one more than `limit` to tell whether
 * another page follows, with the optional count and the type state, read in
 * one read transaction, so a migration that commits meanwhile can't make
 * them disagree
 */
export function readSearchPage(
  cacheDb: Database,
  query: string,
  filters: Omit<MessageSearchOptions, "forms">,
  page: {
    limit: number;
    offset: number;
    sort: MessageSearchSort;
    count: boolean;
    expandForms?: boolean;
  },
) {
  return cacheDb.transaction(() => {
    const forms = page.expandForms ? findQueryForms(cacheDb, query) : undefined;
    const options = { ...filters, forms };
    const hits = [...visibleTranscriptHits(cacheDb, toFts5Query(query, options))];
    const search = createMessagesSearch(cacheDb, hits);
    const rows = search.search(query, { ...options, ...page, limit: page.limit + 1 });
    const toItem = messageItemReader(cacheDb);
    const typed = options.types !== undefined;
    return {
      forms,
      rows,
      items: rows.slice(0, page.limit).map((row) => ({
        ...toItem(row),
        ...(row.transcript_match ? { transcriptMatch: true } : {}),
      })),
      count: page.count ? search.count(query, options) : null,
      migrating: typed && isMigrationPending(cacheDb, MESSAGE_TYPES_MIGRATION),
      untyped: typed ? search.newestUntypedMatch(query, options) : null,
    };
  })();
}

export const searchMessagesCommand = defineCommand({
  meta: {
    name: "search",
    description:
      'Search cached messages and their available transcripts, newest first. hello world finds messages with both words in any order; FTS5 syntax works as written: error OR timeout, "exact phrase", sender:alice, chat:team, квартир* for every word form; --forms finds other forms of plain words',
  },
  args: searchArgs,
  async run({ args, rawArgs }) {
    if (args.fresh) {
      error(
        ErrorCodes.INVALID_ARGS,
        "tg messages search reads only the cache, so it can't search Telegram with --fresh",
        { fresh: true },
        "Fetch the chat's messages first with tg messages list --chat <chat> --fresh, then search the cache",
      );
    }
    const query = (args.query ?? "").trim();
    if (!query) {
      error(ErrorCodes.INVALID_ARGS, "Search query is required");
    }

    if (args.forms && args.phrase) {
      error(
        ErrorCodes.INVALID_ARGS,
        "--forms can't be combined with --phrase",
        { query },
        "Drop --forms to match the exact phrase, or drop --phrase to match the words in any order with their forms",
      );
    }
    if (args.forms && hasFts5Syntax(query)) {
      error(
        ErrorCodes.INVALID_ARGS,
        "--forms works on plain words only, and this query has FTS5 syntax",
        { query },
        "Drop --forms to run the query as written, or write the forms into it yourself (квартир*)",
      );
    }

    const limit = Number.parseInt(args.limit ?? "50", 10);
    const offset = Number.parseInt(args.offset ?? "0", 10);

    if (!Number.isFinite(limit) || limit <= 0) {
      error(ErrorCodes.INVALID_ARGS, `Invalid limit: ${args.limit}`);
    }

    if (!Number.isFinite(offset) || offset < 0) {
      error(ErrorCodes.INVALID_ARGS, `Invalid offset: ${args.offset}`);
    }

    const sort = (args.sort ?? "date") as MessageSearchSort;
    if (!MESSAGE_SEARCH_SORTS.includes(sort)) {
      error(ErrorCodes.INVALID_ARGS, `Invalid sort: ${args.sort}. Use 'date' or 'relevance'.`);
    }

    const { since, until } = parseTimeWindow(args);
    const types = parseTypeArg(rawArgs ?? [], searchArgs);

    const { account, db: cacheDb } = openAccountCache(args.account);
    const chatFilter = parseIdentifier(args.chat, "chat", account.user_id);
    const senderFilter = parseIdentifier(args.sender, "sender", account.user_id);
    const allowed = await allowedChatIds(account.id, { cacheOnly: true });

    try {
      const options = {
        includeDeleted: args.includeDeleted ?? false,
        phrase: args.phrase ?? false,
        chatId: chatFilter?.id,
        chatIds: allowed === null ? undefined : [...allowed],
        chatUsername: chatFilter?.username,
        senderId: senderFilter?.id,
        senderUsername: senderFilter?.username,
        since,
        until,
        types,
      };
      const { forms, rows, items, count, migrating, untyped } = readSearchPage(
        cacheDb,
        query,
        options,
        {
          limit,
          offset,
          sort,
          count: args.count ?? false,
          expandForms: args.forms && allowed === null,
        },
      );
      const typesPending = migrating || untyped !== null;
      const values = {
        ...args,
        query,
        type: types?.join(","),
        since: formatTimeBound(since),
        until: formatTimeBound(until),
        limit,
      };
      const fills: NextCommand[] = [];
      if (migrating) {
        fills.push(
          nextCommand(
            "db migrate",
            migrateArgs,
            { account: args.account },
            "Some cached messages have no type yet: this finishes the background migration that types them.",
          ),
        );
      }
      const next = [
        ...fills,
        ...(rows.length > limit
          ? [
              nextCommand(
                "messages search",
                searchArgs,
                { ...values, offset: offset + limit },
                "The next page of results.",
              ),
            ]
          : []),
      ];
      const terms = args.snippet
        ? [
            ...snippetTerms(query, { phrase: options.phrase }),
            ...[...(forms?.values() ?? [])].flatMap((found) =>
              found.words.map((text) => ({ text, prefix: false })),
            ),
          ]
        : [];

      success(
        {
          query,
          filters: {
            chat: args.chat ?? null,
            sender: args.sender ?? null,
            includeDeleted: args.includeDeleted ?? false,
            phrase: args.phrase ?? false,
            forms: args.forms ?? false,
            since: args.since ?? null,
            until: args.until ?? null,
            type: types ?? null,
          },
          sort,
          forms: forms ? Object.fromEntries(forms) : null,
          results: items.map((item) => {
            const text = item.transcriptMatch ? (item.transcript?.text ?? null) : item.text;
            return args.snippet ? { ...item, snippet: buildSnippet(text, terms) } : item;
          }),
          total: items.length,
          count,
          typesPending,
          suggestion:
            untyped && !migrating
              ? `Message ${untyped.messageId} of chat ${untyped.chatId} matches but was cached without its raw message, so its type is unknown: ${refetchClause(String(untyped.chatId), args.account, untyped.messageId)}.`
              : null,
          limit,
          offset,
          source: "cache",
          stale: false,
        },
        next,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isFts5QueryError(err)) {
        error(
          ErrorCodes.INVALID_ARGS,
          `Invalid search query: ${message}`,
          { query },
          'Quote words with punctuation ("e-mail", "10:30"), or pass --phrase to match the query as written',
        );
      }
      error(ErrorCodes.GENERAL_ERROR, `Search failed: ${message}`, { query });
    }
  },
});
