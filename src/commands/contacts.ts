/**
 * Contact management commands with caching
 * Uses UsersCache for stale-while-revalidate pattern
 */
import type { tl } from '@mtcute/tl'
import { defineCommand } from 'citty'
import { ConfigError, getResolvedCacheConfig } from '../config'
import { getCacheDb } from '../db'
import { isCacheStale } from '../db/types'
import { createUsersCache } from '../db/users-cache'
import { getClientForAccount } from '../services/telegram'
import { type Contact, ErrorCodes, type PaginatedResult } from '../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../utils/account-selector'
import { buildCachePaginatedResponse } from '../utils/cache-pagination'
import { toLong } from '../utils/long'
import { error, success, verbose } from '../utils/output'
import {
  apiUserToCacheInput,
  apiUserToContact,
  cachedUserToContact,
} from '../utils/telegram-mappers'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../utils/telegram-rate-limits'

function isRawUser(user: tl.TypeUser): user is tl.RawUser {
  return user._ === 'user'
}

type RawUserWithAbout = tl.RawUser & { about?: string }

function hasAbout(user: tl.RawUser): user is RawUserWithAbout {
  return 'about' in user
}

/**
 * List contacts
 */
export const listContactsCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List contacts with pagination',
  },
  args: {
    limit: {
      type: 'string',
      description: 'Maximum number of contacts to return (default: 50)',
      default: '50',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination (default: 0)',
      default: '0',
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

    try {
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      // Check cache first (unless --fresh)
      if (!fresh) {
        const cachedUsers = usersCache.getAll({ limit: 1000 }) // Get all to check count
        const contacts = cachedUsers.filter((u) => u.is_contact === 1)

        if (contacts.length > 0) {
          const response = buildCachePaginatedResponse(
            contacts,
            cachedUserToContact,
            {
              offset,
              limit,
              ttlMs: cacheConfig.staleness.peers,
              source: 'cache',
            },
          )

          success(response as PaginatedResult<Contact>)
          return
        }
      }

      // Fetch from API
      verbose('Fetching contacts from Telegram API...')
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:contacts.list' },
      )

      const request: tl.contacts.RawGetContactsRequest = {
        _: 'contacts.getContacts',
        hash: toLong(0),
      }
      const result = await client.call(request)

      if (result._ === 'contacts.contactsNotModified') {
        success({
          items: [],
          total: 0,
          offset,
          limit,
          hasMore: false,
          source: 'api',
          stale: false,
          message: 'Contacts not modified since last fetch',
        })
        return
      }

      // Extract and cache users
      const apiUsers = result.users.filter(isRawUser)

      // Cache all users
      const cacheInputs = apiUsers.map(apiUserToCacheInput)
      usersCache.upsertMany(cacheInputs)
      verbose(`Cached ${cacheInputs.length} contacts`)

      // Map to our Contact type
      const allContacts: Contact[] = apiUsers.map(apiUserToContact)

      // Apply pagination
      const paginatedContacts = allContacts.slice(offset, offset + limit)

      const response: PaginatedResult<Contact> & {
        source: string
        stale: boolean
      } = {
        items: paginatedContacts,
        total: allContacts.length,
        offset,
        limit,
        hasMore: offset + limit < allContacts.length,
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
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to fetch contacts: ${message}`)
    }
  },
})

/**
 * Search contacts
 */
export const searchContactsCommand = defineCommand({
  meta: {
    name: 'search',
    description: 'Search contacts by name or username',
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
    fresh: {
      type: 'boolean',
      description: 'Bypass cache and search via API',
      default: false,
    },
  },
  async run({ args }) {
    const query = args.query
    const limit = Number.parseInt(args.limit ?? '20', 10)
    const accountId = resolveAccountSelector(args.account)
    const fresh = args.fresh ?? false

    try {
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      // Check cache first (unless --fresh)
      if (!fresh) {
        const cachedResults = usersCache.search(query, limit)

        if (cachedResults.length > 0) {
          const anyStale = cachedResults.some((u) =>
            isCacheStale(u.fetched_at, cacheConfig.staleness.peers),
          )

          success({
            query,
            results: cachedResults.map(cachedUserToContact),
            total: cachedResults.length,
            source: 'cache',
            stale: anyStale,
          })
          return
        }
      }

      // Search via API
      verbose(`Searching Telegram API for "${query}"...`)
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:contacts.search' },
      )

      const request: tl.contacts.RawSearchRequest = {
        _: 'contacts.search',
        q: query,
        limit,
      }
      const result = await client.call(request)

      // Extract and cache users
      const apiUsers = result.users.filter(isRawUser)

      // Cache results
      const cacheInputs = apiUsers.map(apiUserToCacheInput)
      if (cacheInputs.length > 0) {
        usersCache.upsertMany(cacheInputs)
        verbose(`Cached ${cacheInputs.length} search results`)
      }

      success({
        query,
        results: apiUsers.map(apiUserToContact),
        total: apiUsers.length,
        source: 'api',
        stale: false,
      })
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
      error(ErrorCodes.TELEGRAM_ERROR, `Search failed: ${message}`)
    }
  },
})

/**
 * Get contact by ID
 */
export const getContactCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Get contact information by user ID or username',
  },
  args: {
    id: {
      type: 'string',
      description: 'User ID or @username',
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

    try {
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const cacheConfig = await getResolvedCacheConfig()

      // Determine if ID or username
      const isUsername =
        identifier.startsWith('@') || Number.isNaN(Number(identifier))

      // Check cache first (unless --fresh)
      if (!fresh) {
        const cached = isUsername
          ? usersCache.getByUsername(identifier)
          : usersCache.getById(identifier)

        if (cached) {
          const stale = isCacheStale(
            cached.fetched_at,
            cacheConfig.staleness.peers,
          )

          success({
            id: Number(cached.user_id),
            firstName: cached.first_name ?? '',
            lastName: cached.last_name ?? null,
            username: cached.username ?? null,
            phone: cached.phone ?? null,
            isBot: cached.is_bot === 1,
            isPremium: cached.is_premium === 1,
            isContact: cached.is_contact === 1,
            source: 'cache',
            stale,
          })
          return
        }
      }

      // Fetch from API
      verbose(`Fetching user "${identifier}" from Telegram API...`)
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:contacts.get' },
      )

      let result: tl.TypeUser[]

      if (isUsername) {
        // Resolve username first
        const request: tl.contacts.RawResolveUsernameRequest = {
          _: 'contacts.resolveUsername',
          username: identifier.replace('@', ''),
        }
        const resolved = await client.call(request)

        if (!resolved.users || resolved.users.length === 0) {
          error(
            ErrorCodes.TELEGRAM_ERROR,
            `User @${identifier.replace('@', '')} not found`,
          )
        }

        result = resolved.users ?? []
      } else {
        // Get by user ID
        const userId = Number.parseInt(identifier, 10)
        const request: tl.users.RawGetUsersRequest = {
          _: 'users.getUsers',
          id: [{ _: 'inputUser', userId, accessHash: toLong(0) }],
        }
        result = await client.call(request)
      }

      const user = result.find(isRawUser)

      if (!user) {
        error(ErrorCodes.TELEGRAM_ERROR, `User "${identifier}" not found`)
      }

      // Cache the user
      usersCache.upsert(apiUserToCacheInput(user))
      verbose('Cached user data')

      success({
        id: user.id,
        firstName: user.firstName ?? '',
        lastName: user.lastName ?? null,
        username: user.username ?? null,
        phone: user.phone ?? null,
        bio:
          hasAbout(user) && typeof user.about === 'string' ? user.about : null,
        isBot: user.bot ?? false,
        isVerified: user.verified ?? false,
        isPremium: user.premium ?? false,
        isContact: user.contact ?? false,
        source: 'api',
        stale: false,
      })
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
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to get user: ${message}`)
    }
  },
})

/**
 * Contacts subcommand group
 */
export const contactsCommand = defineCommand({
  meta: {
    name: 'contacts',
    description: 'Contact management commands',
  },
  subCommands: {
    list: listContactsCommand,
    search: searchContactsCommand,
    get: getContactCommand,
  },
})
