import { defineCommand } from 'citty'

import { getCacheDb } from '../../db'
import { createMessagesSearch } from '../../db/messages-search'
import { ErrorCodes, type MessageSearchItem } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import {
  isUsernameIdentifier,
  normalizeUsername,
} from '../../utils/identifiers'
import { error, success } from '../../utils/output'

function parseIdentifier(
  input: string | undefined,
): { id?: number; username?: string } | undefined {
  if (!input) return undefined

  if (isUsernameIdentifier(input)) {
    return { username: normalizeUsername(input) }
  }

  return { id: Number.parseInt(input, 10) }
}

function rowToItem(
  row: ReturnType<ReturnType<typeof createMessagesSearch>['search']>[number],
): MessageSearchItem {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    fromId: row.from_id,
    text: row.text,
    messageType: row.message_type,
    hasMedia: row.has_media === 1,
    mediaPath: row.media_path,
    isOutgoing: row.is_outgoing === 1,
    isEdited: row.is_edited === 1,
    isPinned: row.is_pinned === 1,
    isDeleted: row.is_deleted === 1,
    replyToId: row.reply_to_id,
    forwardFromId: row.forward_from_id,
    editDate: row.edit_date,
    date: row.date,
    chat: {
      id: row.chat_id,
      title: row.chat_title,
      username: row.chat_username,
      type: row.chat_type,
    },
    sender: {
      id: row.from_id,
      username: row.sender_username,
      firstName: row.sender_first_name,
      lastName: row.sender_last_name,
    },
  }
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
        results: results.map(rowToItem),
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
