/**
 * message_attachments: the file of each cached message that has one, kept
 * next to its messages_cache row by messages-cache.ts
 */
import type { Database } from 'bun:sqlite'

import type { AttachmentInfo } from '../utils/attachment'

export interface MessageAttachmentRow {
  chat_id: number
  message_id: number
  kind: string
  source: string
  file_name: string | null
  mime_type: string | null
  file_size: number | null
  duration: number | null
  width: number | null
  height: number | null
  unique_file_id: string
  grouped_id: string | null
}

export interface MessageAttachmentsStore {
  /** Write the row, or delete it when attachment is null; an unchanged row is not written */
  sync(
    chatId: number,
    messageId: number,
    attachment: AttachmentInfo | null,
  ): void
  get(chatId: number, messageId: number): MessageAttachmentRow | null
  /** unique_file_id of every attachment of a chat */
  uniqueFileIdsOfChat(chatId: number): string[]
  /** Whether a message outside chatId holds this file */
  heldOutsideChat(uniqueFileId: string, chatId: number): boolean
}

/** The columns a message written again overwrites */
const ATTACHMENT_COLUMNS = [
  'kind',
  'source',
  'file_name',
  'mime_type',
  'file_size',
  'duration',
  'width',
  'height',
  'unique_file_id',
  'grouped_id',
] as const

export function createMessageAttachmentsStore(
  db: Database,
): MessageAttachmentsStore {
  const stmts = {
    // A row written again unchanged writes nothing
    upsert: db.prepare(`
      INSERT INTO message_attachments (
        chat_id, message_id, ${ATTACHMENT_COLUMNS.join(', ')}
      ) VALUES (
        $chat_id, $message_id, ${ATTACHMENT_COLUMNS.map((col) => `$${col}`).join(', ')}
      )
      ON CONFLICT (chat_id, message_id) DO UPDATE SET
        ${ATTACHMENT_COLUMNS.map((col) => `${col} = excluded.${col}`).join(',\n        ')}
      WHERE ${ATTACHMENT_COLUMNS.map((col) => `message_attachments.${col} IS NOT excluded.${col}`).join('\n        OR ')}
    `),
    delete: db.prepare(`
      DELETE FROM message_attachments
      WHERE chat_id = $chat_id AND message_id = $message_id
    `),
    get: db.query<MessageAttachmentRow, [number, number]>(`
      SELECT * FROM message_attachments
      WHERE chat_id = ? AND message_id = ?
    `),
    uniqueFileIdsOfChat: db.query<{ unique_file_id: string }, [number]>(`
      SELECT DISTINCT unique_file_id FROM message_attachments
      WHERE chat_id = ?
    `),
    heldOutsideChat: db.query<{ held: number }, [string, number]>(`
      SELECT 1 AS held FROM message_attachments
      WHERE unique_file_id = ? AND chat_id != ?
      LIMIT 1
    `),
  }

  return {
    sync(chatId, messageId, attachment) {
      if (!attachment) {
        stmts.delete.run({ $chat_id: chatId, $message_id: messageId })
        return
      }
      stmts.upsert.run({
        $chat_id: chatId,
        $message_id: messageId,
        $kind: attachment.kind,
        $source: attachment.source,
        $file_name: attachment.fileName,
        $mime_type: attachment.mimeType,
        $file_size: attachment.size,
        $duration: attachment.duration,
        $width: attachment.width,
        $height: attachment.height,
        $unique_file_id: attachment.uniqueFileId,
        $grouped_id: attachment.groupedId,
      })
    },

    get(chatId, messageId) {
      return stmts.get.get(chatId, messageId) ?? null
    },

    uniqueFileIdsOfChat(chatId) {
      return stmts.uniqueFileIdsOfChat
        .all(chatId)
        .map((row) => row.unique_file_id)
    },

    heldOutsideChat(uniqueFileId, chatId) {
      return stmts.heldOutsideChat.get(uniqueFileId, chatId) !== null
    },
  }
}
