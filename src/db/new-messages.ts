/**
 * The messages stored in an account's cache after a start point, for
 * `tg messages wait` and `watch`. Reads only the cache: the daemon (or any
 * other tg) writes it, and a poll finds new rows by their rowid, which grows
 * with every row inserted (an upsert of a cached message keeps its rowid).
 */
import type { Database } from 'bun:sqlite'

import {
  MESSAGE_ROW_COLUMNS,
  MESSAGE_ROW_JOINS,
  type MessageSearchRow,
} from './messages-search'

export interface NewMessagesOptions {
  /** Only this chat's messages (a marked peer ID) */
  chatId?: number
  /** With `chatId`: the messages newer than this ID count, cached ones too */
  after?: number
}

export interface NewMessagesFeed {
  /** With `after`: the chat's cached messages newer than it, oldest first */
  readonly initial: MessageSearchRow[]
  /**
   * The messages stored since the last poll that count as new, oldest
   * first. A message counts when it is newer than every message of its chat
   * the cache already had, so history the daemon backfills doesn't. Deleted
   * messages are left out.
   */
  poll(): MessageSearchRow[]
}

type FeedRow = MessageSearchRow & { row_id: number }

/** Oldest first: by date, then chat and message ID */
export function oldestFirst(a: MessageSearchRow, b: MessageSearchRow): number {
  return a.date - b.date || a.chat_id - b.chat_id || a.message_id - b.message_id
}

export function createNewMessagesFeed(
  db: Database,
  { chatId, after }: NewMessagesOptions = {},
): NewMessagesFeed {
  const chatFilter = chatId === undefined ? '' : 'AND m.chat_id = $chat'
  const dataVersion = db.query<{ data_version: number }, []>(
    'PRAGMA data_version',
  )
  const maxRowid = db.query<{ max: number | null }, []>(
    'SELECT MAX(rowid) AS max FROM messages_cache',
  )
  const storedRows = db.query<
    FeedRow,
    { $last: number; $max: number; $chat?: number }
  >(`
    SELECT m.rowid AS row_id, ${MESSAGE_ROW_COLUMNS}
    FROM messages_cache m
    ${MESSAGE_ROW_JOINS}
    WHERE m.rowid > $last AND m.rowid <= $max ${chatFilter}
    ORDER BY m.rowid
  `)
  const newestBefore = db.query<
    { message_id: number },
    { $chat: number; $rowid: number }
  >(`
    SELECT message_id FROM messages_cache
    WHERE chat_id = $chat AND rowid <= $rowid
    ORDER BY message_id DESC
    LIMIT 1
  `)
  const cachedAfter = db.query<
    MessageSearchRow,
    { $chat: number; $after: number }
  >(`
    SELECT ${MESSAGE_ROW_COLUMNS}
    FROM messages_cache m
    ${MESSAGE_ROW_JOINS}
    WHERE m.chat_id = $chat AND m.message_id > $after AND m.is_deleted = 0
    ORDER BY m.message_id
  `)

  // Read first: a commit after it makes the first poll look
  let lastVersion = dataVersion.get()?.data_version
  // One read transaction, so the cached messages and the start point come
  // from the same snapshot and no row is both
  const { startRowid, initial } = db.transaction(() => ({
    startRowid: maxRowid.get()?.max ?? 0,
    initial:
      chatId !== undefined && after !== undefined
        ? cachedAfter.all({ $chat: chatId, $after: after })
        : [],
  }))()

  let lastRowid = startRowid
  /** The newest message ID of each chat seen so far */
  const newest = new Map<number, number>()
  const newestOf = (chat: number) => {
    let id = newest.get(chat)
    if (id === undefined) {
      id =
        newestBefore.get({ $chat: chat, $rowid: startRowid })?.message_id ?? 0
      if (chat === chatId && after !== undefined) id = Math.max(id, after)
      newest.set(chat, id)
    }
    return id
  }

  return {
    initial,
    poll() {
      // data_version changes only when another connection commits
      const version = dataVersion.get()?.data_version
      if (version === lastVersion) return []
      lastVersion = version

      const rows = db.transaction(() => {
        const max = maxRowid.get()?.max ?? 0
        if (max <= lastRowid) return []
        const stored = storedRows.all({
          $last: lastRowid,
          $max: max,
          ...(chatId !== undefined && { $chat: chatId }),
        })
        lastRowid = max
        return stored
      })()

      const fresh: MessageSearchRow[] = []
      for (const { row_id: _rowid, ...row } of rows) {
        const before = newestOf(row.chat_id)
        if (row.message_id <= before) continue
        newest.set(row.chat_id, row.message_id)
        if (row.is_deleted === 0) fresh.push(row)
      }
      return fresh.sort(oldestFirst)
    },
  }
}
