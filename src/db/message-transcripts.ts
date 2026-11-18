/**
 * message_transcripts: the text `tg media transcribe` got from a voice note
 * or video note. Written only by the CLI.
 */
import type { Database } from 'bun:sqlite'

import type { TranscriptSource } from '../types'

export interface MessageTranscriptRow {
  chat_id: number
  message_id: number
  unique_file_id: string
  text: string
  language: string | null
  source: TranscriptSource
  runner: string | null
  model: string | null
  transcribed_at: number
}

export interface MessageTranscriptsStore {
  get(chatId: number, messageId: number): MessageTranscriptRow | null
  /** A transcript of the same file, in any chat */
  getByFile(uniqueFileId: string): MessageTranscriptRow | null
  save(row: MessageTranscriptRow): void
}

export function createMessageTranscriptsStore(
  db: Database,
): MessageTranscriptsStore {
  const stmts = {
    get: db.query<MessageTranscriptRow, [number, number]>(`
      SELECT * FROM message_transcripts WHERE chat_id = ? AND message_id = ?
    `),
    getByFile: db.query<MessageTranscriptRow, [string]>(`
      SELECT * FROM message_transcripts WHERE unique_file_id = ?
      ORDER BY transcribed_at DESC LIMIT 1
    `),
    save: db.prepare(`
      INSERT OR REPLACE INTO message_transcripts (
        chat_id, message_id, unique_file_id, text, language, source, runner,
        model, transcribed_at
      ) VALUES (
        $chat_id, $message_id, $unique_file_id, $text, $language, $source,
        $runner, $model, $transcribed_at
      )
    `),
  }

  return {
    get(chatId, messageId) {
      return stmts.get.get(chatId, messageId) ?? null
    },
    getByFile(uniqueFileId) {
      return stmts.getByFile.get(uniqueFileId) ?? null
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
      })
    },
  }
}
