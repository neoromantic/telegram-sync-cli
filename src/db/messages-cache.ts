/**
 * Messages cache service
 * Provides typed access to the messages_cache table
 */
import type { Database } from 'bun:sqlite'
import { extractAttachment } from '../utils/attachment'
import { sharesAccountMessageIds } from '../utils/telegram-peer-ids'
import {
  createGroupParticipation,
  type GroupParticipation,
  isOwnOrdinaryMessage,
  nowSeconds,
} from './group-participation'
import { createMessageAttachmentsStore } from './message-attachments'
import { MessageCacheRow } from './sync-schema'

/**
 * Input for inserting/updating a message
 */
export interface MessageInput {
  chat_id: number
  message_id: number
  from_id?: number | null
  reply_to_id?: number | null
  forward_from_id?: number | null
  text?: string | null
  message_type: string
  has_media?: boolean
  media_path?: string | null
  is_outgoing?: boolean
  is_edited?: boolean
  is_pinned?: boolean
  is_deleted?: boolean
  edit_date?: number | null
  date: number
  raw_json: string
}

/**
 * Options for listing messages
 */
export interface ListMessagesOptions {
  limit: number
  offset?: number
  includeDeleted?: boolean
}

/** A message ID that more than one private chat or basic group has live */
export interface AmbiguousMessageId {
  messageId: number
  /** Marked IDs of those chats, ascending */
  chatIds: number[]
}

/** Where the message IDs of a delete without chat context live */
export interface MessageChatLookup {
  /** Message ID → the one private chat or basic group that has it live */
  chatIds: Map<number, number>
  ambiguous: AmbiguousMessageId[]
}

/** What a delete without chat context marked, and what it left */
export interface DeleteWithoutChatResult {
  deleted: number
  ambiguous: AmbiguousMessageId[]
}

/** What a write of messages did */
export interface CacheWriteResult {
  /** The messages written: new rows and updates of cached ones */
  accepted: Array<{ chat_id: number; message_id: number }>
  /** New rows */
  inserted: number
  /** New messages the group participation rule kept out */
  skipped: number
}

/**
 * Messages cache service interface
 */
export interface MessagesCache {
  /** The group participation rule every write follows */
  participation: GroupParticipation
  /** Insert or update a message (see upsertBatch) */
  upsert(message: MessageInput): CacheWriteResult
  /**
   * Insert or update messages in one transaction. Own ordinary messages
   * count as participation first, oldest first. A cached message is always
   * updated; a new one is written only if its chat may take it
   * (GroupParticipation.canInsert), else it is skipped before anything of
   * it (attachment, search index) is written.
   */
  upsertBatch(messages: MessageInput[]): CacheWriteResult
  /**
   * IDs of the chat's messages cached with raw_json '{}' (#130), above
   * `afterId`, oldest first
   */
  listEmptyRawJsonIds(chatId: number, afterId: number, limit: number): number[]
  /** Get a message by chat_id and message_id */
  get(chatId: number, messageId: number): MessageCacheRow | null
  /**
   * Find the chat of each message ID among the account's private chats and
   * basic groups, for delete events without chat context
   */
  findChatIdsByMessageIds(messageIds: number[]): MessageChatLookup
  /** List messages for a chat in reverse chronological order */
  listByChatId(chatId: number, options: ListMessagesOptions): MessageCacheRow[]
  /** Mark messages as deleted */
  markDeleted(chatId: number, messageIds: number[]): void
  /**
   * Mark messages as deleted when the chat is unknown, each in the one chat
   * among the account's private chats and basic groups that has it live
   */
  markDeletedByMessageIds(messageIds: number[]): DeleteWithoutChatResult
  /** Update message text (for edits) */
  updateText(
    chatId: number,
    messageId: number,
    newText: string,
    editDate: number,
  ): void
  /** Get the latest message ID for a chat */
  getLatestMessageId(chatId: number): number | null
  /** Get the oldest message ID for a chat */
  getOldestMessageId(chatId: number): number | null
  /** Count messages in a chat */
  countByChatId(chatId: number, includeDeleted?: boolean): number
}

/**
 * The columns a fetched message overwrites. A message fetched again with all
 * of them unchanged leaves its row, and so its search index row, alone:
 * fetched_at and updated_at keep the last write that changed something.
 */
const UPSERT_COLUMNS = [
  'from_id',
  'reply_to_id',
  'forward_from_id',
  'text',
  'message_type',
  'has_media',
  'media_path',
  'is_outgoing',
  'is_edited',
  'is_pinned',
  'is_deleted',
  'edit_date',
  'date',
  'raw_json',
] as const

/**
 * Create a messages cache service
 */
