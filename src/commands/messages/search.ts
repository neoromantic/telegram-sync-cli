import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { createMessagesSearch } from '../../db/messages-search'
import { ErrorCodes } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { error, success } from '../../utils/output'
import { messageRowToItem } from './helpers'

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
    description: 'Search cached messages using full-text search',
  },
  args: {
    query: {
      type: 'string',
      description: 'FTS query (e.g., "hello" or "sender:alice")',
      required: true,
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

    const chatFilter = parseIdentifier(args.chat)
    const senderFilter = parseIdentifier(args.sender)
    resolveAccountSelector(args.account)

    try {
      const cacheDb = getCacheDb()
      const search = createMessagesSearch(cacheDb)

      const results = search.search(query, {
        limit,
        offset,
        includeDeleted: args.includeDeleted ?? false,
        chatId: chatFilter?.id,
        chatUsername: chatFilter?.username,
        senderId: senderFilter?.id,
        senderUsername: senderFilter?.username,
      })

      success({
        query,
        filters: {
          chat: args.chat ?? null,
          sender: args.sender ?? null,
          includeDeleted: args.includeDeleted ?? false,
        },
        results: results.map(messageRowToItem),
        total: results.length,
        limit,
        offset,
        source: 'cache',
        stale: false,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Search failed: ${message}`)
    }
  },
})
