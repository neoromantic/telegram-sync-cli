import type { Database } from "bun:sqlite";

import { extractAttachment } from "../utils/attachment";
import { resolveRawMessageType } from "../utils/message-type";
import { reencodeRawJson } from "../utils/raw-json";
import { richMessageText } from "../utils/rich-message";
import type { BackgroundMigration, MigrationRow, MigrationTable } from "./background-migrations";
import { createMessageAttachmentsStore } from "./message-attachments";
import { searchNamesMigration } from "./search-reindex";

function rawMessageType(raw: unknown) {
  const kind = (raw as { _?: unknown } | null)?._;
  if (kind !== "message" && kind !== "messageService") return null;
  return resolveRawMessageType(raw).messageType;
}

/** The migration that gives older rows their message_type and attachment */
export const MESSAGE_TYPES_MIGRATION = "messages_raw_json_v2";

const messagesMigration: BackgroundMigration = {
  name: MESSAGE_TYPES_MIGRATION,
  description: "Re-encode raw_json of cached messages, fill their attachments and message types",
  table: "messages_cache",
  columns: ["chat_id", "message_id", "message_type", "has_media", "raw_json"],
  prepare(db: Database) {
    const update = db.query(`
      UPDATE messages_cache SET raw_json = $raw_json, message_type = $message_type
      WHERE rowid = $rowid
    `);
    const attachments = createMessageAttachmentsStore(db);

    return (row: MigrationRow) => {
      const rawJson = row.raw_json as string;
      const hasMedia = row.has_media === 1;
      const { value, changed } = reencodeRawJson(rawJson);

      const messageType = rawMessageType(value) ?? (row.message_type as string);
      if (hasMedia && value !== null) {
        attachments.sync(row.chat_id as number, row.message_id as number, extractAttachment(value));
      }
      if (changed || messageType !== row.message_type) {
        update.run({
          $rowid: row.rowid,
          $raw_json: changed ? JSON.stringify(value) : rawJson,
          $message_type: messageType,
        });
      }
    };
  },
};

const refetchEmptyMigration: BackgroundMigration = {
  name: "messages_refetch_empty_raw_json",
  description: "Queue a refetch of messages cached with an empty raw_json",
  table: "messages_cache",
  columns: ["chat_id", "raw_json"],
  prepare(db: Database) {
    const remember = db.query(`
      INSERT OR IGNORE INTO refetch_chats (chat_id, queued_at)
      VALUES ($chat_id, $now)
    `);
    const queue = db.query(`
      INSERT INTO sync_jobs (chat_id, job_type, priority, status, created_at)
      SELECT $chat_id, 'refetch_messages', 4, 'pending', $now
      WHERE NOT EXISTS (
        SELECT 1 FROM sync_jobs
        WHERE chat_id = $chat_id AND job_type = 'refetch_messages'
          AND status = 'pending'
      )
    `);
    return (row: MigrationRow) => {
      if (row.raw_json !== "{}") return;
      const params = { $chat_id: row.chat_id as number, $now: Date.now() };
      if (remember.run(params).changes === 1) queue.run(params);
    };
  },
};

const richTextMigration: BackgroundMigration = {
  name: "messages_rich_text",
  description: "Fill the text of cached rich messages, so search finds them",
  table: "messages_cache",
  columns: ["text", "message_type"],
  prepare(db: Database) {
    const rawJson = db.query<{ raw_json: string }, [number]>(
      "SELECT raw_json FROM messages_cache WHERE rowid = ?",
    );
    const update = db.query("UPDATE messages_cache SET text = $text WHERE rowid = $rowid");
    return (row: MigrationRow) => {
      if (row.text || row.message_type !== "text") return;
      const raw = rawJson.get(row.rowid);
      const text = raw ? richMessageText(raw.raw_json) : null;
      if (text) update.run({ $rowid: row.rowid, $text: text });
    };
  },
};

function reencodeMigration(name: string, table: MigrationTable, noun: string) {
  return {
    name,
    description: `Re-encode raw_json of cached ${noun}`,
    table,
    columns: ["raw_json"],
    prepare(db: Database) {
      const update = db.query(`UPDATE ${table} SET raw_json = $raw_json WHERE rowid = $rowid`);
      return (row: MigrationRow) => {
        const { value, changed } = reencodeRawJson(row.raw_json as string);
        if (changed) {
          update.run({ $rowid: row.rowid, $raw_json: JSON.stringify(value) });
        }
      };
    },
  };
}

/** Every background migration, in the order they run */
export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [
  messagesMigration,
  reencodeMigration("users_raw_json_v2", "users_cache", "users"),
  reencodeMigration("chats_raw_json_v2", "chats_cache", "chats"),
  refetchEmptyMigration,
  searchNamesMigration,
  richTextMigration,
];