export function createMessagesCache(db: Database): MessagesCache {
  // Prepare statements for performance
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO messages_cache (
        chat_id, message_id, from_id, reply_to_id, forward_from_id,
        text, message_type, has_media, media_path,
        is_outgoing, is_edited, is_pinned, is_deleted, edit_date,
        date, fetched_at, raw_json, updated_at
      ) VALUES (
        $chat_id, $message_id, $from_id, $reply_to_id, $forward_from_id,
        $text, $message_type, $has_media, $media_path,
        $is_outgoing, $is_edited, $is_pinned, $is_deleted, $edit_date,
        $date, $fetched_at, $raw_json, $updated_at
      )
      ON CONFLICT (chat_id, message_id) DO UPDATE SET
        ${UPSERT_COLUMNS.map((col) => `${col} = excluded.${col}`).join(',\n')},
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
      WHERE ${UPSERT_COLUMNS.map((col) => `messages_cache.${col} IS NOT excluded.${col}`).join('\n        OR ')}
    `),

    get: db
      .query(`
      SELECT * FROM messages_cache
      WHERE chat_id = $chat_id AND message_id = $message_id
    `)
      .as(MessageCacheRow),

    exists: db.query(`
      SELECT 1 FROM messages_cache
      WHERE chat_id = $chat_id AND message_id = $message_id
    `),

    listEmptyRawJsonIds: db.query(`
      SELECT message_id FROM messages_cache
      WHERE chat_id = $chat_id AND message_id > $after AND raw_json = '{}'
      ORDER BY message_id
      LIMIT $limit
    `),

    listByChatId: db
      .query(`
      SELECT * FROM messages_cache
      WHERE chat_id = $chat_id AND is_deleted = 0
      ORDER BY date DESC
      LIMIT $limit OFFSET $offset
    `)
      .as(MessageCacheRow),

    listByChatIdIncludeDeleted: db
      .query(`
      SELECT * FROM messages_cache
      WHERE chat_id = $chat_id
      ORDER BY date DESC
      LIMIT $limit OFFSET $offset
    `)
      .as(MessageCacheRow),

    markDeleted: db.prepare(`
      UPDATE messages_cache
      SET is_deleted = 1, updated_at = $now
      WHERE chat_id = $chat_id AND message_id = $message_id
    `),

    findChatIdsByMessageId: db.query(`
      SELECT chat_id FROM messages_cache
      WHERE message_id = $message_id AND is_deleted = 0
    `),

    updateText: db.prepare(`
      UPDATE messages_cache
      SET text = $text, is_edited = 1, edit_date = $edit_date, updated_at = $now
      WHERE chat_id = $chat_id AND message_id = $message_id
    `),

    getLatestMessageId: db.query(`
      SELECT MAX(message_id) as max_id FROM messages_cache
      WHERE chat_id = $chat_id
    `),

    getOldestMessageId: db.query(`
      SELECT MIN(message_id) as min_id FROM messages_cache
      WHERE chat_id = $chat_id
    `),

    countByChatId: db.query(`
      SELECT COUNT(*) as count FROM messages_cache
      WHERE chat_id = $chat_id AND is_deleted = 0
    `),

    countByChatIdAll: db.query(`
      SELECT COUNT(*) as count FROM messages_cache
      WHERE chat_id = $chat_id
    `),
  }

  const attachments = createMessageAttachmentsStore(db)

  // The message and its attachment row change together. Each statement
  // writes only what changed, so a message fetched again unchanged writes
  // nothing.
  function writeMessage(message: MessageInput): void {
    const now = Date.now()
    stmts.upsert.run({
      $chat_id: message.chat_id,
      $message_id: message.message_id,
      $from_id: message.from_id ?? null,
      $reply_to_id: message.reply_to_id ?? null,
      $forward_from_id: message.forward_from_id ?? null,
      $text: message.text ?? null,
      $message_type: message.message_type,
      $has_media: message.has_media ? 1 : 0,
      $media_path: message.media_path ?? null,
      $is_outgoing: message.is_outgoing ? 1 : 0,
      $is_edited: message.is_edited ? 1 : 0,
      $is_pinned: message.is_pinned ? 1 : 0,
      $is_deleted: message.is_deleted ? 1 : 0,
      $edit_date: message.edit_date ?? null,
      $date: message.date,
      $fetched_at: now,
      $raw_json: message.raw_json,
      $updated_at: now,
    })
    // A message without media has no file: skip parsing its raw_json
    attachments.sync(
      message.chat_id,
      message.message_id,
      message.has_media ? extractAttachment(message.raw_json) : null,
    )
  }

  const participation = createGroupParticipation(db)

  // Inside a caller's transaction this runs as a savepoint. It reads before
  // it writes, so it takes the write lock first: a deferred transaction
  // would fail at once if another process wrote after its read.
  const upsertMany = db.transaction(
    (messages: MessageInput[]): CacheWriteResult => {
      const now = nowSeconds()
      const own = messages
        .filter(
          (message) => message.chat_id < 0 && isOwnOrdinaryMessage(message),
        )
        .sort((a, b) => a.date - b.date)
      for (const message of own) {
        participation.observeOwnMessage(message.chat_id, message.date, now)
      }

      const result: CacheWriteResult = { accepted: [], inserted: 0, skipped: 0 }
      for (const message of messages) {
        const key = {
          $chat_id: message.chat_id,
          $message_id: message.message_id,
        }
        const cached = stmts.exists.get(key) !== null
        if (
          !cached &&
          !participation.canInsert(message.chat_id, message.date, now)
        ) {
          result.skipped++
          continue
        }
        writeMessage(message)
        if (!cached) result.inserted++
        result.accepted.push({
          chat_id: message.chat_id,
          message_id: message.message_id,
        })
      }
      return result
    },
  )

  return {
    participation,

    upsert(message: MessageInput): CacheWriteResult {
      return upsertMany.immediate([message])
    },

    listEmptyRawJsonIds(
      chatId: number,
      afterId: number,
      limit: number,
    ): number[] {
      const rows = stmts.listEmptyRawJsonIds.all({
        $chat_id: chatId,
        $after: afterId,
        $limit: limit,
      }) as { message_id: number }[]
      return rows.map((row) => row.message_id)
    },

    upsertBatch(messages: MessageInput[]): CacheWriteResult {
      return upsertMany.immediate(messages)
    },

    get(chatId: number, messageId: number): MessageCacheRow | null {
      return stmts.get.get({ $chat_id: chatId, $message_id: messageId }) ?? null
    },

    findChatIdsByMessageIds(messageIds: number[]): MessageChatLookup {
      const chatIds = new Map<number, number>()
      const ambiguous: AmbiguousMessageId[] = []

      for (const messageId of new Set(messageIds)) {
        const rows = stmts.findChatIdsByMessageId.all({
          $message_id: messageId,
        }) as Array<{ chat_id: number }>
        // Each channel and supergroup numbers its own messages, so its rows
        // say nothing about a delete without chat context. The primary key
        // makes the chat IDs unique.
        const candidates = rows
          .map((row) => row.chat_id)
          .filter(sharesAccountMessageIds)

        if (candidates.length > 1) {
          ambiguous.push({
            messageId,
            chatIds: candidates.sort((a, b) => a - b),
          })
        } else if (candidates[0] !== undefined) {
          chatIds.set(messageId, candidates[0])
        }
      }

      return { chatIds, ambiguous }
    },

    listByChatId(
      chatId: number,
      options: ListMessagesOptions,
    ): MessageCacheRow[] {
      const params = {
        $chat_id: chatId,
        $limit: options.limit,
        $offset: options.offset ?? 0,
      }

      if (options.includeDeleted) {
        return stmts.listByChatIdIncludeDeleted.all(params)
      }
      return stmts.listByChatId.all(params)
    },

    markDeleted(chatId: number, messageIds: number[]): void {
      const now = Date.now()
      const transaction = db.transaction(() => {
        for (const messageId of messageIds) {
          stmts.markDeleted.run({
            $chat_id: chatId,
            $message_id: messageId,
            $now: now,
          })
        }
      })
      transaction()
    },

    markDeletedByMessageIds(messageIds: number[]): DeleteWithoutChatResult {
      if (messageIds.length === 0) return { deleted: 0, ambiguous: [] }

      const lookup = this.findChatIdsByMessageIds(messageIds)
      if (lookup.chatIds.size === 0) {
        return { deleted: 0, ambiguous: lookup.ambiguous }
      }

      const now = Date.now()
      db.transaction(() => {
        for (const [messageId, chatId] of lookup.chatIds) {
          stmts.markDeleted.run({
            $chat_id: chatId,
            $message_id: messageId,
            $now: now,
          })
        }
      })()

      return { deleted: lookup.chatIds.size, ambiguous: lookup.ambiguous }
    },

    updateText(
      chatId: number,
      messageId: number,
      newText: string,
      editDate: number,
    ): void {
      stmts.updateText.run({
        $chat_id: chatId,
        $message_id: messageId,
        $text: newText,
        $edit_date: editDate,
        $now: Date.now(),
      })
    },

    getLatestMessageId(chatId: number): number | null {
      const result = stmts.getLatestMessageId.get({ $chat_id: chatId }) as {
        max_id: number | null
      } | null
      return result?.max_id ?? null
    },

    getOldestMessageId(chatId: number): number | null {
      const result = stmts.getOldestMessageId.get({ $chat_id: chatId }) as {
        min_id: number | null
      } | null
      return result?.min_id ?? null
    },

    countByChatId(chatId: number, includeDeleted = false): number {
      const stmt = includeDeleted ? stmts.countByChatIdAll : stmts.countByChatId
      const result = stmt.get({ $chat_id: chatId }) as { count: number } | null
      return result?.count ?? 0
    },
  }
}
