import type { TelegramClient, tl } from "@mtcute/bun";
import { defineCommand } from "citty";
import { getResolvedCacheConfig } from "../../config";
import { isCacheStale } from "../../db/types";
import { createUsersCache } from "../../db/users-cache";
import { getClientForAccount } from "../../services/telegram";
import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { toLong } from "../../utils/long";
import { error, success, verbose } from "../../utils/output";
import { apiUserToCacheInput } from "../../utils/telegram-mappers";
import {
  reportConfigOrRateLimitError,
  wrapClientCallWithRateLimits,
} from "../../utils/telegram-rate-limits";
import {
  apiUserToUserInfo,
  cachedUserToUserInfo,
  findCachedUser,
  isRawUser,
  parseUserIdentifier,
} from "./helpers";

type TelegramClientLike = Pick<TelegramClient, "call">;

async function resolveUserByUsername(client: TelegramClientLike, username: string) {
  return (
    await client.call({
      _: "contacts.resolveUsername",
      username,
    } as tl.contacts.RawResolveUsernameRequest)
  ).users?.find(isRawUser);
}

async function resolveUserByPhone(client: TelegramClientLike, phone: string) {
  return (
    await client.call({
      _: "contacts.resolvePhone",
      phone,
    } as tl.contacts.RawResolvePhoneRequest)
  ).users?.find(isRawUser);
}

async function resolveUserById(client: TelegramClientLike, identifier: string) {
  return (
    await client.call({
      _: "users.getUsers",
      id: [
        {
          _: "inputUser",
          userId: Number.parseInt(identifier, 10),
          accessHash: toLong(0),
        },
      ],
    } as tl.users.RawGetUsersRequest)
  ).find(isRawUser);
}

async function resolveUserFromApi(
  client: TelegramClientLike,
  parsed: ReturnType<typeof parseUserIdentifier>,
) {
  if (parsed.kind === "username") {
    verbose(`Resolving username: ${parsed.value}`);
    return resolveUserByUsername(client, parsed.value);
  }

  if (parsed.kind === "phone") {
    verbose(`Resolving phone: ${parsed.value}`);
    return resolveUserByPhone(client, parsed.value);
  }

  verbose(`Fetching user ID: ${parsed.value}`);
  return resolveUserById(client, parsed.value);
}

function handleUserLookupError(err: unknown): never {
  const errMsg = err instanceof Error ? err.message : String(err);
  if (errMsg.includes("USERNAME_NOT_OCCUPIED")) {
    error(ErrorCodes.TELEGRAM_ERROR, "Username not found");
  }
  if (errMsg.includes("PHONE_NOT_OCCUPIED")) {
    error(ErrorCodes.TELEGRAM_ERROR, "Phone number not found");
  }
  error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${errMsg}`);
}

export const userCommand = defineCommand({
  meta: {
    name: "user",
    description: "Look up a user by ID, @username, or phone number",
  },
  args: {
    identifier: {
      type: "positional",
      description: "User ID, @username, or phone number",
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
    const { account, db: cacheDb } = openAccountCache(args.account);

    try {
      const identifier = args.identifier as string;
      const fresh = args.fresh ?? false;

      const parsed = parseUserIdentifier(identifier);

      const usersCache = createUsersCache(cacheDb);
      const cacheConfig = await getResolvedCacheConfig();

      if (!fresh) {
        const cached = findCachedUser(usersCache, parsed);
        if (cached) {
          const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers);

          verbose(`Returning cached user (stale: ${stale})`);
          success({
            user: cachedUserToUserInfo(cached),
            source: "cache" as const,
            stale,
          });
          return;
        }
      }

      verbose("Fetching user from API...");
      const client = wrapClientCallWithRateLimits(await getClientForAccount(account.id), {
        context: "cli:user.lookup",
        accountId: account.id,
      });

      const user = await resolveUserFromApi(client, parsed);

      if (!user) {
        error(ErrorCodes.TELEGRAM_ERROR, `User not found: ${identifier}`);
      }

      usersCache.upsert(apiUserToCacheInput(user));

      success({
        user: apiUserToUserInfo(user),
        source: "api" as const,
        stale: false,
      });
    } catch (err: unknown) {
      reportConfigOrRateLimitError(err);
      handleUserLookupError(err);
    }
  },
});
