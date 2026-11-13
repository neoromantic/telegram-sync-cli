/**
 * Fresh sender and chat names in the search index (#93). The index takes a
 * message's names from users_cache and chats_cache when the message is
 * written. When a person or a chat is renamed, or their row arrives after
 * their messages, triggers queue a re-index of their messages in
 * search_reindex_queue; the background migration runners (the daemon and
 * `tg db migrate`) drain it in short batches. A one-off migration
 * re-indexes every message of a cache written before this queue existed.
 */
import type { Database } from 'bun:sqlite'

import type {
  BackgroundMigration,
  BatchLimits,
  BatchResult,
} from './background-migrations'

/** The names of a message's sender, from users_cache, else its ID */
export function buildSenderSearchExpr(prefix: string): string {
  return `
    COALESCE(
      (
        SELECT trim(
          COALESCE(username, '') || ' ' ||
          COALESCE(first_name, '') || ' ' ||
          COALESCE(last_name, '') || ' ' ||
          COALESCE(display_name, '') || ' ' ||
          COALESCE(user_id, '')
        )
        FROM users_cache
        WHERE user_id = CAST(${prefix}.from_id AS TEXT)
      ),
      COALESCE(CAST(${prefix}.from_id AS TEXT), '')
    )
  `
}

/** The title and username of a message's chat, from chats_cache, else its ID */
export function buildChatSearchExpr(prefix: string): string {
  return `
    COALESCE(
      (
        SELECT trim(
          COALESCE(title, '') || ' ' ||
          COALESCE(username, '') || ' ' ||
          COALESCE(chat_id, '')
        )
        FROM chats_cache
        WHERE chat_id = CAST(${prefix}.chat_id AS TEXT)
      ),
      COALESCE(CAST(${prefix}.chat_id AS TEXT), '')
    )
  `
}

/** The triggers on users_cache and chats_cache that fill the queue */
export const REINDEX_TRIGGERS = [
  'users_cache_search_ai',
  'users_cache_search_au',
  'chats_cache_search_ai',
  'chats_cache_search_au',
] as const

/**
 * Queue a peer's messages, the ones written so far, unless it has none. A
 * peer queued again starts over: its names changed since.
 */
function queueStatements(
  kind: 'sender' | 'chat',
  peerId: string,
  column: string,
): string {
  return `
    DELETE FROM search_reindex_queue WHERE kind = '${kind}' AND peer_id = ${peerId};
    INSERT INTO search_reindex_queue (kind, peer_id, end_rowid)
    SELECT '${kind}', ${peerId}, (SELECT MAX(rowid) FROM messages_cache)
    WHERE EXISTS (SELECT 1 FROM messages_cache WHERE ${column} = ${peerId});
  `
}

/**
 * The queue and its triggers. An upsert sets every column, so the update
 * triggers compare the names the index reads: a dialog pass that rewrites
 * thousands of unchanged rows queues nothing.
 */
