/**
 * Messages search service using FTS5
 */
import type { Database } from 'bun:sqlite'

/**
 * What makes a query FTS5 syntax rather than plain words: `"`, `*`, `:`,
 * parentheses, `^` at the start of a word, `+` standing between phrases, or
 * an operator in capitals. A `+` or `^` inside a word (`C++`, `2^10`) is
 * punctuation.
 */
const FTS5_SYNTAX =
  /["*:()]|(?<!\S)\^(?=\S)|(?<![^\s"])\+(?![^\s"])|(?<![\p{L}\p{N}_])(?:AND|OR|NOT|NEAR)(?![\p{L}\p{N}_])/u

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

const CHAT_JOIN = `
  LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT)`
const SENDER_JOIN = `
  LEFT JOIN users_cache u ON u.user_id = CAST(m.from_id AS TEXT)`

/** The chat and sender joins that `MESSAGE_ROW_COLUMNS` reads from */
export const MESSAGE_ROW_JOINS = CHAT_JOIN + SENDER_JOIN

/**
 * The view message_search_text: the search index joined with each message,
 * its chat and its sender, so `tg sql` reads a match's text without writing
 * the join. Its column named like the view is the index's own column, so
 * `WHERE message_search_text MATCH ?` and `ORDER BY rank` go to FTS5. A
 * view outlives `DROP TABLE message_search` and reads the new table once it
 * is back, so a rebuilt index needs no new view. Created once, so opening a
 * cache that has it never waits for the write lock.
 */
export function createMessageSearchTextView(db: Database): void {
  const exists = db
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'message_search_text'`,
    )
    .get()
  if (exists) return

  db.run(`
    CREATE VIEW IF NOT EXISTS message_search_text AS
    SELECT
      message_search.message_search AS message_search_text,
      message_search.rank AS rank,
      m.rowid AS rowid,${MESSAGE_ROW_COLUMNS}
    FROM message_search
    JOIN messages_cache m ON m.rowid = message_search.rowid${MESSAGE_ROW_JOINS}
  `)
}

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
  /** Messages sent at or after this Unix time, in seconds */
  since?: number
  /** Messages sent before this Unix time, in seconds */
  until?: number
  /** Newest first (default), or best match first by FTS5 bm25 */
  sort?: MessageSearchSort
}

export const MESSAGE_SEARCH_SORTS = ['date', 'relevance'] as const
export type MessageSearchSort = (typeof MESSAGE_SEARCH_SORTS)[number]

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
  /** How many messages match, with the same filters and no page */
  count(query: string, options?: MessageSearchOptions): number
}

/** The WHERE conditions of a search besides the match, and their parameters */
function searchFilter(options: MessageSearchOptions): {
  conditions: string[]
  params: Array<string | number>
} {
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (!(options.includeDeleted ?? false)) {
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

  if (options.since !== undefined) {
    conditions.push('m.date >= ?')
    params.push(options.since)
  }

  if (options.until !== undefined) {
    conditions.push('m.date < ?')
    params.push(options.until)
  }

  return { conditions, params }
}

/**
 * The walk below runs when a query has at least T = sqrt(WALK_THRESHOLD * P
 * * N) matches, for a page of P (limit + offset) of N messages, and goes
 * through at most P * N / T messages, as many as a page needs at that share
 * of matches. Asking the search index about one message costs as much as
 * sorting tens to hundreds of matches (made-up caches of 1M and 10M
 * messages), so when the walk finds too few matches, counting and walking
 * add at most about 30% to the sort it falls back to (docs/search.md).
 */
const WALK_THRESHOLD = 900

/** Newest first; messages sent in the same second in the order they were cached */
const NEWEST_FIRST = 'm.date DESC, m.rowid'

/** The FROM of a search that reads every match from the index */
const MATCHES_FROM =
  'FROM message_search JOIN messages_cache m ON message_search MATCH ? AND m.rowid = message_search.rowid'

/**
 * One page of the messages that `from` joins as `m`, with the filters,
 * sorted by `order`
 */
function sortedPage(
  db: Database,
  from: string,
  fromParam: string,
  options: MessageSearchOptions,
  order: string,
): MessageSearchRow[] {
  const { conditions, params } = searchFilter(options)
  return db
    .query(
      `SELECT ${MESSAGE_ROW_COLUMNS}
       ${from}
       ${MESSAGE_ROW_JOINS}
       ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(
      fromParam,
      ...params,
      options.limit ?? 50,
      options.offset ?? 0,
    ) as MessageSearchRow[]
}

/** How the newest page was found: by going through the newest messages, or by sorting every match */
export type NewestFirstWay = 'messages' | 'sort'

/**
 * The newest page of a search. Sorting every match reads each one's
 * message, so a common query would take seconds; instead, when a query has
 * many matches, go through the newest messages (of the chat, between
 * --since and --until) in date order and ask the search index of each
 * whether it matches, until the page is full. The walk goes through a fixed
 * number of messages, the window; a page found there is the one sorting
 * every match gives, and a page that isn't full falls back to sorting. A
 * prefix query is always sorted. Tests pass a lower `walkThreshold` to
 * walk small caches.
 */
export function searchNewestFirst(
  db: Database,
  query: string,
  options: MessageSearchOptions = {},
  walkThreshold = WALK_THRESHOLD,
): { rows: MessageSearchRow[]; way: NewestFirstWay } {
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0
  const match = toFts5Query(query, { phrase: options.phrase })
  const sorted = () => ({
    rows: sortedPage(db, MATCHES_FROM, match, options, NEWEST_FIRST),
    way: 'sort' as const,
  })
  // A prefix stands for every word it starts, so asking the index about one
  // message reads all of them
  if (match.includes('*')) return sorted()

  // max(rowid) is about the number of messages, and instant
  const { maxRowid } = db
    .query('SELECT max(rowid) AS maxRowid FROM messages_cache')
    .get() as { maxRowid: number | null }
  const pageTimesMessages = (limit + offset) * (maxRowid ?? 0)
  const enough = Math.max(
    1,
    Math.ceil(Math.sqrt(walkThreshold * pageTimesMessages)),
  )

  // Reading matches from the index alone costs a fraction of sorting them,
  // and fewer than enough are all of them. The sort asks the index again,
  // which for one word costs about as much as counting; for a phrase or
  // several words it costs more than handing the sort the rowids read here
  const oneWord = /^"[^"\s]+"$/.test(match)
  const { matches, rowids } = db
    .query(
      `SELECT count(*) AS matches,
         ${oneWord ? 'NULL' : 'json_group_array(rowid)'} AS rowids
       FROM (SELECT rowid FROM message_search WHERE message_search MATCH ? LIMIT ?)`,
    )
    .get(match, enough) as { matches: number; rowids: string | null }
  if (matches < enough) {
    if (rowids === null) return sorted()
    const rows = sortedPage(
      db,
      'FROM json_each(?) AS j CROSS JOIN messages_cache m ON m.rowid = j.value',
      rowids,
      options,
      NEWEST_FIRST,
    )
    return { rows, way: 'sort' }
  }

  const window = Math.ceil(pageTimesMessages / enough)
  const index =
    options.chatId === undefined
      ? 'idx_messages_cache_newest'
      : 'idx_messages_cache_date'
  const range: string[] = []
  const rangeParams: number[] = []
  if (options.chatId !== undefined) {
    range.push('chat_id = ?')
    rangeParams.push(options.chatId)
  }
  if (options.since !== undefined) {
    range.push('date >= ?')
    rangeParams.push(options.since)
  }
  if (options.until !== undefined) {
    range.push('date < ?')
    rangeParams.push(options.until)
  }
  const where = range.length ? `WHERE ${range.join(' AND ')}` : ''

  // The window: the first `window` messages in range of an index that,
  // scanned forward, gives them newest first and, within a second, in rowid
  // order. That is a prefix of the order of the page, even when it ends
  // inside a second, so a full page found there is the right one. Ordering
  // by the window's columns keeps its order without sorting, and the walk
  // stops once the page is full
  const { conditions, params } = searchFilter(options)
  conditions.push(`EXISTS (
    SELECT 1 FROM message_search s
    WHERE s.message_search MATCH ? AND s.rowid = m.rowid)`)
  params.push(match)
  const rows = db
    .query(
      `SELECT ${MESSAGE_ROW_COLUMNS}
       FROM (
         SELECT date, rowid AS id FROM messages_cache INDEXED BY ${index}
         ${where}
         ORDER BY date DESC, rowid
         LIMIT ?
       ) w
       CROSS JOIN messages_cache m ON m.rowid = w.id
       ${MESSAGE_ROW_JOINS}
       WHERE ${conditions.join(' AND ')}
       ORDER BY w.date DESC, w.id
       LIMIT ? OFFSET ?`,
    )
    .all(...rangeParams, window, ...params, limit, offset) as MessageSearchRow[]
  if (rows.length === limit) return { rows, way: 'messages' }

  // A range shorter than the window was gone through whole
  const longer = db
    .query(
      `SELECT 1 FROM messages_cache INDEXED BY ${index} ${where}
       ORDER BY date DESC, rowid LIMIT 1 OFFSET ?`,
    )
    .get(...rangeParams, window)
  if (!longer) return { rows, way: 'messages' }
  return sorted()
}

export function createMessagesSearch(db: Database): MessagesSearchService {
  return {
    search(
      query: string,
      options: MessageSearchOptions = {},
    ): MessageSearchRow[] {
      if (options.sort !== 'relevance') {
        return searchNewestFirst(db, query, options).rows
      }
      // bm25 rank: lower is a better match
      return sortedPage(
        db,
        MATCHES_FROM,
        toFts5Query(query, { phrase: options.phrase }),
        options,
        `message_search.rank, ${NEWEST_FIRST}`,
      )
    },

    count(query: string, options: MessageSearchOptions = {}): number {
      const { conditions, params } = searchFilter(options)
      // Only the joins a filter reads: each message has one chat and one sender
      const row = db
        .query(
          `SELECT COUNT(*) AS n
           ${MATCHES_FROM}
           ${options.chatUsername ? CHAT_JOIN : ''}${options.senderUsername ? SENDER_JOIN : ''}
           ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
        )
        .get(toFts5Query(query, { phrase: options.phrase }), ...params) as {
        n: number
      }
      return row.n
    },
  }
}
