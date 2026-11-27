import type { Database } from "bun:sqlite";

import { cachedProtection } from "../commands/media/protection";
import { extractAttachment, type AttachmentInfo } from "../utils/attachment";
import type { TranscriptSource } from "../types";

export interface MessageTranscriptRow {
  chat_id: number;
  message_id: number;
  unique_file_id: string;
  text: string;
  language: string | null;
  source: TranscriptSource;
  runner: string | null;
  model: string | null;
  transcribed_at: number;
}

export interface MessageTranscriptsStore {
  get(chatId: number, messageId: number): MessageTranscriptRow | null;
  /** A transcript of the same file, in any chat */
  getByFile(uniqueFileId: string): MessageTranscriptRow | null;
  save(row: MessageTranscriptRow): void;
}

export function createMessageTranscriptsStore(db: Database) {
  const stmts = {
    get: db.query<MessageTranscriptRow, [number, number]>(`
      SELECT chat_id, message_id, unique_file_id, text, language, source, runner, model, transcribed_at FROM message_transcripts WHERE chat_id = ? AND message_id = ?
    `),
    getByFile: db.query<MessageTranscriptRow, [string]>(`
      SELECT chat_id, message_id, unique_file_id, text, language, source, runner, model, transcribed_at FROM message_transcripts WHERE unique_file_id = ?
      ORDER BY transcribed_at DESC LIMIT 1
    `),
    save: db.prepare(`
      INSERT INTO message_transcripts (
        chat_id, message_id, unique_file_id, text, language, source, runner,
        model, transcribed_at
      ) VALUES (
        $chat_id, $message_id, $unique_file_id, $text, $language, $source,
        $runner, $model, $transcribed_at
      ) ON CONFLICT(chat_id, message_id) DO UPDATE SET
        unique_file_id = excluded.unique_file_id, text = excluded.text,
        language = excluded.language, source = excluded.source, runner = excluded.runner,
        model = excluded.model, transcribed_at = excluded.transcribed_at
    `),
  };

  return {
    get(chatId, messageId) {
      return stmts.get.get(chatId, messageId) ?? null;
    },
    getByFile(uniqueFileId) {
      return stmts.getByFile.get(uniqueFileId) ?? null;
    },
    save(row) {
      stmts.save.run({
        $chat_id: row.chat_id,
        $message_id: row.message_id,
        $unique_file_id: row.unique_file_id,
        $text: row.text,
        $language: row.language,
        $source: row.source,
        $runner: row.runner,
        $model: row.model,
        $transcribed_at: row.transcribed_at,
      });
    },
  } satisfies MessageTranscriptsStore;
}

/** The same cached visibility check applies to display, search hits and counts. */
export function visibleTranscriptFile(db: Database) {
  const protection = cachedProtection(db);
  return (chatId: number, raw: string, attachment: AttachmentInfo | null) =>
    (attachment?.kind === "voice" || attachment?.kind === "round") &&
    !protection(chatId, raw).protected;
}

export function* visibleTranscriptHits(cacheDb: Database, match: string) {
  const candidates = cacheDb.query<
    { rowid: number; rank: number; chat_id: number; raw_json: string; unique_file_id: string },
    [string]
  >(`SELECT m.rowid, transcript_search.rank, m.chat_id, m.raw_json, t.unique_file_id
       FROM transcript_search JOIN message_transcripts t ON t.rowid = transcript_search.rowid
       JOIN messages_cache m ON m.chat_id = t.chat_id AND m.message_id = t.message_id
       WHERE transcript_search MATCH ? AND m.has_media = 1`);
  const visible = visibleTranscriptFile(cacheDb);
  for (const candidate of candidates.iterate(match)) {
    const file = extractAttachment(candidate.raw_json);
    if (
      file?.uniqueFileId === candidate.unique_file_id &&
      visible(candidate.chat_id, candidate.raw_json, file)
    ) {
      yield { rowid: candidate.rowid, rank: candidate.rank };
    }
  }
}
