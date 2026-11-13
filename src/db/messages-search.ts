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
 * of matches. Sorting costs about 1 µs a match and the walk a few µs a
 * message (made-up caches of 1M messages, #149), so a walk through the
 * whole window costs about a fifth of the least the sort can cost
 * (docs/search.md).
 */
const WALK_THRESHOLD = 20

/**
 * The walk stops and sorts once it has taken this share of the least the
 * sort can take: about 1 µs for each of at least T matches. So a walk that
 * finds too few matches adds at most about a quarter to the sort, even on
 * an index that still holds many deleted entries, which answers in
 * milliseconds instead of microseconds.
 */
const WALK_BUDGET_US_PER_MATCH = 0.25

/** Messages in the walk's first chunk; later chunks are what the budget left pays for */
const FIRST_CHUNK = 4

/**
 * One question to the index covers a run of rowids at most this far apart:
 * it costs as much as reading tens of entries of a word. History pages give
 * a chat's newest messages nearby rowids, and live messages too
 */
const ROWID_RUN_GAP = 32

/** Lower WALK_THRESHOLD, and the clock of the walk's budget, for tests */
export interface NewestFirstTuning {
  walkThreshold?: number
  now?: () => number
}

/** Newest first; messages sent in the same second in the order they were cached */
const NEWEST_FIRST = 'm.date DESC, m.rowid'

/** The FROM of a search of the messages with the rowids of a JSON array */
const ROWIDS_FROM =
  'FROM json_each(?) AS j CROSS JOIN messages_cache m ON m.rowid = j.value'

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
 * --since and --until) in date order, in chunks, and ask the search index
 * which of them match, until the page is full. The walk goes through at
 * most a fixed number of messages, the window, and stops at the budget of
 * its time; a page found there is the one sorting every match gives, and a
 * walk that ends without a full page falls back to sorting. A prefix query
 * is always sorted.
 */
export function searchNewestFirst(
  db: Database,
  query: string,
  options: MessageSearchOptions = {},
  tuning: NewestFirstTuning = {},
): { rows: MessageSearchRow[]; way: NewestFirstWay } {
  const now = tuning.now ?? (() => performance.now())
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0
  const match = toFts5Query(query, { phrase: options.phrase })
  const sorted = () => ({
    rows: sortedPage(db, MATCHES_FROM, match, options, NEWEST_FIRST),
    way: 'sort' as const,
  })
  // A prefix stands for every word it starts, so asking the index about a
  // few messages reads all of them
  if (match.includes('*')) return sorted()

  // max(rowid) is about the number of messages, and instant
  const { maxRowid } = db
    .query('SELECT max(rowid) AS maxRowid FROM messages_cache')
    .get() as { maxRowid: number | null }
  const pageTimesMessages = (limit + offset) * (maxRowid ?? 0)
  const enough = Math.max(
    1,
    Math.ceil(
      Math.sqrt((tuning.walkThreshold ?? WALK_THRESHOLD) * pageTimesMessages),
    ),
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
    const rows = sortedPage(db, ROWIDS_FROM, rowids, options, NEWEST_FIRST)
    return { rows, way: 'sort' }
  }

  const window = Math.ceil(pageTimesMessages / enough)
  const budgetMs = (enough * WALK_BUDGET_US_PER_MATCH) / 1000
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

  // A chunk: the messages from `walked` on in the order of an index that,
  // scanned forward, gives them newest first and, within a second, in rowid
  // order. The chunks one after another are a prefix of the order of the
  // page, even when one ends inside a second, so a full page found there is
  // the right one
  const chunkRowids = db.query(
    `SELECT rowid FROM messages_cache INDEXED BY ${index} ${where}
     ORDER BY date DESC, rowid LIMIT ? OFFSET ?`,
  )
  const matchesBetween = db.query(
    'SELECT rowid FROM message_search WHERE message_search MATCH ? AND rowid BETWEEN ? AND ?',
  )
  /** The rowids among `rowids` that match, one question to the index per run of nearby rowids */
  const matching = (rowids: number[]): Set<number> => {
    const runs: Array<[number, number]> = []
    for (const rowid of [...rowids].sort((a, b) => a - b)) {
      const run = runs.at(-1)
      if (run && rowid - run[1] <= ROWID_RUN_GAP) run[1] = rowid
      else runs.push([rowid, rowid])
    }
    const hits = new Set<number>()
    for (const [low, high] of runs) {
      for (const [rowid] of matchesBetween.values(match, low, high)) {
        hits.add(rowid as number)
      }
    }
    return hits
  }

  const wanted = limit + offset
  const found: MessageSearchRow[] = []
  const started = now()
  let walked = 0
  let chunk = FIRST_CHUNK
  while (walked < window) {
    const size = Math.min(chunk, window - walked)
    const rowids = chunkRowids
      .values(...rangeParams, size, walked)
      .map(([rowid]) => rowid as number)
    walked += size
    const hits = matching(rowids)
    const matched = rowids.filter((rowid) => hits.has(rowid))
    // The matches in the order of the chunk, which sorting keeps
    if (matched.length > 0) {
      found.push(
        ...sortedPage(
          db,
          ROWIDS_FROM,
          JSON.stringify(matched),
          { ...options, limit: wanted - found.length, offset: 0 },
          NEWEST_FIRST,
        ),
      )
    }
    // A range shorter than the window was gone through whole
    if (found.length === wanted || rowids.length < size) {
      return { rows: found.slice(offset), way: 'messages' }
    }
    const spent = now() - started
    if (spent >= budgetMs) return sorted()
    chunk = Math.max(
      FIRST_CHUNK,
      spent > 0 ? Math.floor(((budgetMs - spent) * walked) / spent) : walked,
    )
  }
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
