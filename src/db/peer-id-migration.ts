/**
 * Moves a cache from 0.2.0 or older to marked peer IDs everywhere (#18).
 * Those versions stored groups and channels in chats_cache under their bare
 * IDs, while messages_cache and the sync tables used marked IDs, so the two
 * never joined.
 *
 * `PRAGMA user_version` records the one-time steps that ran:
 * - 1: chats_cache is re-keyed and the search index rebuilt, so its `chat`
 *   column holds group and channel titles
 * - 2: messages_cache.from_id and forward_from_id of a group or channel
 *   sender get its marked ID; history pages stored the bare one
 *
 * The re-key itself runs on every open that finds a bare group or channel
 * row, so it also repairs rows that an older binary still running writes
 * after the upgrade. Step 2 runs once, because finding bare sender IDs means
 * reading every message's raw_json: the ones an older binary caches later
 * stay bare until the message is fetched again. Everything runs in one
 * write transaction: a failure rolls all of it back, user_version included,
 * and the next open retries.
 */
import type { Database } from 'bun:sqlite'

import {
  toMarkedPeerId,
  toPeerIdFromRawChat,
  toPeerIdFromRawPeer,
  toRawPeerId,
} from '../utils/telegram-peer-ids'
import type { ChatType } from './types'

/** user_version once every step has run */
export const PEER_ID_USER_VERSION = 2

/**
 * How long to wait for another process's write lock. The CLI and the daemon
 * may open a 0.2.0 cache at once, and one of them waits out the other's
 * migration, which rebuilds the search index.
 */
const MIGRATION_BUSY_TIMEOUT_MS = 60_000

/** Group and channel rows under a positive ID, the 0.2.0 format */
const BARE_CHAT_ROWS = `
  FROM chats_cache
  WHERE type IN ('group', 'supergroup', 'channel')
    AND CAST(chat_id AS INTEGER) > 0`

interface BareChatRow {
  chat_id: string
  type: Exclude<ChatType, 'private'>
  access_hash: string | null
  fetched_at: number
  raw_json: string
}

function userVersion(db: Database): number {
  const row = db.query('PRAGMA user_version').get() as {
    user_version: number
  }
  return row.user_version
}

function hasBareChatRows(db: Database): boolean {
  return db.query(`SELECT 1 ${BARE_CHAT_ROWS} LIMIT 1`).get() !== null
}

function needsMigration(db: Database): boolean {
  return userVersion(db) < PEER_ID_USER_VERSION || hasBareChatRows(db)
}

/**
 * The marked ID that a row's raw_json names: a dialog's peer, or a raw chat
 * object. Null when raw_json names none, such as '{}' or malformed JSON.
 */
