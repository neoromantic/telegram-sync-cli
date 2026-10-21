import type { tl } from '@mtcute/bun'
import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../../config'
import { getCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import { isCacheStale } from '../../db/types'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { error, success, verbose } from '../../utils/output'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../../utils/telegram-rate-limits'
import { resolveUsername } from '../../utils/telegram-resolve'
import { AmbiguousPeerError } from '../send/peer-resolver'
import {
  chatRowToItem,
  type ResolvedChat,
  rawChatToCacheInput,
  userToPrivateChatCacheInput,
} from './helpers'

function isResolvedChat(peer: tl.TypeChat | undefined): peer is ResolvedChat {
  return Boolean(peer && peer._ !== 'chatEmpty')
}

/**
 * The cached chat for @username or a marked ID. A bare group or channel ID
 * as 0.2.0 printed it matches too, unless it names two cached chats.
 */
function findCachedChat(
  chatsCache: ReturnType<typeof createChatsCache>,
  identifier: string,
  isUsername: boolean,
) {
  if (isUsername) return chatsCache.getByUsername(identifier)

  const exact = chatsCache.getById(identifier)
  if (exact || !/^\d+$/.test(identifier)) return exact

  const legacy = chatsCache.getByLegacyId(Number(identifier))
  if (legacy.length > 1) {
    throw new AmbiguousPeerError(
      identifier,
      legacy.map((chat) => Number(chat.chat_id)),
    )
  }
  return legacy[0] ?? null
}

function getCachedChat(
  chatsCache: ReturnType<typeof createChatsCache>,
  identifier: string,
  isUsername: boolean,
  cacheConfig: Awaited<ReturnType<typeof getResolvedCacheConfig>>,
) {
  const cached = findCachedChat(chatsCache, identifier, isUsername)
  if (!cached) return null

  const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.dialogs)
  return {
    ...chatRowToItem(cached),
    source: 'cache',
    stale,
  }
}

function assertUsernameIdentifier(
  isUsername: boolean,
  identifier: string,
): void {
  if (isUsername) return
  error(
    ErrorCodes.INVALID_ARGS,
    'Fetching by numeric ID is not yet supported. Use @username instead.',
    { identifier },
  )
}

async function fetchChatFromApi(
  chatsCache: ReturnType<typeof createChatsCache>,
  client: ReturnType<typeof wrapClientCallWithRateLimits>,
  identifier: string,
) {
  const resolved = await resolveUsername(client, identifier)
  const resolvedChat = resolved.chats?.[0]
  const resolvedUser = resolved.users?.find(
    (user): user is tl.RawUser => user._ === 'user',
  )

  if (!resolvedChat && !resolvedUser) {
    error(
      ErrorCodes.TELEGRAM_ERROR,
      `Chat @${normalizeUsername(identifier)} not found`,
    )
  }

  if (resolvedUser) {
    const cacheInput = userToPrivateChatCacheInput(resolvedUser)
    chatsCache.upsert(cacheInput)
    return {
      ...chatRowToItem(cacheInput),
      source: 'api',
      stale: false,
    }
  }

  if (!isResolvedChat(resolvedChat)) {
    error(
      ErrorCodes.TELEGRAM_ERROR,
      `Chat @${normalizeUsername(identifier)} not found`,
    )
  }

  const cacheInput = rawChatToCacheInput(resolvedChat)

  chatsCache.upsert(cacheInput)
  verbose('Cached chat data')

  return {
    ...chatRowToItem(cacheInput),
    source: 'api',
    stale: false,
  }
}

export const getChatCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get chat information by ID or username',
  },
  args: {
    id: {
      type: 'string',
      description: 'Chat ID or @username',
      required: true,
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
    const identifier = args.id
    const accountId = resolveAccountSelector(args.account)
    const fresh = args.fresh ?? false
    const isUsername = isUsernameIdentifier(identifier)

    try {
      const cacheDb = getCacheDb()
      const chatsCache = createChatsCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      if (!fresh) {
        const cached = getCachedChat(
          chatsCache,
          identifier,
          isUsername,
          cacheConfig,
        )
        if (cached) {
          success(cached)
          return
        }
      }

      verbose(`Fetching chat "${identifier}" from Telegram API...`)
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:chats.get' },
      )

      assertUsernameIdentifier(isUsername, identifier)
      const result = await fetchChatFromApi(chatsCache, client, identifier)
      success(result)
    } catch (err) {
      if (err instanceof AmbiguousPeerError) {
        error(ErrorCodes.INVALID_ARGS, err.message, {
          identifier,
          candidates: err.candidates,
        })
      }
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
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get chat: ${message}`)
    }
  },
})
