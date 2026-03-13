import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../../config'
import { getCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import { isCacheStale } from '../../db/types'
import { ErrorCodes } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import { error, success } from '../../utils/output'
import { chatRowToItem } from './helpers'

export const searchChatsCommand = defineCommand({
  meta: {
    name: 'search',
    description: 'Search chats by title or username',
  },
  args: {
    query: {
      type: 'string',
      description: 'Search query',
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results (default: 20)',
      default: '20',
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const query = args.query
    const limit = Number.parseInt(args.limit ?? '20', 10)
    resolveAccountSelector(args.account)

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      const results = chatsCache.search(query, limit)

      if (results.length > 0) {
        const anyStale = results.some((c) =>
          isCacheStale(c.fetched_at, cacheConfig.staleness.dialogs),
        )
        success({
          query,
          results: results.map(chatRowToItem),
          total: results.length,
          source: 'cache',
          stale: anyStale,
        })
        return
      }

      success({
        query,
        results: [],
        total: 0,
        source: 'cache',
        stale: false,
        message:
          'No results in cache. Run "tg chats list --fresh" to populate cache first.',
      })
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Search failed: ${message}`)
    }
  },
})
