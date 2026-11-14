/**
 * Group participation: a group adds messages to the cache only while the
 * account takes part in it, that is, sent an ordinary message there in the
 * last 90 days. Reading a group doesn't count. The rule holds for every
 * writer (live updates, dialog passes, sync jobs, the CLI) and whatever
 * `tg chats sync` says; private chats and channels don't fall under it.
 * Messages already cached stay and are still updated.
 *
 * Per account cache:
 * - group_participation: the date of the newest own message known in each
 *   group, and when the first check (a search for the newest own message)
 *   answered. Without that answer and without a fresh own message the
 *   group's state is unknown, and it takes no new messages either.
 * - group_capture_gaps: the periods `[start_date, end_date)` a group was
 *   known to be paused. A pause starts when the newest own message turns 90
 *   days old (or at the first check, if that found none) and ends at the
 *   next own message. Messages dated inside a pause are never cached, so
 *   catch-up and history after a return don't fill it.
 *
 * Every change merges by the newest date, so an older fact, or one that
 * arrives late, never lowers the date or reopens a pause. Dates are Unix
 * seconds, as Telegram sends them.
 */
import type { Database } from 'bun:sqlite'
import { INDEX_BUILD_BUSY_TIMEOUT_MS, withBusyTimeout } from './sync-schema'

/** How long an own message keeps a group captured: 90 days */
export const PARTICIPATION_WINDOW_SECONDS = 90 * 24 * 60 * 60

/**
 * - active: an own message of the last 90 days is known
 * - inactive: the check answered, and no own message of the last 90 days
 * - unknown: the first check hasn't answered yet
 */
export type GroupCaptureStatus = 'active' | 'inactive' | 'unknown'

/** The message is the account's own ordinary message, by its cached columns */
export function isOwnOrdinaryMessage(message: {
  is_outgoing?: boolean | null
  from_id?: number | null
  message_type: string
}): boolean {
  // A message sent as a channel or as an anonymous admin has a chat as its
  // sender: nothing says who wrote it
  return (
    Boolean(message.is_outgoing) &&
    (message.from_id ?? 0) > 0 &&
    message.message_type !== 'service'
  )
}

/**
 * SQL condition: the chat of the chat_sync_state row in `table` takes new
 * messages at `now` (Unix seconds): it isn't a group, or an own message of
 * the last 90 days is known in it. Matches GroupParticipation.captures for
 * a chat with sync state.
 */
export function capturesSql(table: string, now: number = nowSeconds()): string {
  const since = Math.floor(now) - PARTICIPATION_WINDOW_SECONDS
  return `(${table}.chat_type NOT IN ('group', 'supergroup') OR EXISTS (SELECT 1 FROM group_participation p WHERE p.chat_id = ${table}.chat_id AND p.last_own_date > ${since}))`
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

interface ParticipationRow {
  last_own_date: number | null
  initialized_at: number | null
}

function statusOf(
  row: ParticipationRow | null,
  now: number,
): GroupCaptureStatus {
  if (
    row?.last_own_date != null &&
    now < row.last_own_date + PARTICIPATION_WINDOW_SECONDS
  ) {
    return 'active'
  }
  return row?.initialized_at == null ? 'unknown' : 'inactive'
}

export interface GroupParticipation {
  /** Whether the chat falls under the rule: a basic group or a supergroup */
  isGroup(chatId: number): boolean
  /** The group's state now; meaningful only for a group */
  status(chatId: number, now?: number): GroupCaptureStatus
  /** The chat may take new messages now: not a group, or an active one */
  captures(chatId: number, now?: number): boolean
  /** A new message of this date may be cached in the chat now */
  canInsert(chatId: number, messageDate: number, now?: number): boolean
  /** An own ordinary message of this date was seen in the chat */
  observeOwnMessage(chatId: number, date: number, now?: number): void
  /**
   * A search for the newest own message of the last 90 days answered:
   * `lastOwnDate` is its date, or null if it found none
   */
  recordCheck(chatId: number, lastOwnDate: number | null, now?: number): void
  /** The date of the newest own message known in the chat */
  lastOwnDate(chatId: number): number | null
  /** The chat has a recorded pause */
  hasGaps(chatId: number): boolean
}

/**
 * The tables, created once. A cache of an older version gets the own
 * messages it already holds as the first facts, in one pass over
 * messages_cache; their state stays unknown until the first check.
 */
export function createGroupParticipationSchema(db: Database): void {
  const exists = db
    .query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_capture_gaps'`,
    )
    .get()
  if (exists) return

  withBusyTimeout(db, INDEX_BUILD_BUSY_TIMEOUT_MS, () => {
    db.transaction(() => {
      db.run(`
        CREATE TABLE IF NOT EXISTS group_participation (
          chat_id         INTEGER PRIMARY KEY,
          last_own_date   INTEGER,
          initialized_at  INTEGER
        )
      `)
      // Another process may have created both tables while this one waited
      const created = db
        .query(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_capture_gaps'`,
        )
        .get()
      if (created) return
      db.run(`
        INSERT OR IGNORE INTO group_participation (chat_id, last_own_date)
        SELECT chat_id, MAX(date) FROM messages_cache
        WHERE chat_id < 0 AND is_outgoing = 1 AND from_id > 0
          AND message_type <> 'service'
        GROUP BY chat_id
      `)
      db.run(`
        CREATE TABLE group_capture_gaps (
          chat_id     INTEGER NOT NULL,
          start_date  INTEGER NOT NULL,
          end_date    INTEGER NOT NULL,
          PRIMARY KEY (chat_id, start_date),
          CHECK (end_date > start_date)
        )
      `)
    }).immediate()
  })
}