function markedIdFromRawJson(rawJson: string): number | null {
  let raw: unknown
  try {
    raw = JSON.parse(rawJson)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  if ('peer' in raw) {
    return toPeerIdFromRawPeer(
      raw.peer as Parameters<typeof toPeerIdFromRawPeer>[0],
    )
  }
  return toPeerIdFromRawChat(raw)
}

/**
 * The marked ID for a bare row. raw_json knows the kind of chat for sure: a
 * community is stored as 'group' but has a channel ID. It counts only when
 * it names a group or channel with the same bare ID; otherwise the row's
 * type decides.
 */
function markedIdOf(row: BareChatRow): number {
  const bareId = Number(row.chat_id)
  const fromRaw = markedIdFromRawJson(row.raw_json)
  if (fromRaw !== null && fromRaw < 0 && toRawPeerId(fromRaw) === bareId) {
    return fromRaw
  }
  return toMarkedPeerId(bareId, row.type)
}

/**
 * Move every bare group and channel row to its marked ID. When the chat is
 * cached under the marked ID too, the row fetched later wins, keeps the
 * other's access hash if it has none, and the other is deleted.
 */
function rekeyBareChats(db: Database): void {
  const rows = db
    .query(
      `SELECT chat_id, type, access_hash, fetched_at, raw_json ${BARE_CHAT_ROWS}`,
    )
    .all() as BareChatRow[]
  if (rows.length === 0) return

  const getRow = db.query(
    'SELECT access_hash, fetched_at FROM chats_cache WHERE chat_id = $chat_id',
  )
  const moveRow = db.query(`
    UPDATE chats_cache
    SET chat_id = $to, access_hash = COALESCE(access_hash, $access_hash)
    WHERE chat_id = $from
  `)
  const fillAccessHash = db.query(`
    UPDATE chats_cache
    SET access_hash = COALESCE(access_hash, $access_hash)
    WHERE chat_id = $chat_id
  `)
  const deleteRow = db.query('DELETE FROM chats_cache WHERE chat_id = $chat_id')

  for (const row of rows) {
    const marked = String(markedIdOf(row))
    const existing = getRow.get({ $chat_id: marked }) as Pick<
      BareChatRow,
      'access_hash' | 'fetched_at'
    > | null

    if (!existing) {
      moveRow.run({ $from: row.chat_id, $to: marked, $access_hash: null })
    } else if (row.fetched_at > existing.fetched_at) {
      deleteRow.run({ $chat_id: marked })
      moveRow.run({
        $from: row.chat_id,
        $to: marked,
        $access_hash: existing.access_hash,
      })
    } else {
      fillAccessHash.run({ $chat_id: marked, $access_hash: row.access_hash })
      deleteRow.run({ $chat_id: row.chat_id })
    }
  }
}

type RawPeer = Parameters<typeof toPeerIdFromRawPeer>[0]

/** The `_` of the raw peer at `path` in raw_json; NULL for malformed JSON */
function rawPeerType(path: string): string {
  return `CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '${path}._') END`
}

/**
 * The marked ID for a stored sender or forward source, when it is the bare
 * ID of the group or channel that raw_json names; otherwise the stored value
 */
function markedSenderId(stored: number | null, peer: RawPeer): number | null {
  if (stored === null || stored <= 0) return stored
  const marked = toPeerIdFromRawPeer(peer)
  if (marked === null || marked > 0 || toRawPeerId(marked) !== stored) {
    return stored
  }
  return marked
}

/**
 * Give group and channel senders and forward sources their marked IDs. The
 * update trigger re-indexes each changed row, so a channel no longer gets the
 * name of the user whose ID equals its bare one.
 */
function markSenderIds(db: Database): void {
  const rows = db
    .query(`
      SELECT rowid, from_id, forward_from_id, raw_json
      FROM messages_cache
      WHERE (from_id > 0
          AND ${rawPeerType('$.fromId')} IN ('peerChannel', 'peerChat'))
         OR (forward_from_id > 0
          AND ${rawPeerType('$.fwdFrom.fromId')} IN ('peerChannel', 'peerChat'))
    `)
    .all() as {
    rowid: number
    from_id: number | null
    forward_from_id: number | null
    raw_json: string
  }[]

  const update = db.query(`
    UPDATE messages_cache
    SET from_id = $from_id, forward_from_id = $forward_from_id
    WHERE rowid = $rowid
  `)
  for (const row of rows) {
    const raw = JSON.parse(row.raw_json) as {
      fromId?: RawPeer
      fwdFrom?: { fromId?: RawPeer }
    }
    const fromId = markedSenderId(row.from_id, raw.fromId)
    const forwardFromId = markedSenderId(
      row.forward_from_id,
      raw.fwdFrom?.fromId,
    )
    if (fromId !== row.from_id || forwardFromId !== row.forward_from_id) {
      update.run({
        $rowid: row.rowid,
        $from_id: fromId,
        $forward_from_id: forwardFromId,
      })
    }
  }
}

/**
 * Bring the cache to marked peer IDs. Called at the end of initSyncSchema,
 * after the search index exists. Without work to do it only reads, so the
 * CLI and the daemon can call it on every open.
 */
export function migratePeerIds(
  db: Database,
  rebuildSearchIndex: (db: Database) => void,
): void {
  if (!needsMigration(db)) return

  const { timeout } = db.query('PRAGMA busy_timeout').get() as {
    timeout: number
  }
  db.run(`PRAGMA busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`)
  try {
    db.transaction(() => {
      // Another process may have migrated while this one waited for the lock
      if (!needsMigration(db)) return
      const version = userVersion(db)

      rekeyBareChats(db)
      if (version < 1) rebuildSearchIndex(db)
      if (version < 2) markSenderIds(db)

      if (version < PEER_ID_USER_VERSION) {
        db.run(`PRAGMA user_version = ${PEER_ID_USER_VERSION}`)
      }
    }).immediate()
  } finally {
    db.run(`PRAGMA busy_timeout = ${timeout}`)
  }
}
