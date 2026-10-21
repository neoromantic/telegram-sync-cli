import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../../config'
import { accountsDb } from '../../db'
import { isCacheStale } from '../../db/types'
import { createUsersCache } from '../../db/users-cache'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { error, success, verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import { apiUserToUserInfo, cachedUserToUserInfo } from './helpers'

export const meCommand = defineCommand({
  meta: {
    name: 'me',
    description: 'Get current user information',
  },
  args: {
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    fresh: {
      type: 'boolean',
      description: 'Bypass cache and fetch from API',
      default: false,
    },
  },
  async run({ args }) {
    // The account knows its user_id, so a cached read needs no network call
    const { account, db: cacheDb } = openAccountCache(args.account)
    const accountId = account.id

    try {
      const fresh = args.fresh
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      // Helper to fetch from API and update cache
      const fetchAndUpdateCache = async () => {
        // Lazy import to avoid loading mtcute for cache-only reads
        const { getClientForAccount } = await import('../../services/telegram')
        const client = getClientForAccount(accountId)

        const me = await client.getMe()

        // Update cache
        usersCache.upsert(apiUserToCacheInput(me.raw))

        // Update account with user_id if missing
        if (!account.user_id) {
          accountsDb.update(account.id, { user_id: me.id })
        }

        return me
      }

      // Try cache first (no network call!)
      if (!fresh && account.user_id) {
        const cached = usersCache.getById(String(account.user_id))
        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.peers,
          )

          // If stale, trigger background refresh (don't await)
          if (stale) {
            verbose('Cache is stale, triggering background refresh...')
            fetchAndUpdateCache().catch((err) => {
              // Log error but don't fail - we already returned cached data
              verbose(`Background refresh failed: ${err.message}`)
            })
          }

          verbose(`Returning cached user (stale: ${stale})`)
          success({
            user: cachedUserToUserInfo(cached),
            source: 'cache' as const,
            stale,
          })
          return
        }
      }

      // Cache miss or --fresh: need to call the API synchronously
      verbose('Fetching current user info from API...')

      let result: Awaited<ReturnType<typeof fetchAndUpdateCache>>
      try {
        result = await fetchAndUpdateCache()
      } catch {
        error(
          ErrorCodes.AUTH_REQUIRED,
          'Not authorized. Please log in first with "tg auth login"',
        )
        return
      }

      success({
        user: apiUserToUserInfo(result.raw),
        source: 'api' as const,
        stale: false,
      })
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user info: ${message}`)
    }
  },
})