export function createGroupParticipation(db: Database): GroupParticipation {
  const stmts = {
    get: db.query(
      'SELECT last_own_date, initialized_at FROM group_participation WHERE chat_id = ?',
    ),
    syncType: db.query(
      'SELECT chat_type FROM chat_sync_state WHERE chat_id = ?',
    ),
    cachedType: db.query('SELECT type FROM chats_cache WHERE chat_id = ?'),
    upsert: db.prepare(`
      INSERT INTO group_participation (chat_id, last_own_date, initialized_at)
      VALUES ($chat_id, $last, $init)
      ON CONFLICT (chat_id) DO UPDATE SET
        last_own_date = MAX(COALESCE(last_own_date, excluded.last_own_date), COALESCE(excluded.last_own_date, last_own_date)),
        initialized_at = COALESCE(initialized_at, excluded.initialized_at)
    `),
    addGap: db.prepare(`
      INSERT OR IGNORE INTO group_capture_gaps (chat_id, start_date, end_date)
      VALUES ($chat_id, $start, $end)
    `),
    inGap: db.query(`
      SELECT 1 FROM group_capture_gaps
      WHERE chat_id = $chat_id AND start_date <= $date AND end_date > $date
      LIMIT 1
    `),
    hasGaps: db.query(
      'SELECT 1 FROM group_capture_gaps WHERE chat_id = ? LIMIT 1',
    ),
    // The next refresh queues a catch-up from the old cursor
    topUnknown: db.prepare(
      'UPDATE chat_sync_state SET top_message_id = NULL, updated_at = $now WHERE chat_id = $chat_id',
    ),
  }

  const getRow = (chatId: number) =>
    (stmts.get.get(chatId) as ParticipationRow | null) ?? null

  /**
   * Merge an own message (`ownDate`) or a check's answer (`checked`). A new
   * own message after a known pause records the pause up to its date. A
   * pause starts when the newest own message turned 90 days old, but never
   * before the first check: what came before the rule isn't rebuilt.
   */
  const merge = db.transaction(
    (chatId: number, ownDate: number | null, checked: boolean, now: number) => {
      const row = getRow(chatId)
      const before = statusOf(row, now)
      const prevLast = row?.last_own_date ?? null
      const prevInit = row?.initialized_at ?? null

      const newer =
        ownDate !== null && (prevLast === null || ownDate > prevLast)
      if (newer && prevInit !== null) {
        const start =
          prevLast === null
            ? prevInit
            : Math.max(prevLast + PARTICIPATION_WINDOW_SECONDS, prevInit)
        if (ownDate > start) {
          stmts.addGap.run({ $chat_id: chatId, $start: start, $end: ownDate })
        }
      }

      const last = newer ? ownDate : prevLast
      const fresh = last !== null && now < last + PARTICIPATION_WINDOW_SECONDS
      // An answered check, or a fresh own message, makes the state known
      const init = prevInit ?? (checked || fresh ? now : null)
      if (row && last === prevLast && init === prevInit) return
      stmts.upsert.run({ $chat_id: chatId, $last: last, $init: init })

      if (
        before !== 'active' &&
        statusOf({ last_own_date: last, initialized_at: init }, now) ===
          'active'
      ) {
        stmts.topUnknown.run({ $chat_id: chatId, $now: Date.now() })
      }
    },
  )

  const service: GroupParticipation = {
    isGroup(chatId) {
      if (chatId > 0) return false
      // -N is a basic group; -100… is a supergroup or a channel
      if (chatId > -1_000_000_000_000) return true
      const type =
        (stmts.syncType.get(chatId) as { chat_type: string } | null)
          ?.chat_type ??
        (stmts.cachedType.get(String(chatId)) as { type: string } | null)?.type
      // A chat of unknown type gets no exemption
      return type !== 'channel' && type !== 'community'
    },

    status(chatId, now = nowSeconds()) {
      return statusOf(getRow(chatId), now)
    },

    captures(chatId, now = nowSeconds()) {
      return (
        !service.isGroup(chatId) || service.status(chatId, now) === 'active'
      )
    },

    canInsert(chatId, messageDate, now = nowSeconds()) {
      if (!service.isGroup(chatId)) return true
      if (service.status(chatId, now) !== 'active') return false
      return stmts.inGap.get({ $chat_id: chatId, $date: messageDate }) === null
    },

    observeOwnMessage(chatId, date, now = nowSeconds()) {
      merge.immediate(chatId, date, false, now)
    },

    recordCheck(chatId, lastOwnDate, now = nowSeconds()) {
      merge.immediate(chatId, lastOwnDate, true, now)
    },

    lastOwnDate(chatId) {
      return getRow(chatId)?.last_own_date ?? null
    },

    hasGaps(chatId) {
      return stmts.hasGaps.get(chatId) !== null
    },
  }
  return service
}
