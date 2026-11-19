import type { tl } from "@mtcute/bun";
import { type ArgsDef, defineCommand } from "citty";
import { getResolvedCacheConfig } from "../config";
import { applyContactsSnapshot } from "../db/contacts-sync";
import { isCacheStale } from "../db/types";
import { createUsersCache } from "../db/users-cache";
import { getClientForAccount } from "../services/telegram";
import { type Contact, ErrorCodes, type PaginatedResult } from "../types";
import { openAccountCache } from "../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../utils/account-selector";
import { buildCachePaginatedResponse, paginate } from "../utils/cache-pagination";
import { isUsernameIdentifier } from "../utils/identifiers";
import { toLong } from "../utils/long";
import { error, success, verbose } from "../utils/output";
import {
  apiUserToCacheInput,
  apiUserToContact,
  cachedUserToContact,
} from "../utils/telegram-mappers";
import {
  reportConfigOrRateLimitError,
  wrapClientCallWithRateLimits,
} from "../utils/telegram-rate-limits";
import { nextCommand } from "./next";
import { cachedUserToUserInfo, isRawUser } from "./user/helpers";

/**
 * List contacts
 */
export const listContactsArgs = {
  limit: {
    type: "string",
    description: "Maximum number of contacts to return (default: 50)",
    default: "50",
  },
  offset: {
    type: "string",
    description: "Offset for pagination (default: 0)",
    default: "0",
  },
  account: {
    type: "string",
    description: ACCOUNT_SELECTOR_DESCRIPTION,
  },
  fresh: {
    type: "boolean",
    description: "Bypass cache and fetch from API",
    default: false,
  },
} satisfies ArgsDef;

