import type { Dialog, TelegramClient, tl } from '@mtcute/bun'
import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../../config'
import { getCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import type { ChatType } from '../../db/types'
import { createUsersCache } from '../../db/users-cache'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes, type PaginatedResult } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import { buildCachePaginatedResponse } from '../../utils/cache-pagination'
import { error, success, verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../../utils/telegram-rate-limits'
import {
  CHAT_TYPE_VALUES,
  chatRowToItem,
  dialogToCacheInput,
  filterChatsByType,
  isValidChatType,
} from './helpers'

type DialogCollectorClient = Pick<TelegramClient, 'iterDialogs'>

async function collectDialogs(
  client: DialogCollectorClient,
): Promise<{ dialogs: Dialog[]; users: tl.RawUser[] }> {
  const dialogs: Dialog[] = []
  const users: tl.RawUser[] = []

  for await (const dialog of client.iterDialogs({ limit: 200 })) {
    dialogs.push(dialog)
    if (dialog.peer.type === 'user') {
      users.push(dialog.peer.raw)
    }
  }

  return { dialogs, users }
}

export const listChatsCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List chats and dialogs with pagination',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of chats to return (default: 50)',
      default: '50',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination (default: 0)',
      default: '0',
    },
    type: {
      type: 'string',
      description: `Filter by chat type: ${CHAT_TYPE_VALUES.join(', ')} (default: all)`,
    },
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
    const limit = Number.parseInt(args.limit ?? '50', 10)
    const offset = Number.parseInt(args.offset ?? '0', 10)
    const accountId = resolveAccountSelector(args.account)
    const fresh = args.fresh ?? false
    const rawType = args.type
    const typeFilter = rawType as ChatType | undefined

    if (rawType && !isValidChatType(rawType)) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid chat type: ${rawType}. Must be one of: ${CHAT_TYPE_VALUES.join(', ')}`,
      )
    }

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      if (!fresh) {
        const cachedChats = chatsCache.list({
          limit: 1000,
          type: typeFilter,
          orderBy: 'last_message_at',
        })

        if (cachedChats.length > 0) {
          const response = buildCachePaginatedResponse(
            cachedChats,
            chatRowToItem,
            {
              offset,
              limit,
              ttlMs: cacheConfig.staleness.dialogs,
              source: 'cache',
            },
          )

          success(response)
          return
        }
      }

      verbose('Fetching dialogs from Telegram API...')
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:chats.list' },
      )

      const { dialogs, users } = await collectDialogs(client)

      const usersCache = createUsersCache(cacheDb)
      const userInputs = users.map(apiUserToCacheInput)
      if (userInputs.length > 0) {
        usersCache.upsertMany(userInputs)
        verbose(`Cached ${userInputs.length} users from dialogs`)
      }

      const chatInputs = dialogs.map(dialogToCacheInput)
      chatsCache.upsertMany(chatInputs)
      verbose(`Cached ${chatInputs.length} dialogs`)

      const filteredChats = filterChatsByType(chatInputs, typeFilter)
      filteredChats.sort(
        (a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0),
      )

      const paginatedChats = filteredChats.slice(offset, offset + limit)
      const items = paginatedChats.map(chatRowToItem)

      const response: PaginatedResult<ReturnType<typeof chatRowToItem>> & {
        source: string
        stale: boolean
      } = {
        items,
        total: filteredChats.length,
        offset,
        limit,
        hasMore: offset + limit < filteredChats.length,
        source: 'api',
        stale: false,
      }

      success(response)
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
      if (isRateLimitError(err)) {
        error(
          ErrorCodes.RATE_LIMITED,
          `Rate limited for ${err.method}. Wait ${err.waitSeconds}s before retrying.`,
          { method: err.method, wait_seconds: err.waitSeconds },
        )
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to fetch chats: ${message}`)
    }
  },
})
