import type { Database } from 'bun:sqlite'
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
import { findCachedChatById } from './lookup'

function isResolvedChat(peer: tl.TypeChat | undefined): peer is ResolvedChat {
  return Boolean(peer && peer._ !== 'chatEmpty')
}

/**
 * The cached chat for @username or an ID, as findCachedChatById reads it: a
 * marked ID, a user's private chat, or a bare group or channel ID as 0.2.0
 * printed it, unless it names two cached chats.
 */
function findCachedChat(db: Database, identifier: string, isUsername: boolean) {
  if (isUsername) return createChatsCache(db).getByUsername(identifier)
  return findCachedChatById(db, identifier)
}

function getCachedChat(
  db: Database,
  identifier: string,
  isUsername: boolean,
  cacheConfig: Awaited<ReturnType<typeof getResolvedCacheConfig>>,
) {
  const cached = findCachedChat(db, identifier, isUsername)
  if (!cached) return null

  const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.dialogs)
  return {
    ...chatRowToItem(cached),
    source: 'cache',
    stale,
  }
}

/**
 * Telegram is asked by @username only, so an ID the cache doesn't answer
 * fails before any account or credentials are needed
 */
function assertUsernameIdentifier(
  isUsername: boolean,
  identifier: string,
  fresh: boolean,
): void {
  if (isUsername) return
  if (fresh) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Fetching chat ${identifier} by ID is not supported yet; --fresh needs @username`,
      { identifier },
      'Use @username, or drop --fresh to read the cache',
    )
  }
  error(
    ErrorCodes.INVALID_ARGS,
    `Chat ${identifier} is not in the cache; fetching by ID is not supported yet`,
    { identifier },
    'Start the daemon (its dialog pass caches every chat, archived ones too) or use @username',
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
          cacheDb,
          identifier,
          isUsername,
          cacheConfig,
        )
        if (cached) {
          success(cached)
          return
        }
      }

      assertUsernameIdentifier(isUsername, identifier, fresh)
      verbose(`Fetching chat "${identifier}" from Telegram API...`)
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:chats.get' },
      )

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
