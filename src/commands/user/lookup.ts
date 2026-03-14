import type { TelegramClient } from '@mtcute/bun'
import type { tl } from '@mtcute/tl'
import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../../config'
import { getCacheDb } from '../../db'
import { isCacheStale } from '../../db/types'
import { createUsersCache } from '../../db/users-cache'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import { toLong } from '../../utils/long'
import { error, success, verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../../utils/telegram-rate-limits'
import {
  apiUserToUserInfo,
  cachedUserToUserInfo,
  findCachedUser,
  parseUserIdentifier,
} from './helpers'

type TelegramClientLike = Pick<TelegramClient, 'call'>

function isRawUser(user: tl.TypeUser): user is tl.RawUser {
  return user._ === 'user'
}

async function resolveUserByUsername(
  client: TelegramClientLike,
  username: string,
): Promise<tl.RawUser | undefined> {
  const request: tl.contacts.RawResolveUsernameRequest = {
    _: 'contacts.resolveUsername',
    username,
  }
  return (await client.call(request)).users?.find(isRawUser)
}

async function resolveUserByPhone(
  client: TelegramClientLike,
  phone: string,
): Promise<tl.RawUser | undefined> {
  const request: tl.contacts.RawResolvePhoneRequest = {
    _: 'contacts.resolvePhone',
    phone,
  }
  return (await client.call(request)).users?.find(isRawUser)
}

async function resolveUserById(
  client: TelegramClientLike,
  identifier: string,
): Promise<tl.RawUser | undefined> {
  const userId = Number.parseInt(identifier, 10)
  const request: tl.users.RawGetUsersRequest = {
    _: 'users.getUsers',
    id: [{ _: 'inputUser', userId, accessHash: toLong(0) }],
  }
  return (await client.call(request)).find(isRawUser)
}

async function resolveUserFromApi(
  client: TelegramClientLike,
  parsed: ReturnType<typeof parseUserIdentifier>,
): Promise<tl.RawUser | undefined> {
  if (parsed.kind === 'username') {
    verbose(`Resolving username: ${parsed.value}`)
    return resolveUserByUsername(client, parsed.value)
  }

  if (parsed.kind === 'phone') {
    verbose(`Resolving phone: ${parsed.value}`)
    return resolveUserByPhone(client, parsed.value)
  }

  verbose(`Fetching user ID: ${parsed.value}`)
  return resolveUserById(client, parsed.value)
}

function handleUserLookupError(err: unknown): never {
  const errMsg = err instanceof Error ? err.message : String(err)
  if (errMsg.includes('USERNAME_NOT_OCCUPIED')) {
    error(ErrorCodes.TELEGRAM_ERROR, 'Username not found')
  }
  if (errMsg.includes('PHONE_NOT_OCCUPIED')) {
    error(ErrorCodes.TELEGRAM_ERROR, 'Phone number not found')
  }
  error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${errMsg}`)
}

export const userCommand = defineCommand({
  meta: {
    name: 'user',
    description: 'Look up a user by ID, @username, or phone number',
  },
  args: {
    identifier: {
      type: 'positional',
      description: 'User ID, @username, or phone number',
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
    try {
      const identifier = args.identifier as string
      const accountId = resolveAccountSelector(args.account)
      const fresh = args.fresh ?? false

      const parsed = parseUserIdentifier(identifier)

      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      if (!fresh) {
        const cached = findCachedUser(usersCache, parsed)
        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.peers,
          )

          verbose(`Returning cached user (stale: ${stale})`)
          success({
            user: cachedUserToUserInfo(cached),
            source: 'cache' as const,
            stale,
          })
          return
        }
      }

      verbose('Fetching user from API...')
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:user.lookup' },
      )

      const user = await resolveUserFromApi(client, parsed)

      if (!user) {
        error(ErrorCodes.TELEGRAM_ERROR, `User not found: ${identifier}`)
      }

      usersCache.upsert(apiUserToCacheInput(user))

      success({
        user: apiUserToUserInfo(user),
        source: 'api' as const,
        stale: false,
      })
    } catch (err: unknown) {
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
      handleUserLookupError(err)
    }
  },
})
