/**
 * message_attachments, written with the message it mirrors
 * (src/db/message-attachments.ts, src/db/messages-cache.ts)
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'

import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createMessageAttachmentsStore } from '../db/message-attachments'
import {
  createMessagesCache,
  type MessageInput,
  type MessagesCache,
} from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import {
  createMessageAttachmentsSchema,
  initSyncSchema,
} from '../db/sync-schema'
import { extractAttachment } from '../utils/attachment'
import { pdfDocumentMessage } from './helpers/media-messages'
import { photoMessage } from './helpers/photo-message'

const CHAT = 1001
const peer = { _: 'peerUser' as const, userId: CHAT }

function input(raw: unknown, chatId = CHAT): MessageInput {
  const parsed = parseRawMessage(raw, chatId)
  if (!parsed) throw new Error('not a message')
  return parsed
}

function totalChanges(db: Database): number {
  return (db.query('SELECT total_changes() AS n').get() as { n: number }).n
}

function attachmentRows(db: Database) {
  return db
    .query('SELECT * FROM message_attachments ORDER BY chat_id, message_id')
    .all()
}

describe('message_attachments', () => {
  let db: Database
  let cache: MessagesCache

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    cache = createMessagesCache(db)
  })

  it('is created once with its index', () => {
    createMessageAttachmentsSchema(db)
    const objects = db
      .query(
        `SELECT type, name FROM sqlite_master
         WHERE tbl_name = 'message_attachments' AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all()
    expect(objects).toEqual([
      { type: 'index', name: 'idx_message_attachments_unique_file_id' },
      { type: 'table', name: 'message_attachments' },
    ])
  })

  it('writes a row with the attachment of a photo message', () => {
    const raw = photoMessage(peer, 1)
    cache.upsert(input(raw))

    const info = extractAttachment(raw)!
    expect(attachmentRows(db)).toEqual([
      {
        chat_id: CHAT,
        message_id: 1,
        kind: 'photo',
        source: 'message',
        file_name: null,
        mime_type: 'image/jpeg',
        file_size: 60_000,
        duration: null,
        width: 800,
        height: 600,
        unique_file_id: info.uniqueFileId,
        grouped_id: null,
      },
    ])
  })

  it('writes the album ID and a document', () => {
    const raw = {
      ...pdfDocumentMessage(peer, 2),
      groupedId: { low: 1, high: -2, unsigned: false },
    }
    cache.upsert(input(raw))

    expect(createMessageAttachmentsStore(db).get(CHAT, 2)).toMatchObject({
      kind: 'document',
      file_name: 'example-report.pdf',
      mime_type: 'application/pdf',
      file_size: 120_000,
      grouped_id: String(BigInt.asIntN(64, (-2n << 32n) | 1n)),
    })
  })

  it('writes no row for a text message', () => {
    cache.upsert(
      input({ _: 'message', id: 3, peerId: peer, date: 1, message: 'Hi' }),
    )
    expect(attachmentRows(db)).toEqual([])
  })

  it('writes nothing when a message is written again unchanged', () => {
    const message = input(photoMessage(peer, 4))
    cache.upsert(message)
    cache.upsertBatch([message])
    const before = totalChanges(db)

    cache.upsert(message)
    cache.upsertBatch([message, message])

    expect(totalChanges(db)).toBe(before)
  })

  it('writes the row of a message cached before the table existed', () => {
    const message = input(photoMessage(peer, 5))
    cache.upsert(message)
    db.run('DELETE FROM message_attachments')

    cache.upsert(message)

    expect(attachmentRows(db)).toHaveLength(1)
  })

  it('updates the row when the message holds another file', () => {
    cache.upsert(input(photoMessage(peer, 6)))
    const other = { ...pdfDocumentMessage(peer, 6), date: 1_760_000_006 }
    cache.upsert(input(other))

    expect(attachmentRows(db)).toEqual([
      expect.objectContaining({
        message_id: 6,
        kind: 'document',
        unique_file_id: extractAttachment(other)!.uniqueFileId,
      }),
    ])
  })

  it('deletes the row when the message loses its media', () => {
    const raw = photoMessage(peer, 7)
    cache.upsert(input(raw))
    const { media: _, ...withoutMedia } = raw
    cache.upsert(input(withoutMedia))

    expect(attachmentRows(db)).toEqual([])
  })

  it('keeps the row of a deleted message', () => {
    cache.upsert(input(photoMessage(peer, 8)))
    cache.markDeleted(CHAT, [8])

    expect(attachmentRows(db)).toHaveLength(1)
  })

  it('changes neither table when a message of a batch fails', () => {
    const bad = {
      ...input(photoMessage(peer, 10)),
      date: null,
    } as unknown as MessageInput

    expect(() =>
      cache.upsertBatch([input(photoMessage(peer, 9)), bad]),
    ).toThrow()

    expect(db.query('SELECT COUNT(*) AS n FROM messages_cache').get()).toEqual({
      n: 0,
    })
    expect(attachmentRows(db)).toEqual([])
  })

  it("rolls back with the caller's transaction", () => {
    expect(() =>
      db.transaction(() => {
        cache.upsert(input(photoMessage(peer, 11)))
        throw new Error('caller failed')
      })(),
    ).toThrow('caller failed')

    expect(cache.get(CHAT, 11)).toBeNull()
    expect(attachmentRows(db)).toEqual([])
  })

  it('finds the files of a chat and whether another chat holds them', () => {
    const otherChat = -1_002_000_000_001
    const store = createMessageAttachmentsStore(db)
    cache.upsertBatch([
      input(photoMessage(peer, 12)),
      input(pdfDocumentMessage(peer, 13)),
      input(pdfDocumentMessage(peer, 14)),
      input(
        pdfDocumentMessage({ _: 'peerChannel', channelId: 2_000_000_001 }, 5),
        otherChat,
      ),
    ])
    const photoId = extractAttachment(photoMessage(peer, 12))!.uniqueFileId
    const pdfId = extractAttachment(pdfDocumentMessage(peer, 13))!.uniqueFileId

    expect(store.uniqueFileIdsOfChat(CHAT).sort()).toEqual(
      [photoId, pdfId].sort(),
    )
    expect(store.uniqueFileIdsOfChat(42)).toEqual([])
    expect(store.heldOutsideChat(pdfId, CHAT)).toBe(true)
    expect(store.heldOutsideChat(photoId, CHAT)).toBe(false)
    expect(store.heldOutsideChat(pdfId, otherChat)).toBe(true)
  })
})
