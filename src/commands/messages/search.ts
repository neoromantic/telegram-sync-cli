import { type ArgsDef, defineCommand } from 'citty'

import {
  createMessagesSearch,
  isFts5QueryError,
  MESSAGE_SEARCH_SORTS,
  type MessageSearchSort,
} from '../../db/messages-search'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { normalizeUsername } from '../../utils/identifiers'
import { error, success } from '../../utils/output'
import { buildSnippet, snippetTerms } from '../../utils/search-snippet'
import { allowedChatIds } from '../access'
import { nextCommand } from '../next'
import {
  parseTimeWindow,
  parseTypeArg,
  SINCE_ARG_DESCRIPTION,
  TYPE_ARG_DESCRIPTION,
  UNTIL_ARG_DESCRIPTION,
} from './filters'
import { messageItemReader } from './helpers'

/**
 * A --chat or --sender value: an ID as tg prints it, a username (with or
 * without @), or me, the account's own user ID (Saved Messages as a chat).
 * Anything else is INVALID_ARGS, never a filter that matches nothing.
 */
function parseIdentifier(
  input: string | undefined,
  name: 'chat' | 'sender',
  selfId: number | null,
): { id?: number; username?: string } | undefined {
  if (!input) return undefined
  const value = input.trim()

  if (value.toLowerCase() === 'me') {
    if (selfId === null) {
      error(
        ErrorCodes.INVALID_ARGS,
        `--${name} me: the account's own user ID is not known yet`,
        { [name]: input },
        'Run tg me once (it saves the ID), or pass your user ID',
      )
    }
    return { id: selfId }
  }
  if (/^-?\d+$/.test(value)) return { id: Number(value) }
  if (/^@?[a-z]\w*$/i.test(value)) return { username: normalizeUsername(value) }

  error(
    ErrorCodes.INVALID_ARGS,
    `Invalid --${name}: ${input}`,
    { [name]: input },
    'Use an ID as tg prints it, an @username or me',
  )
}

const searchArgs = {
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
    description: 'Filter by chat ID, @username or me (Saved Messages)',
  },
  sender: {
    type: 'string',
    description: 'Filter by sender ID, @username or me (your own messages)',
  },
  includeDeleted: {
    type: 'boolean',
    description: 'Include deleted messages',
    default: false,
  },
  since: {
    type: 'string',
    description: SINCE_ARG_DESCRIPTION,
  },
  until: {
    type: 'string',
    description: UNTIL_ARG_DESCRIPTION,
  },
  type: {
    type: 'string',
    description: TYPE_ARG_DESCRIPTION,
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
} satisfies ArgsDef

export const searchMessagesCommand = defineCommand({
  meta: {
    name: 'search',
    description:
      'Search cached messages, newest first. hello world finds messages with both words in any order; FTS5 syntax works as written: error OR timeout, "exact phrase", sender:alice, chat:team, квартир* for every word form',
  },
  args: searchArgs,
  async run({ args, rawArgs }) {
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

    const { since, until } = parseTimeWindow(args)
    const types = parseTypeArg(rawArgs ?? [], searchArgs)

    const { account, db: cacheDb } = openAccountCache(args.account)
    const chatFilter = parseIdentifier(args.chat, 'chat', account.user_id)
    const senderFilter = parseIdentifier(args.sender, 'sender', account.user_id)
    const allowed = await allowedChatIds(account.id)

    try {
      const search = createMessagesSearch(cacheDb)

      const options = {
        includeDeleted: args.includeDeleted ?? false,
        phrase: args.phrase ?? false,
        chatId: chatFilter?.id,
        chatIds: allowed === null ? undefined : [...allowed],
        chatUsername: chatFilter?.username,
        senderId: senderFilter?.id,
        senderUsername: senderFilter?.username,
        since,
        until,
        types,
      }
      // One row past the page says whether another page follows
      const rows = search.search(query, {
        ...options,
        limit: limit + 1,
        offset,
        sort,
      })
      const results = rows.slice(0, limit)
      const next =
        rows.length > limit
          ? [
              nextCommand(
                'messages search',
                searchArgs,
                {
                  ...args,
                  query,
                  type: types?.join(','),
                  limit,
                  offset: offset + limit,
                },
                'The next page of results.',
              ),
            ]
          : []
      const count = args.count ? search.count(query, options) : null
      const terms = args.snippet
        ? snippetTerms(query, { phrase: options.phrase })
        : []
      const toItem = messageItemReader(cacheDb)

      success(
        {
          query,
          filters: {
            chat: args.chat ?? null,
            sender: args.sender ?? null,
            includeDeleted: args.includeDeleted ?? false,
            phrase: args.phrase ?? false,
            since: args.since ?? null,
            until: args.until ?? null,
            type: types ?? null,
          },
          sort,
          results: results.map((row) => {
            const item = toItem(row)
            return args.snippet
              ? { ...item, snippet: buildSnippet(item.text, terms) }
              : item
          }),
          total: results.length,
          count,
          limit,
          offset,
          source: 'cache',
          stale: false,
        },
        next,
      )
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
