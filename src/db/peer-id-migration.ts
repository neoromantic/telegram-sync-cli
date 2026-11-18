import type { Database } from "bun:sqlite";

import {
  toMarkedPeerId,
  toPeerIdFromRawChat,
  toPeerIdFromRawPeer,
  toRawPeerId,
  toSenderIdFromRawMessage,
} from "../utils/telegram-peer-ids";
import type { ChatType } from "./types";

/** user_version once every step has run */
export const PEER_ID_USER_VERSION = 3;

const MIGRATION_BUSY_TIMEOUT_MS = 60_000;

const BARE_CHAT_ROWS = `
  FROM chats_cache
  WHERE type IN ('group', 'supergroup', 'channel')
    AND CAST(chat_id AS INTEGER) > 0`;

interface BareChatRow {
  chat_id: string;
  type: Exclude<ChatType, "private">;
  access_hash: string | null;
  fetched_at: number;
  raw_json: string;
}

function userVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

function hasBareChatRows(db: Database): boolean {
  return db.query(`SELECT 1 ${BARE_CHAT_ROWS} LIMIT 1`).get() !== null;
}

function needsMigration(db: Database): boolean {
  return userVersion(db) < PEER_ID_USER_VERSION || hasBareChatRows(db);
}

function markedIdFromRawJson(rawJson: string): number | null {
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  if ("peer" in raw) {
    return toPeerIdFromRawPeer(raw.peer as Parameters<typeof toPeerIdFromRawPeer>[0]);
  }
  return toPeerIdFromRawChat(raw);
}

function markedIdOf(row: BareChatRow): number {
  const bareId = Number(row.chat_id);
  const fromRaw = markedIdFromRawJson(row.raw_json);
  if (fromRaw !== null && fromRaw < 0 && toRawPeerId(fromRaw) === bareId) {
    return fromRaw;
  }
  return toMarkedPeerId(bareId, row.type);
}

function rekeyBareChats(db: Database): void {
  const rows = db
    .query(`SELECT chat_id, type, access_hash, fetched_at, raw_json ${BARE_CHAT_ROWS}`)
    .all() as BareChatRow[];
  if (rows.length === 0) return;

  const getRow = db.query(
    "SELECT access_hash, fetched_at FROM chats_cache WHERE chat_id = $chat_id",
  );
  const moveRow = db.query(`
    UPDATE chats_cache
    SET chat_id = $to, access_hash = COALESCE(access_hash, $access_hash)
    WHERE chat_id = $from
  `);
  const fillAccessHash = db.query(`
    UPDATE chats_cache
    SET access_hash = COALESCE(access_hash, $access_hash)
    WHERE chat_id = $chat_id
  `);
  const deleteRow = db.query("DELETE FROM chats_cache WHERE chat_id = $chat_id");

  for (const row of rows) {
    const marked = String(markedIdOf(row));
    const existing = getRow.get({ $chat_id: marked }) as Pick<
      BareChatRow,
      "access_hash" | "fetched_at"
    > | null;

    if (!existing) {
      moveRow.run({ $from: row.chat_id, $to: marked, $access_hash: null });
    } else if (row.fetched_at > existing.fetched_at) {
      deleteRow.run({ $chat_id: marked });
      moveRow.run({
        $from: row.chat_id,
        $to: marked,
        $access_hash: existing.access_hash,
      });
    } else {
      fillAccessHash.run({ $chat_id: marked, $access_hash: row.access_hash });
      deleteRow.run({ $chat_id: row.chat_id });
    }
  }
}

type RawPeer = Parameters<typeof toPeerIdFromRawPeer>[0];

function rawPeerType(path: string): string {
  return `CASE WHEN json_valid(raw_json) THEN json_extract(raw_json, '${path}._') END`;
}

function markedSenderId(stored: number | null, peer: RawPeer): number | null {
  if (stored === null || stored <= 0) return stored;
  const marked = toPeerIdFromRawPeer(peer);
  if (marked === null || marked > 0 || toRawPeerId(marked) !== stored) {
    return stored;
  }
  return marked;
}

function markSenderIds(db: Database): void {
  const rows = db
    .query(`
      SELECT rowid, from_id, forward_from_id, raw_json
      FROM messages_cache
      WHERE (from_id > 0
          AND ${rawPeerType("$.fromId")} IN ('peerChannel', 'peerChat'))
         OR (forward_from_id > 0
          AND ${rawPeerType("$.fwdFrom.fromId")} IN ('peerChannel', 'peerChat'))
    `)
    .all() as {
    rowid: number;
    from_id: number | null;
    forward_from_id: number | null;
    raw_json: string;
  }[];

  const update = db.query(`
    UPDATE messages_cache
    SET from_id = $from_id, forward_from_id = $forward_from_id
    WHERE rowid = $rowid
  `);
  for (const row of rows) {
    const raw = JSON.parse(row.raw_json) as {
      fromId?: RawPeer;
      fwdFrom?: { fromId?: RawPeer };
    };
    const fromId = markedSenderId(row.from_id, raw.fromId);
    const forwardFromId = markedSenderId(row.forward_from_id, raw.fwdFrom?.fromId);
    if (fromId !== row.from_id || forwardFromId !== row.forward_from_id) {
      update.run({
        $rowid: row.rowid,
        $from_id: fromId,
        $forward_from_id: forwardFromId,
      });
    }
  }
}

function fillMissingSenders(db: Database): void {
  const rows = db
    .query(`
      SELECT rowid,
             json_quote(json_extract(raw_json, '$.fromId')) AS from_peer,
             json_extract(raw_json, '$.peerId') AS peer
      FROM messages_cache
      WHERE from_id IS NULL
        AND ${rawPeerType("$.fromId")} IS NULL
        AND ${rawPeerType("$.peerId")} IN ('peerUser', 'peerChat', 'peerChannel')
    `)
    .all() as { rowid: number; from_peer: string; peer: string }[];

  const update = db.query("UPDATE messages_cache SET from_id = $from_id WHERE rowid = $rowid");
  for (const row of rows) {
    const fromId = toSenderIdFromRawMessage({
      fromId: JSON.parse(row.from_peer) as RawPeer,
      peerId: JSON.parse(row.peer) as RawPeer,
    });
    if (fromId !== null) update.run({ $rowid: row.rowid, $from_id: fromId });
  }
}

/**
 * Bring the cache to marked peer IDs. Called at the end of initSyncSchema,
 * after the search index exists. Without work to do it only reads, so the
 * CLI and the daemon can call it on every open.
 */
export function migratePeerIds(db: Database, rebuildSearchIndex: (db: Database) => void): void {
  if (!needsMigration(db)) return;

  const { timeout } = db.query("PRAGMA busy_timeout").get() as {
    timeout: number;
  };
  db.run(`PRAGMA busy_timeout = ${MIGRATION_BUSY_TIMEOUT_MS}`);
  try {
    db.transaction(() => {
      if (!needsMigration(db)) return;
      const version = userVersion(db);

      rekeyBareChats(db);
      if (version < 1) rebuildSearchIndex(db);
      if (version < 2) markSenderIds(db);
      if (version < 3) fillMissingSenders(db);

      if (version < PEER_ID_USER_VERSION) {
        db.run(`PRAGMA user_version = ${PEER_ID_USER_VERSION}`);
      }
    }).immediate();
  } finally {
    db.run(`PRAGMA busy_timeout = ${timeout}`);
  }
}
