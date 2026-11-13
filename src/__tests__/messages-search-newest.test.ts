/**
 * The newest page of a common query (#118) goes through messages in date
 * order instead of sorting every match. It must return the same rows in the
 * same order as sorting every match by date, then rowid.
 */
import { Database } from 'bun:sqlite'
import { beforeAll, describe, expect, it } from 'bun:test'
import {
  createMessagesSearch,
  type MessageSearchOptions,
  searchNewestFirst,
  toFts5Query,
} from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

/** A seeded PRNG, so a failure repeats */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const MESSAGES = 12_000
const BASE_DATE = 1_700_000_000
const CHATS = [-1001000000001, -1001000000002, -200, 300, 301, 302]
// Most messages in the first chats; the last one has a few dozen
const CHAT_WEIGHTS = [0.45, 0.25, 0.15, 0.1, 0.045, 0.005]
const SENDERS = Array.from({ length: 20 }, (_, i) => 1000 + i)

const random = mulberry32(118)
const pick = <T>(items: readonly T[]): T =>
  items[Math.floor(random() * items.length)] as T

function pickChat(): number {
  let r = random()
  for (const [i, weight] of CHAT_WEIGHTS.entries()) {
    r -= weight
    if (r < 0) return CHATS[i] as number
  }
  return CHATS[0] as number
}

function messageText(): string {
  const words = ['filler', 'lorem', 'ipsum', 'dolor']
  const text = Array.from({ length: 3 }, () => pick(words))
  if (random() < 0.6) text.push('common')
  if (random() < 0.1) text.push('often')
  if (random() < 0.002) text.push('rare')
  return text.join(' ')
}

