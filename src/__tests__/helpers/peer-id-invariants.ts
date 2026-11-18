import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { parseMarkedPeerId } from "@mtcute/bun";

const KINDS_BY_TYPE: Record<string, string[]> = {
  private: ["user"],
  group: ["chat", "channel"],
  supergroup: ["channel"],
  channel: ["channel"],
  community: ["channel"],
};

const CHAT_ID_TABLES = ["messages_cache", "sync_jobs", "history_ranges"];

function peerType(id: number) {
  try {
    return parseMarkedPeerId(id)[0];
  } catch {
    return `invalid peer ID ${id}`;
  }
}

/**
 * Fail with every row that breaks the format: a chats_cache or
 * chat_sync_state row whose ID doesn't fit its type (a bare group or
 * channel ID, say), a chat ID in another table that mtcute can't parse, or
 * a positive chat ID (a user) that chats_cache or chat_sync_state knows as
 * a group or channel
 */
export function assertPeerIdInvariants(db: Database) {
  const violations: string[] = [];

  const typed = [
    ["chats_cache", "SELECT chat_id AS id, type FROM chats_cache"],
    ["chat_sync_state", "SELECT chat_id AS id, chat_type AS type FROM chat_sync_state"],
  ] as const;
  for (const [table, query] of typed) {
    const rows = db.query(query).all() as {
      id: number | string;
      type: string;
    }[];
    for (const { id, type } of rows) {
      const kind = peerType(Number(id));
      if (!KINDS_BY_TYPE[type]?.includes(kind)) {
        violations.push(`${table} ${id} (${type}) is ${kind}`);
      }
    }
  }

  for (const table of CHAT_ID_TABLES) {
    const ids = db.query(`SELECT DISTINCT chat_id AS id FROM ${table}`).all() as { id: number }[];
    for (const { id } of ids) {
      const kind = peerType(id);
      if (!["user", "chat", "channel"].includes(kind)) {
        violations.push(`${table}.chat_id ${id} is ${kind}`);
      }
    }

    const bare = db
      .query(`
        SELECT DISTINCT t.chat_id AS id,
          CASE WHEN s.chat_type <> 'private' THEN s.chat_type ELSE c.type END AS type
        FROM ${table} t
        LEFT JOIN chat_sync_state s ON s.chat_id = t.chat_id
        LEFT JOIN chats_cache c ON c.chat_id = CAST(t.chat_id AS TEXT)
        WHERE t.chat_id > 0
          AND (s.chat_type <> 'private' OR c.type <> 'private')
      `)
      .all() as { id: number; type: string }[];
    for (const { id, type } of bare) {
      violations.push(`${table}.chat_id ${id} is the bare ID of a ${type}`);
    }
  }

  expect(violations).toEqual([]);
}