export const listContactsCommand = defineCommand({
  meta: {
    name: "list",
    description: "List contacts with pagination",
  },
  args: listContactsArgs,
  async run({ args }) {
    const limit = Number.parseInt(args.limit ?? "50", 10);
    const offset = Number.parseInt(args.offset ?? "0", 10);
    const fresh = args.fresh ?? false;
    const { account, db: cacheDb } = openAccountCache(args.account);

    try {
      const usersCache = createUsersCache(cacheDb);
      const cacheConfig = await getResolvedCacheConfig();

      if (!fresh) {
        const contacts = usersCache.getContacts();

        if (contacts.length > 0) {
          const response = buildCachePaginatedResponse(contacts, cachedUserToContact, {
            offset,
            limit,
            ttlMs: cacheConfig.staleness.peers,
            source: "cache",
          });

          success(response, nextContactsPage(args, response));
          return;
        }
      }

      verbose("Fetching contacts from Telegram API...");
      const client = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: "cli:contacts.list",
        accountId: account.id,
      });

      const request: tl.contacts.RawGetContactsRequest = {
        _: "contacts.getContacts",
        hash: toLong(0),
      };
      const result = await client.call(request);

      if (result._ === "contacts.contactsNotModified") {
        success({
          items: [],
          total: 0,
          offset,
          limit,
          hasMore: false,
          source: "api",
          stale: false,
          message: "Contacts not modified since last fetch",
        });
        return;
      }

      const apiUsers = result.users.filter(isRawUser);

      const applied = applyContactsSnapshot(cacheDb, result, Date.now());
      verbose(`Cached ${applied.contacts} contacts, ${applied.unmarked} no longer contacts`);

      const allContacts: Contact[] = apiUsers.map(apiUserToContact);

      const response = {
        ...paginate(allContacts, offset, limit),
        source: "api",
        stale: false,
      };

      success(response, nextContactsPage(args, response));
    } catch (err) {
      reportConfigOrRateLimitError(err);
      const message = err instanceof Error ? err.message : "Unknown error";
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to fetch contacts: ${message}`);
    }
  },
});

function nextContactsPage(
  args: Record<string, unknown>,
  { hasMore, offset, limit }: PaginatedResult<unknown>,
) {
  if (!hasMore) return [];
  return [
    nextCommand(
      "contacts list",
      listContactsArgs,
      { ...args, limit, offset: offset + limit },
      "The next page of contacts.",
    ),
  ];
}

/**
 * Search contacts
 */
export const searchContactsCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search contacts by name or username",
  },
  args: {
    query: {
      type: "string",
      description: "Search query",
      required: true,
    },
    limit: {
      type: "string",
      description: "Maximum number of results (default: 20)",
      default: "20",
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    fresh: {
      type: "boolean",
      description: "Bypass cache and search via API",
      default: false,
    },
  },
  async run({ args }) {
    const query = args.query;
    const limit = Number.parseInt(args.limit ?? "20", 10);
    const fresh = args.fresh ?? false;
    const { account, db: cacheDb } = openAccountCache(args.account);

    try {
      const usersCache = createUsersCache(cacheDb);
      const cacheConfig = await getResolvedCacheConfig();

      if (!fresh) {
        const cachedResults = usersCache.search(query, limit);

        if (cachedResults.length > 0) {
          const anyStale = cachedResults.some((u) =>
            isCacheStale(u.fetched_at, cacheConfig.staleness.peers),
          );

          success({
            query,
            results: cachedResults.map(cachedUserToContact),
            total: cachedResults.length,
            source: "cache",
            stale: anyStale,
          });
          return;
        }
      }

      verbose(`Searching Telegram API for "${query}"...`);
      const client = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: "cli:contacts.search",
        accountId: account.id,
      });

      const request: tl.contacts.RawSearchRequest = {
        _: "contacts.search",
        q: query,
        limit,
      };
      const result = await client.call(request);

      const apiUsers = result.users.filter(isRawUser);

      const cacheInputs = apiUsers.map(apiUserToCacheInput);
      if (cacheInputs.length > 0) {
        usersCache.upsertMany(cacheInputs);
        verbose(`Cached ${cacheInputs.length} search results`);
      }

      success({
        query,
        results: apiUsers.map(apiUserToContact),
        total: apiUsers.length,
        source: "api",
        stale: false,
      });
    } catch (err) {
      reportConfigOrRateLimitError(err);
      const message = err instanceof Error ? err.message : "Unknown error";
      error(ErrorCodes.TELEGRAM_ERROR, `Search failed: ${message}`);
    }
  },
});

/**
 * Get contact by ID
 */
export const getContactCommand = defineCommand({
  meta: {
    name: "get",
    description: "Get contact information by user ID or username",
  },
  args: {
    id: {
      type: "string",
      description: "User ID or @username",
      required: true,
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    fresh: {
      type: "boolean",
      description: "Bypass cache and fetch from API",
      default: false,
    },
  },
  async run({ args }) {
    const identifier = args.id;
    const fresh = args.fresh ?? false;
    const { account, db: cacheDb } = openAccountCache(args.account);

    try {
      const usersCache = createUsersCache(cacheDb);
      const cacheConfig = await getResolvedCacheConfig();

      const isUsername = isUsernameIdentifier(identifier);

      if (!fresh) {
        const cached = isUsername
          ? usersCache.getByUsername(identifier)
          : usersCache.getById(identifier);

        if (cached) {
          const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers);

          success({ ...cachedUserToUserInfo(cached), source: "cache", stale });
          return;
        }
      }

      verbose(`Fetching user "${identifier}" from Telegram API...`);
      const client = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: "cli:contacts.get",
        accountId: account.id,
      });

      let result: tl.TypeUser[];

      if (isUsername) {
        const request: tl.contacts.RawResolveUsernameRequest = {
          _: "contacts.resolveUsername",
          username: identifier.replace("@", ""),
        };
        const resolved = await client.call(request);

        if (!resolved.users || resolved.users.length === 0) {
          error(ErrorCodes.TELEGRAM_ERROR, `User @${identifier.replace("@", "")} not found`);
        }

        result = resolved.users ?? [];
      } else {
        const userId = Number.parseInt(identifier, 10);
        const request: tl.users.RawGetUsersRequest = {
          _: "users.getUsers",
          id: [{ _: "inputUser", userId, accessHash: toLong(0) }],
        };
        result = await client.call(request);
      }

      const user = result.find(isRawUser);

      if (!user) {
        error(ErrorCodes.TELEGRAM_ERROR, `User "${identifier}" not found`);
      }

      usersCache.upsert(apiUserToCacheInput(user));
      verbose("Cached user data");

      success({
        id: user.id,
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? null,
        username: user.username ?? null,
        phone: user.phone ?? null,
        bio: null,
        isBot: user.bot ?? false,
        isVerified: user.verified ?? false,
        isPremium: user.premium ?? false,
        isContact: user.contact ?? false,
        source: "api",
        stale: false,
      });
    } catch (err) {
      reportConfigOrRateLimitError(err);
      const message = err instanceof Error ? err.message : "Unknown error";
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${message}`);
    }
  },
});

/**
 * Contacts subcommand group
 */
export const contactsCommand = defineCommand({
  meta: {
    name: "contacts",
    description: "Contact management commands",
  },
  subCommands: {
    list: listContactsCommand,
    search: searchContactsCommand,
    get: getContactCommand,
  },
});