export function createSearchReindexSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS search_reindex_queue (
      kind       TEXT NOT NULL,
      peer_id    INTEGER NOT NULL,
      cursor     INTEGER NOT NULL DEFAULT 0,
      end_rowid  INTEGER NOT NULL,
      PRIMARY KEY (kind, peer_id)
    )
  `)

  const user = queueStatements(
    'sender',
    'CAST(new.user_id AS INTEGER)',
    'from_id',
  )
  const chat = queueStatements(
    'chat',
    'CAST(new.chat_id AS INTEGER)',
    'chat_id',
  )
  db.run(`
    CREATE TRIGGER IF NOT EXISTS users_cache_search_ai
    AFTER INSERT ON users_cache
    BEGIN ${user} END;
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS users_cache_search_au
    AFTER UPDATE OF username, first_name, last_name, display_name ON users_cache
    WHEN old.username IS NOT new.username
      OR old.first_name IS NOT new.first_name
      OR old.last_name IS NOT new.last_name
      OR old.display_name IS NOT new.display_name
    BEGIN ${user} END;
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chats_cache_search_ai
    AFTER INSERT ON chats_cache
    BEGIN ${chat} END;
  `)
  db.run(`
    CREATE TRIGGER IF NOT EXISTS chats_cache_search_au
    AFTER UPDATE OF title, username ON chats_cache
    WHEN old.title IS NOT new.title OR old.username IS NOT new.username
    BEGIN ${chat} END;
  `)
}

/** Prepare a re-index of one message by rowid, with the names cached now */
function prepareMessageReindex(db: Database): (rowid: number) => void {
  const remove = db.query('DELETE FROM message_search WHERE rowid = ?')
  const insert = db.query(`
    INSERT INTO message_search(rowid, text, sender, chat, files)
    SELECT
      m.rowid,
      COALESCE(m.text, ''),
      ${buildSenderSearchExpr('m')},
      ${buildChatSearchExpr('m')},
      COALESCE(m.media_path, '')
    FROM messages_cache m
    WHERE m.rowid = ?
  `)
  return (rowid) => {
    remove.run(rowid)
    insert.run(rowid)
  }
}

/**
 * Re-index every message once (#93): caches written before the queue
 * existed index most messages with the IDs of senders cached after them.
 */
export const searchNamesMigration: BackgroundMigration = {
  name: 'message_search_names',
  description: 'Re-index the sender and chat names of cached messages',
  table: 'messages_cache',
  columns: [],
  writesSearch: true,
  prepare(db: Database) {
    const reindex = prepareMessageReindex(db)
    return (row) => reindex(row.rowid)
  },
}

interface QueueRow {
  kind: 'sender' | 'chat'
  peer_id: number
  cursor: number
  end_rowid: number
}

/**
 * Whether the search index can be written. An older SQLite that can't
 * disables it (sync-schema.ts): the re-index waits for a newer one, which
 * rebuilds the whole index with the names cached then.
 */
export function isSearchEnabled(db: Database): boolean {
  const row = db
    .query(`SELECT value FROM search_meta WHERE key = 'search_index_version'`)
    .get() as { value: string } | null
  return row?.value !== '0'
}

/** Whether queued peers wait for a re-index */
export function hasQueuedReindex(db: Database): boolean {
  return db.query('SELECT 1 FROM search_reindex_queue LIMIT 1').get() !== null
}

/**
 * Re-index queued messages in one write transaction: peers in queue order,
 * at most `maxRows` messages and none started after `maxMs`. A sender's
 * messages go by rowid, a chat's by message_id (its primary key); the
 * cursor and the messages commit together, so a stop resumes after the
 * last batch. Messages above end_rowid were written with the new names.
 */
export function runReindexBatch(
  db: Database,
  limits: BatchLimits,
): BatchResult {
  const now = limits.now ?? Date.now
  const next = db.query(
    'SELECT kind, peer_id, cursor, end_rowid FROM search_reindex_queue ORDER BY rowid LIMIT 1',
  )
  const senderMessages = db.query(`
    SELECT rowid, rowid AS position FROM messages_cache
    WHERE from_id = $peer AND rowid > $cursor AND rowid <= $end
    ORDER BY rowid LIMIT $limit
  `)
  const chatMessages = db.query(`
    SELECT rowid, message_id AS position FROM messages_cache
    WHERE chat_id = $peer AND message_id > $cursor AND rowid <= $end
    ORDER BY message_id LIMIT $limit
  `)
  const advance = db.query(
    'UPDATE search_reindex_queue SET cursor = $cursor WHERE kind = $kind AND peer_id = $peer',
  )
  const remove = db.query(
    'DELETE FROM search_reindex_queue WHERE kind = $kind AND peer_id = $peer',
  )

  return db
    .transaction((): BatchResult => {
      const reindex = prepareMessageReindex(db)
      const started = now()
      let rows = 0
      for (;;) {
        const peer = next.get() as QueueRow | null
        if (!peer) return { rows, finished: true }
        if (rows >= limits.maxRows || now() - started >= limits.maxMs) {
          return { rows, finished: false }
        }

        const limit = limits.maxRows - rows
        const messages = (
          peer.kind === 'sender' ? senderMessages : chatMessages
        ).all({
          $peer: peer.peer_id,
          $cursor: peer.cursor,
          $end: peer.end_rowid,
          $limit: limit,
        }) as { rowid: number; position: number }[]

        let cursor = peer.cursor
        let count = 0
        for (const message of messages) {
          reindex(message.rowid)
          cursor = message.position
          count += 1
          if (now() - started >= limits.maxMs) break
        }
        rows += count
        const key = { $kind: peer.kind, $peer: peer.peer_id }
        if (count === messages.length && messages.length < limit) {
          remove.run(key)
        } else {
          advance.run({ ...key, $cursor: cursor })
        }
      }
    })
    .immediate()
}
