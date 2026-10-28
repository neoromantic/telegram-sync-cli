import { defineCommand } from 'citty'

import {
  createMessagesSearch,
  isFts5QueryError,
  MESSAGE_SEARCH_SORTS,
  type MessageSearchSort,
} from '../../db/messages-search'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { error, success } from '../../utils/output'
import { buildSnippet, snippetTerms } from '../../utils/search-snippet'
import { parseTimeBound } from '../../utils/time-bounds'
import { messageRowToItem } from './helpers'

/** A --since/--until value as Unix seconds; INVALID_ARGS when it is none */
function parseBound(
  value: string | undefined,
  name: 'since' | 'until',
  now: number,
): number | undefined {
  if (value === undefined) return undefined
  const seconds = parseTimeBound(value, { now, end: name === 'until' })
  if (seconds === null) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid --${name}: ${value}`,
      { [name]: value },
      'Use a date (2026-10-01), a date and time (2026-10-01T09:30, local unless it ends with Z or an offset) or a duration back from now (30m, 24h, 7d, 2w)',
    )
  }
  return seconds
}

function parseIdentifier(
  input: string | undefined,
): { id?: number; username?: string } | undefined {
  if (!input) return undefined

  if (isUsernameIdentifier(input)) {
    return { username: normalizeUsername(input) }
  }

  return { id: Number.parseInt(input, 10) }
}

export const searchMessagesCommand = defineCommand({
  meta: {
    name: 'search',
    description:
      'Search cached messages, newest first. hello world finds messages with both words in any order; FTS5 syntax works as written: error OR timeout, "exact phrase", sender:alice, chat:team, квартир* for every word form',
  },
  args: {
    query: {
      type: 'string',
      description:
        'Words to find (all of them, any order), or an FTS5 query: error OR timeout, "exact phrase", sender:alice, chat:team, word*',
      required: true,
    },
    phrase: {
      type: 'boolean',
      description: 'Match the whole query as one exact phrase',
      default: false,
    },
    limit: {
      type: 'string',
      description: 'Maximum number of results (default: 50)',
      default: '50',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination (default: 0)',
      default: '0',
    },
    chat: {
      type: 'string',
      description: 'Filter by chat id or @username',
    },
    sender: {
      type: 'string',
      description: 'Filter by sender id or @username',
    },
    includeDeleted: {
      type: 'boolean',
      description: 'Include deleted messages',
      default: false,
    },
    since: {
      type: 'string',
      description:
        'Only messages sent at or after: a date (2026-10-01), a date and time (2026-10-01T09:30) or a duration back from now (24h, 7d)',
    },
    until: {
      type: 'string',
      description:
        'Only messages sent before: a date and time, a duration back from now, or a date (its whole day included)',
    },
    sort: {
      type: 'string',
      description:
        'Order: date (newest first, default) or relevance (best match first)',
      default: 'date',
    },
    snippet: {
      type: 'boolean',
      description:
        'Add a snippet to each result: the text around the first match, matched words in **',
      default: false,
    },
    count: {
      type: 'boolean',
      description:
        'Also count every message that matches the query and filters (a second query)',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const query = (args.query ?? '').trim()
    if (!query) {
      error(ErrorCodes.INVALID_ARGS, 'Search query is required')
    }

    const limit = Number.parseInt(args.limit ?? '50', 10)
    const offset = Number.parseInt(args.offset ?? '0', 10)

    if (!Number.isFinite(limit) || limit <= 0) {
      error(ErrorCodes.INVALID_ARGS, `Invalid limit: ${args.limit}`)
    }

    if (!Number.isFinite(offset) || offset < 0) {
      error(ErrorCodes.INVALID_ARGS, `Invalid offset: ${args.offset}`)
    }

    const sort = (args.sort ?? 'date') as MessageSearchSort
    if (!MESSAGE_SEARCH_SORTS.includes(sort)) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid sort: ${args.sort}. Use 'date' or 'relevance'.`,
      )
    }

    const now = Date.now()
    const since = parseBound(args.since, 'since', now)
    const until = parseBound(args.until, 'until', now)
    if (since !== undefined && until !== undefined && since >= until) {
      error(
        ErrorCodes.INVALID_ARGS,
        `--since (${args.since}) must be earlier than --until (${args.until})`,
      )
    }

    const chatFilter = parseIdentifier(args.chat)
    const senderFilter = parseIdentifier(args.sender)
    const { db: cacheDb } = openAccountCache(args.account)

    try {
      const search = createMessagesSearch(cacheDb)

      const options = {
        includeDeleted: args.includeDeleted ?? false,
        phrase: args.phrase ?? false,
        chatId: chatFilter?.id,
        chatUsername: chatFilter?.username,
        senderId: senderFilter?.id,
        senderUsername: senderFilter?.username,
        since,
        until,
      }
      const results = search.search(query, { ...options, limit, offset, sort })
      const count = args.count ? search.count(query, options) : null
      const terms = args.snippet
        ? snippetTerms(query, { phrase: options.phrase })
        : []

      success({
        query,
        filters: {
          chat: args.chat ?? null,
          sender: args.sender ?? null,
          includeDeleted: args.includeDeleted ?? false,
          phrase: args.phrase ?? false,
          since: args.since ?? null,
          until: args.until ?? null,
        },
        sort,
        results: results.map((row) =>
          args.snippet
            ? {
                ...messageRowToItem(row),
                snippet: buildSnippet(row.text, terms),
              }
            : messageRowToItem(row),
        ),
        total: results.length,
        count,
        limit,
        offset,
        source: 'cache',
        stale: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isFts5QueryError(err)) {
        error(
          ErrorCodes.INVALID_ARGS,
          `Invalid search query: ${message}`,
          { query },
          'Quote words with punctuation ("e-mail", "10:30"), or pass --phrase to match the query as written',
        )
      }
      error(ErrorCodes.GENERAL_ERROR, `Search failed: ${message}`, { query })
    }
  },
})