describe('search newest first (#118)', () => {
  const db = new Database(':memory:')

  beforeAll(() => {
    initCacheSchema(db)
    initSyncSchema(db)
    for (const [i, chatId] of CHATS.entries()) {
      db.query(
        `INSERT INTO chats_cache (chat_id, type, title, username, fetched_at, raw_json)
         VALUES (?, 'supergroup', ?, ?, 0, '{}')`,
      ).run(String(chatId), `Chat ${i}`, `chat${i}`)
    }
    for (const userId of SENDERS) {
      db.query(
        `INSERT INTO users_cache (user_id, username, first_name, fetched_at, raw_json)
         VALUES (?, ?, 'Test', 0, '{}')`,
      ).run(String(userId), `user${userId}`)
    }

    // Like history sync: pages newest first, so rowids don't follow dates.
    // About four messages a second, so many share a date.
    const insert = db.query(
      `INSERT INTO messages_cache
         (chat_id, message_id, from_id, text, is_deleted, date, fetched_at, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, 0, '{}')`,
    )
    db.transaction(() => {
      for (let page = 0; page < MESSAGES / 100; page++) {
        const top = BASE_DATE + 3000 - page * 25
        for (let i = 0; i < 100; i++) {
          const id = page * 100 + i + 1
          // The rarest sender posts about one message in 2,000
          const sender =
            random() < 0.0005 ? SENDERS[19] : pick(SENDERS.slice(0, 19))
          insert.run(
            pickChat(),
            id,
            sender as number,
            messageText(),
            random() < 0.03 ? 1 : 0,
            top - Math.floor(random() * 400),
          )
        }
      }
    })()
  })

  /** Every match sorted by date, then rowid: the order a page must keep */
  function sortedMatches(
    query: string,
    options: MessageSearchOptions,
  ): string[] {
    const conditions = ['message_search MATCH ?']
    const params: Array<string | number> = [
      toFts5Query(query, { phrase: options.phrase }),
    ]
    if (!options.includeDeleted) conditions.push('m.is_deleted = 0')
    if (options.chatId !== undefined) {
      conditions.push('m.chat_id = ?')
      params.push(options.chatId)
    }
    if (options.chatUsername) {
      conditions.push('c.username = ?')
      params.push(options.chatUsername)
    }
    if (options.senderId !== undefined) {
      conditions.push('m.from_id = ?')
      params.push(options.senderId)
    }
    if (options.since !== undefined) {
      conditions.push('m.date >= ?')
      params.push(options.since)
    }
    if (options.until !== undefined) {
      conditions.push('m.date < ?')
      params.push(options.until)
    }
    const rows = db
      .query(
        `SELECT m.chat_id, m.message_id
         FROM message_search
         JOIN messages_cache m ON m.rowid = message_search.rowid
         LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT)
         WHERE ${conditions.join(' AND ')}
         ORDER BY m.date DESC, m.rowid`,
      )
      .all(...params) as Array<{ chat_id: number; message_id: number }>
    return rows.map((row) => `${row.chat_id}:${row.message_id}`)
  }

  const keys = (rows: Array<{ chat_id: number; message_id: number }>) =>
    rows.map((row) => `${row.chat_id}:${row.message_id}`)

  function randomOptions(): MessageSearchOptions {
    const options: MessageSearchOptions = {
      limit: pick([1, 20, 50, 50, 100]),
      offset: pick([0, 0, 0, 7, 50, 200, 1000]),
    }
    const filter = random()
    if (filter < 0.2) options.chatId = pick(CHATS)
    else if (filter < 0.25) options.chatUsername = pick(['chat0', 'chat5'])
    else if (filter < 0.35) options.senderId = pick(SENDERS)
    if (random() < 0.25) options.since = BASE_DATE + Math.floor(random() * 3000)
    if (random() < 0.25) options.until = BASE_DATE + Math.floor(random() * 3000)
    if (random() < 0.15) options.includeDeleted = true
    return options
  }

  it('returns the same page as sorting every match, for random queries and filters', () => {
    const search = createMessagesSearch(db)
    const ways = { matches: 0, messages: 0, sort: 0 }
    for (let run = 0; run < 300; run++) {
      const query = pick([
        'common',
        'common',
        'often',
        'rare',
        'common often',
        'common OR rare',
        'comm*',
      ])
      const options = randomOptions()
      const all = sortedMatches(query, options)
      const offset = options.offset ?? 0
      const expected = all.slice(offset, offset + (options.limit ?? 50))
      const context = JSON.stringify({ query, options })

      expect({ context, rows: keys(search.search(query, options)) }).toEqual({
        context,
        rows: expected,
      })
      expect({ context, n: search.count(query, options) }).toEqual({
        context,
        n: all.length,
      })

      ways[searchNewestFirst(db, query, options).way]++
    }
    // Every way ran
    expect(ways.matches).toBeGreaterThan(30)
    expect(ways.messages).toBeGreaterThan(30)
    expect(ways.sort).toBeGreaterThan(10)
  })

  it('goes through the messages for a common word and sorts the matches of a rare one', () => {
    expect(searchNewestFirst(db, 'common').way).toBe('messages')
    expect(searchNewestFirst(db, 'common', { chatId: CHATS[0] }).way).toBe(
      'messages',
    )
    expect(searchNewestFirst(db, 'rare').way).toBe('matches')
    expect(searchNewestFirst(db, 'nothing').rows).toEqual([])
    expect(searchNewestFirst(db, 'comm*').way).toBe('sort')
  })

  it('falls back to sorting when the window has too few matches', () => {
    // The rarest sender has a handful of messages, most of them older than
    // the window of the newest messages
    const options = { senderId: SENDERS[19] }
    const { rows, way } = searchNewestFirst(db, 'common', options)
    expect(way).toBe('sort')
    expect(keys(rows)).toEqual(sortedMatches('common', options).slice(0, 50))
  })

  it('has pages with ties in date, so the order above covers them', () => {
    const page = createMessagesSearch(db).search('common', { limit: 500 })
    const ties = page.filter(
      (row, i) => i > 0 && row.date === page[i - 1]?.date,
    )
    expect(ties.length).toBeGreaterThan(50)
  })
})
