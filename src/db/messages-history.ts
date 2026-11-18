/**
 * Chat history reads over messages_cache, in message ID order. Rows have the
 * same columns and joins as search results, so both print the same items.
 */
import type { Database } from 'bun:sqlite'

import {
  MESSAGE_ROW_COLUMNS,
  MESSAGE_ROW_JOINS,
  type MessageSearchRow,
  messageTypeCondition,
} from './messages-search'

/** `tg messages list --type/--since/--until` */
export interface MessageFilter {
  /** MESSAGE_TYPE_FILTERS values */
  types?: readonly string[]
  /** Sent at or after this Unix time, in seconds */
  since?: number
  /** Sent before this Unix time, in seconds */
  until?: number
}

export interface HistoryListOptions {
  limit: number
  /** Only messages with a smaller ID (exclusive) */
  before?: number
  /** Only messages with a larger ID (exclusive) */
  after?: number
  includeDeleted?: boolean
  /** Only messages the account received */
  incomingOnly?: boolean
  filter?: MessageFilter
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
  /**
   * The lowest cached message ID from `low` to `high` sent at or after
   * `time`, deleted messages included
   */
  firstSentFrom(
    chatId: number,
    low: number,
    high: number,
    time: number,
  ): number | null
  /** The highest cached message ID from `low` to `high` sent before `time` */
  lastSentBefore(
    chatId: number,
    low: number,
    high: number,
    time: number,
  ): number | null
}

export function createMessagesHistory(db: Database): MessagesHistory {
  return {
    list(
      chatId,
      {
        limit,
        before,
        after,
        includeDeleted = false,
        incomingOnly = false,
        filter = {},
      },
    ) {
      const conditions = ['m.chat_id = ?']
      const params: Array<number | string> = [chatId]

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
      if (filter.since !== undefined) {
        conditions.push('m.date >= ?')
        params.push(filter.since)
      }
      if (filter.until !== undefined) {
        conditions.push('m.date < ?')
        params.push(filter.until)
      }
      if (filter.types !== undefined) {
        const typed = messageTypeCondition(filter.types)
        conditions.push(typed.condition)
        params.push(...typed.params)
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

    firstSentFrom(chatId, low, high, time) {
      const row = db
        .query(`
          SELECT MIN(message_id) AS id FROM messages_cache
          WHERE chat_id = ? AND message_id BETWEEN ? AND ? AND date >= ?
        `)
        .get(chatId, low, high, time) as { id: number | null }
      return row.id
    },

    lastSentBefore(chatId, low, high, time) {
      const row = db
        .query(`
          SELECT MAX(message_id) AS id FROM messages_cache
          WHERE chat_id = ? AND message_id BETWEEN ? AND ? AND date < ?
        `)
        .get(chatId, low, high, time) as { id: number | null }
      return row.id
    },
  }
}
