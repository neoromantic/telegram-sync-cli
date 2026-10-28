/**
 * The first background migrations (#89): rows written by older versions
 * get the raw_json form toRawJson writes now (byte arrays as base64, Long
 * values as decimal strings, no fileReference; #86, #108, #95). Messages
 * also get the attachment row (#22) and the message_type a history page
 * gives now. One pass over messages_cache parses each row's raw_json once
 * for all three.
 */
import type { Database } from 'bun:sqlite'

import { extractAttachment } from '../utils/attachment'
import { resolveRawMessageType } from '../utils/message-type'
import { reencodeRawJson } from '../utils/raw-json'
import type {
  BackgroundMigration,
  MigrationRow,
  MigrationTable,
} from './background-migrations'
import { createMessageAttachmentsStore } from './message-attachments'

/**
 * The message_type a history page stores for this raw message: `text` for
 * a link preview still pending, an expired photo or unsupported media, as
 * the write path gives it. Null to keep the stored one, for raw_json that
 * isn't a TL message (`{}`, the abstract sync worker's). Older versions
 * stored videos, voices, stickers, audio and GIFs as `document`.
 */
function rawMessageType(raw: unknown): string | null {
  const kind = (raw as { _?: unknown } | null)?._
  if (kind !== 'message' && kind !== 'messageService') return null
  return resolveRawMessageType(raw).messageType
}

const messagesMigration: BackgroundMigration = {
  name: 'messages_raw_json_v2',
  description:
    'Re-encode raw_json of cached messages, fill their attachments and message types',
  table: 'messages_cache',
  columns: ['chat_id', 'message_id', 'message_type', 'has_media', 'raw_json'],
  prepare(db: Database) {
    // Neither column is one the search index reads, so no re-index
    const update = db.query(`
      UPDATE messages_cache SET raw_json = $raw_json, message_type = $message_type
      WHERE rowid = $rowid
    `)
    const attachments = createMessageAttachmentsStore(db)

    return (row: MigrationRow) => {
      const rawJson = row.raw_json as string
      const hasMedia = row.has_media === 1
      const { value, changed } = reencodeRawJson(rawJson)

      const messageType = rawMessageType(value) ?? (row.message_type as string)
      if (hasMedia && value !== null) {
        // extractAttachment reads either form; this one is parsed already
        attachments.sync(
          row.chat_id as number,
          row.message_id as number,
          extractAttachment(value),
        )
      }
      if (changed || messageType !== row.message_type) {
        update.run({
          $rowid: row.rowid,
          $raw_json: changed ? JSON.stringify(value) : rawJson,
          $message_type: messageType,
        })
      }
    }
  },
}

function reencodeMigration(
  name: string,
  table: MigrationTable,
  noun: string,
): BackgroundMigration {
  return {
    name,
    description: `Re-encode raw_json of cached ${noun}`,
    table,
    columns: ['raw_json'],
    prepare(db: Database) {
      const update = db.query(
        `UPDATE ${table} SET raw_json = $raw_json WHERE rowid = $rowid`,
      )
      return (row: MigrationRow) => {
        const { value, changed } = reencodeRawJson(row.raw_json as string)
        if (changed) {
          update.run({ $rowid: row.rowid, $raw_json: JSON.stringify(value) })
        }
      }
    },
  }
}

/** Every background migration, in the order they run */
export const BACKGROUND_MIGRATIONS: readonly BackgroundMigration[] = [
  messagesMigration,
  reencodeMigration('users_raw_json_v2', 'users_cache', 'users'),
  reencodeMigration('chats_raw_json_v2', 'chats_cache', 'chats'),
]
