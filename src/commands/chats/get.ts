import type { tl } from '@mtcute/tl'
import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../../config'
import { getCacheDb } from '../../db'
import { createChatsCache } from '../../db/chats-cache'
import { type ChatType, isCacheStale } from '../../db/types'
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
import {
  chatRowToItem,
  userToPrivateChatCacheInput,
} from './helpers'

type ResolvedChat = Exclude<tl.TypeChat, tl.RawChatEmpty>

function isChannelPeer(
  peer: tl.TypeChat,
): peer is tl.RawChannel | tl.RawChannelForbidden {
  return peer._ === 'channel' || peer._ === 'channelForbidden'
}

function isResolvedChat(peer: tl.TypeChat | undefined): peer is ResolvedChat {
  return Boolean(peer && peer._ !== 'chatEmpty')
}

function peerToChatType(peer: ResolvedChat): ChatType {
  if (isChannelPeer(peer)) {
    const isMega = 'megagroup' in peer && Boolean(peer.megagroup)
    const isGiga = 'gigagroup' in peer && Boolean(peer.gigagroup)
    return isMega || isGiga ? 'supergroup' : 'channel'
  }
  return 'group'
}

function getCachedChat(
  chatsCache: ReturnType<typeof createChatsCache>,
  identifier: string,
  isUsername: boolean,
  cacheConfig: Awaited<ReturnType<typeof getResolvedCacheConfig>>,
) {
  const cached = isUsername
    ? chatsCache.getByUsername(identifier)
    : chatsCache.getById(identifier)

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

  const peer = resolvedChat
  const type = peerToChatType(peer)

  const cacheInput = {
    chat_id: String(peer.id),
    type,
    title: 'title' in peer ? (peer.title ?? null) : null,
    username: 'username' in peer ? (peer.username ?? null) : null,
    member_count:
      'participantsCount' in peer ? (peer.participantsCount ?? null) : null,
    access_hash:
      isChannelPeer(peer) && peer.accessHash ? String(peer.accessHash) : null,
    is_creator: 'creator' in peer && peer.creator ? 1 : 0,
    is_admin: 'adminRights' in peer && peer.adminRights ? 1 : 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: JSON.stringify(peer),
  }

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
