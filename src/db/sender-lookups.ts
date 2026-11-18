import type { Database } from "bun:sqlite";

import { CHANNEL_PEER_ID_OFFSET } from "../utils/telegram-peer-ids";

/** How long a sender Telegram didn't return waits before the next try */
export const SENDER_RETRY_MS = 30 * 24 * 60 * 60 * 1000;

/** A sender to look up and the message of theirs to ask for */
export interface SenderLookup {
  sender_id: number;
  message_id: number;
}

export function createSenderLookupsSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS sender_lookups (
      sender_id   INTEGER PRIMARY KEY,
      chat_id     INTEGER NOT NULL,
      message_id  INTEGER NOT NULL,
      asked_at    INTEGER
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_sender_lookups_waiting
    ON sender_lookups(chat_id) WHERE asked_at IS NULL
  `);
}

function cachedUserSql(id: string) {
  return `EXISTS (SELECT 1 FROM users_cache WHERE user_id = CAST(${id} AS TEXT))`;
}

const MISSING_SENDERS_CTE = `
  senders(id) AS (
    SELECT MIN(from_id) FROM messages_cache WHERE from_id > 0
    UNION ALL
    SELECT (SELECT MIN(from_id) FROM messages_cache WHERE from_id > senders.id)
    FROM senders WHERE senders.id IS NOT NULL
  ),
  missing(id) AS (
    SELECT id FROM senders
    WHERE id IS NOT NULL AND NOT ${cachedUserSql("id")}
      -- With every message deleted, none is left to ask for or to show
      AND EXISTS (
        SELECT 1 FROM messages_cache WHERE from_id = senders.id AND is_deleted = 0
      )
  )
`;

export interface SenderLookups {
  /**
   * List the users with cached messages and no users_cache row, each with
   * their newest message that Telegram can be asked for: one in a private
   * chat or basic group, or in a channel or supergroup whose access hash is
   * cached. A sender that waits keeps their row; one Telegram didn't return
   * gets a new message after SENDER_RETRY_MS. Rows of senders cached since
   * go. Returns how many senders now wait.
   */
  scan(now: number): number;
  /** Chats with senders waiting to be asked for */
  chatsDue(): number[];
  /** Up to `limit` senders of the chat that wait and are still missing */
  nextBatch(chatId: number, limit: number): SenderLookup[];
  /**
   * After Telegram was asked: senders cached since go, the others wait
   * SENDER_RETRY_MS
   */
  finish(senderIds: number[], now: number): void;
  /** Users with cached messages and no users_cache row */
  countMissing(): number;
  /** Of those, the ones Telegram was asked for and didn't return */
  countNotFound(): number;
}

export function createSenderLookups(db: Database) {
  const reachable = `(
    r.chat_id > -${CHANNEL_PEER_ID_OFFSET} OR EXISTS (
      SELECT 1 FROM chats_cache c
      WHERE c.chat_id = CAST(r.chat_id AS TEXT) AND c.access_hash IS NOT NULL
    )
  )`;
  const stmts = {
    dropCached: db.prepare(`DELETE FROM sender_lookups WHERE ${cachedUserSql("sender_id")}`),
    list: db.prepare(`
      WITH RECURSIVE ${MISSING_SENDERS_CTE}
      INSERT INTO sender_lookups (sender_id, chat_id, message_id)
      SELECT missing.id, m.chat_id, m.message_id
      FROM missing
      JOIN messages_cache m ON m.rowid = (
        SELECT r.rowid FROM messages_cache r
        WHERE r.from_id = missing.id AND r.is_deleted = 0 AND ${reachable}
        ORDER BY r.date DESC, r.message_id DESC
        LIMIT 1
      )
      WHERE true
      ON CONFLICT (sender_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        message_id = excluded.message_id,
        asked_at = NULL
      WHERE sender_lookups.asked_at <= $retry_before
    `),
    countWaiting: db.query("SELECT COUNT(*) AS count FROM sender_lookups WHERE asked_at IS NULL"),
    chatsDue: db.query(`
      SELECT DISTINCT chat_id FROM sender_lookups
      WHERE asked_at IS NULL AND NOT ${cachedUserSql("sender_id")}
    `),
    nextBatch: db.query(`
      SELECT sender_id, message_id FROM sender_lookups
      WHERE chat_id = $chat_id AND asked_at IS NULL
        AND NOT ${cachedUserSql("sender_id")}
      ORDER BY sender_id
      LIMIT $limit
    `),
    dropFinished: db.prepare(`
      DELETE FROM sender_lookups
      WHERE sender_id IN (SELECT value FROM json_each($ids))
        AND ${cachedUserSql("sender_id")}
    `),
    markAsked: db.prepare(`
      UPDATE sender_lookups SET asked_at = $now
      WHERE sender_id IN (SELECT value FROM json_each($ids))
    `),
    countMissing: db.query(
      `WITH RECURSIVE ${MISSING_SENDERS_CTE} SELECT COUNT(*) AS count FROM missing`,
    ),
    countNotFound: db.query(`
      SELECT COUNT(*) AS count FROM sender_lookups
      WHERE asked_at IS NOT NULL AND NOT ${cachedUserSql("sender_id")}
    `),
  };

  const count = (query: typeof stmts.countWaiting) => (query.get() as { count: number }).count;

  const result: SenderLookups = {
    scan(now) {
      db.transaction(() => {
        stmts.dropCached.run();
        stmts.list.run({ $retry_before: now - SENDER_RETRY_MS });
      })();
      return count(stmts.countWaiting);
    },

    chatsDue() {
      return (stmts.chatsDue.all() as { chat_id: number }[]).map((row) => row.chat_id);
    },

    nextBatch(chatId, limit) {
      return stmts.nextBatch.all({
        $chat_id: chatId,
        $limit: limit,
      }) as SenderLookup[];
    },

    finish(senderIds, now) {
      const ids = JSON.stringify(senderIds);
      db.transaction(() => {
        stmts.dropFinished.run({ $ids: ids });
        stmts.markAsked.run({ $ids: ids, $now: now });
      })();
    },

    countMissing: () => count(stmts.countMissing),
    countNotFound: () => count(stmts.countNotFound),
  };
  return result;
}
