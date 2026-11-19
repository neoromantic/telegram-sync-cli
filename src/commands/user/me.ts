import { defineCommand } from "citty";
import { ConfigError, getResolvedCacheConfig } from "../../config";
import { accountsDb } from "../../db";
import { isCacheStale } from "../../db/types";
import { createUsersCache } from "../../db/users-cache";
import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { error, success, verbose } from "../../utils/output";
import { apiUserToCacheInput } from "../../utils/telegram-mappers";
import { apiUserToUserInfo, cachedUserToUserInfo } from "./helpers";

export const meCommand = defineCommand({
  meta: {
    name: "me",
    description: "Get current user information",
  },
  args: {
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
    const accountId = account.id;

    try {
      const fresh = args.fresh;
      const usersCache = createUsersCache(cacheDb);
      const cacheConfig = await getResolvedCacheConfig();

      const fetchAndUpdateCache = async () => {
        const { getClientForAccount } = await import("../../services/telegram");
        const client = await getClientForAccount(accountId);

        const me = await client.getMe();

        usersCache.upsert(apiUserToCacheInput(me.raw));

        if (!account.user_id) {
          accountsDb.update(account.id, { user_id: me.id });
        }

        return me;
      };

      if (!fresh && account.user_id) {
        const cached = usersCache.getById(String(account.user_id));
        if (cached) {
          const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers);

          if (stale) {
            verbose("Cache is stale, triggering background refresh...");
            fetchAndUpdateCache().catch((err) => {
              verbose(`Background refresh failed: ${err.message}`);
            });
          }

          verbose(`Returning cached user (stale: ${stale})`);
          success({
            user: cachedUserToUserInfo(cached),
            source: "cache" as const,
            stale,
          });
          return;
        }
      }

      verbose("Fetching current user info from API...");

      let result: Awaited<ReturnType<typeof fetchAndUpdateCache>>;
      try {
        result = await fetchAndUpdateCache();
      } catch {
        error(ErrorCodes.AUTH_REQUIRED, 'Not authorized. Please log in first with "tg auth login"');
        return;
      }

      success({
        user: apiUserToUserInfo(result.raw),
        source: "api" as const,
        stale: false,
      });
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues });
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user info: ${message}`);
    }
  },
});
