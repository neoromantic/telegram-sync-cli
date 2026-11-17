/**
 * Chat history reads over messages_cache, in message ID order. Rows have the
 * same columns and joins as search results, so both print the same items.
 */
import type { Database } from 'bun:sqlite'

import {
  MESSAGE_ROW_COLUMNS,
  MESSAGE_ROW_JOINS,
  type MessageSearchRow,
} from './messages-search'

export interface HistoryListOptions {
  limit: number
  /** Only messages with a smaller ID (exclusive) */
  before?: number
  /** Only messages with a larger ID (exclusive) */
  after?: number
  includeDeleted?: boolean
  /** Only messages the account received */
  incomingOnly?: boolean
}

export interface MessagesHistory {
  /**
   * One page of a chat, newest first. Without `after` it is the newest
   * `limit` messages below `before`; with `after` it is the `limit`
   * messages right above `after`.
   */
  list(chatId: number, options: HistoryListOptions): MessageSearchRow[]
  /** The given messages of a chat, newest first, deleted ones included */
  getMany(chatId: number, messageIds: number[]): MessageSearchRow[]
  /** How many incoming messages above `after` are cached, deleted ones not */
  countIncomingAfter(chatId: number, after: number): number
}

export function createMessagesHistory(db: Database): MessagesHistory {
  return {
    list(
      chatId,
      { limit, before, after, includeDeleted = false, incomingOnly = false },
    ) {
      const conditions = ['m.chat_id = ?']
      const params: number[] = [chatId]

      if (!includeDeleted) {
        conditions.push('m.is_deleted = 0')
      }
      if (incomingOnly) {
        conditions.push('m.is_outgoing = 0')
      }
      if (before !== undefined) {
        conditions.push('m.message_id < ?')
        params.push(before)
      }
      if (after !== undefined) {
        conditions.push('m.message_id > ?')
        params.push(after)
      }
      params.push(limit)

      // The primary key (chat_id, message_id) serves both directions
      const order = after !== undefined ? 'ASC' : 'DESC'
      const rows = db
        .query(`
          SELECT ${MESSAGE_ROW_COLUMNS}
          FROM messages_cache m
          ${MESSAGE_ROW_JOINS}
          WHERE ${conditions.join(' AND ')}
          ORDER BY m.message_id ${order}
          LIMIT ?
        `)
        .all(...params) as MessageSearchRow[]

      return after !== undefined ? rows.reverse() : rows
    },

    getMany(chatId, messageIds) {
      if (messageIds.length === 0) return []

      const placeholders = messageIds.map(() => '?').join(', ')
      return db
        .query(`
          SELECT ${MESSAGE_ROW_COLUMNS}
          FROM messages_cache m
          ${MESSAGE_ROW_JOINS}
          WHERE m.chat_id = ? AND m.message_id IN (${placeholders})
          ORDER BY m.message_id DESC
        `)
        .all(chatId, ...messageIds) as MessageSearchRow[]
    },

    countIncomingAfter(chatId, after) {
      const row = db
        .query(`
          SELECT COUNT(*) AS n FROM messages_cache
          WHERE chat_id = ? AND message_id > ?
            AND is_outgoing = 0 AND is_deleted = 0
        `)
        .get(chatId, after) as { n: number }
      return row.n
    },
  }
}
