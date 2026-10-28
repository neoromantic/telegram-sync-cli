/**
 * Messages search service using FTS5
 */
import type { Database } from 'bun:sqlite'

/** Characters and words that make a query FTS5 syntax rather than plain words */
const FTS5_SYNTAX =
  /["*:()^+]|(?<![\p{L}\p{N}_])(?:AND|OR|NOT|NEAR)(?![\p{L}\p{N}_])/u

/** Whether a query uses FTS5 syntax: phrases, operators, prefixes or column filters */
export function hasFts5Syntax(query: string): boolean {
  return FTS5_SYNTAX.test(query)
}

/** A string as one FTS5 phrase, inner double quotes doubled */
function quotePhrase(text: string): string {
  return `"${text.replace(/"/g, '""')}"`
}

/**
 * The FTS5 MATCH expression for a user query. A plain query matches every
 * word in any order: each word is quoted, so punctuation (`don't`, `e-mail`)
 * is never syntax. A query with FTS5 syntax goes to FTS5 as written, and
 * `phrase` makes the whole query one phrase.
 */
export function toFts5Query(
  query: string,
  options: { phrase?: boolean } = {},
): string {
  if (options.phrase) return quotePhrase(query)
  if (hasFts5Syntax(query)) return query
  return query.split(/\s+/).filter(Boolean).map(quotePhrase).join(' ')
}

/**
 * Whether an error is FTS5 rejecting the query: a syntax error, an unknown
 * column filter (`foo:bar`, `10:30`) or an unclosed quote. The search's own
 * SQL never changes, so these come from the query.
 */
export function isFts5QueryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /^fts5:|no such column|unterminated string|unknown special query/i.test(
    message,
  )
}

/**
 * The columns of a message row: the message plus its chat and sender from the
 * cache. Every command that prints messages selects these, from
 * `messages_cache m` joined with `MESSAGE_ROW_JOINS`, so items look the same
 * everywhere.
 */
export const MESSAGE_ROW_COLUMNS = `
  m.chat_id,
  m.message_id,
  m.from_id,
  m.text,
  m.message_type,
  m.has_media,
  m.media_path,
  m.is_outgoing,
  m.is_edited,
  m.is_pinned,
  m.is_deleted,
  m.reply_to_id,
  m.forward_from_id,
  m.edit_date,
  m.date,
  m.fetched_at,
  c.title as chat_title,
  c.username as chat_username,
  c.type as chat_type,
  u.username as sender_username,
  u.first_name as sender_first_name,
  u.last_name as sender_last_name`

/** The chat and sender joins that `MESSAGE_ROW_COLUMNS` reads from */
export const MESSAGE_ROW_JOINS = `
  LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT)
  LEFT JOIN users_cache u ON u.user_id = CAST(m.from_id AS TEXT)`

export interface MessageSearchOptions {
  limit?: number
  offset?: number
  chatId?: number
  chatUsername?: string
  senderId?: number
  senderUsername?: string
  includeDeleted?: boolean
  /** Match the whole query as one phrase */
  phrase?: boolean
}

export interface MessageSearchRow {
  chat_id: number
  message_id: number
  from_id: number | null
  text: string | null
  message_type: string
  has_media: number
  media_path: string | null
  is_outgoing: number
  is_edited: number
  is_pinned: number
  is_deleted: number
  reply_to_id: number | null
  forward_from_id: number | null
  edit_date: number | null
  date: number
  fetched_at: number
  chat_title: string | null
  chat_username: string | null
  chat_type: string | null
  sender_username: string | null
  sender_first_name: string | null
  sender_last_name: string | null
}

export interface MessagesSearchService {
  search(query: string, options?: MessageSearchOptions): MessageSearchRow[]
}

export function createMessagesSearch(db: Database): MessagesSearchService {
  return {
    search(
      query: string,
      options: MessageSearchOptions = {},
    ): MessageSearchRow[] {
      const limit = options.limit ?? 50
      const offset = options.offset ?? 0
      const includeDeleted = options.includeDeleted ?? false

      const conditions: string[] = ['message_search MATCH ?']
      const params: Array<string | number> = [
        toFts5Query(query, { phrase: options.phrase }),
      ]

      if (!includeDeleted) {
        conditions.push('m.is_deleted = 0')
      }

      if (options.chatId !== undefined) {
        conditions.push('m.chat_id = ?')
        params.push(options.chatId)
      }

      if (options.chatUsername) {
        conditions.push('c.username = ? COLLATE NOCASE')
        params.push(options.chatUsername)
      }

      if (options.senderId !== undefined) {
        conditions.push('m.from_id = ?')
        params.push(options.senderId)
      }

      if (options.senderUsername) {
        conditions.push('u.username = ? COLLATE NOCASE')
        params.push(options.senderUsername)
      }

      params.push(limit, offset)

      const sql = `
        SELECT ${MESSAGE_ROW_COLUMNS}
        FROM message_search
        JOIN messages_cache m ON m.rowid = message_search.rowid
        ${MESSAGE_ROW_JOINS}
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.date DESC
        LIMIT ? OFFSET ?
      `

      return db.query(sql).all(...params) as MessageSearchRow[]
    },
  }
}
