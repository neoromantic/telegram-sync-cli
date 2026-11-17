/**
 * Chats cache service for caching Telegram chats/dialogs
 * Uses bun:sqlite with prepared statements for typed queries
 */
import type { Database } from 'bun:sqlite'

import { legacyChatIdCandidates } from '../utils/telegram-peer-ids'
import { ChatCacheRow } from './schema'
import type { ChatType } from './types'

/**
 * Cached chat data structure (matches database row)
 */
export type CachedChat = ChatCacheRow

/**
 * Input for creating/updating a cached chat
 */
export type CachedChatInput = Omit<CachedChat, 'created_at' | 'updated_at'>

/**
 * Options for listing chats
 */
export interface ListChatsOptions {
  limit?: number
  offset?: number
  type?: ChatType
  orderBy?: 'last_message_at' | 'title'
}

/**
 * Chats cache service class
 */
export class ChatsCache {
  private getByIdStmt
  private getByUsernameStmt
  private upsertStmt
  private countAllStmt
  private countByTypeStmt

  constructor(private db: Database) {
    // Create prepared statements
    this.getByIdStmt = db
      .query('SELECT * FROM chats_cache WHERE chat_id = $chat_id')
      .as(ChatCacheRow)

    this.getByUsernameStmt = db
      .query(
        'SELECT * FROM chats_cache WHERE username = $username COLLATE NOCASE',
      )
      .as(ChatCacheRow)

    this.upsertStmt = db.query(`
      INSERT INTO chats_cache (
        chat_id, type, title, username, member_count, access_hash,
        is_creator, is_admin, last_message_id, last_message_at,
        fetched_at, raw_json, created_at, updated_at
      ) VALUES (
        $chat_id, $type, $title, $username, $member_count, $access_hash,
        $is_creator, $is_admin, $last_message_id, $last_message_at,
        $fetched_at, $raw_json, $now, $now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        username = excluded.username,
        member_count = excluded.member_count,
        access_hash = excluded.access_hash,
        is_creator = excluded.is_creator,
        is_admin = excluded.is_admin,
        last_message_id = excluded.last_message_id,
        last_message_at = excluded.last_message_at,
        fetched_at = excluded.fetched_at,
        raw_json = excluded.raw_json,
        updated_at = $now
    `)

    this.countAllStmt = db.query('SELECT COUNT(*) as count FROM chats_cache')

    this.countByTypeStmt = db.query(
      'SELECT COUNT(*) as count FROM chats_cache WHERE type = $type',
    )
  }

  /**
   * Get chat by ID
   */
  getById(chatId: string): CachedChat | null {
    return this.getByIdStmt.get({ $chat_id: chatId })
  }

  /**
   * The cached chats a bare positive ID from 0.2.0 or older can name:
   * basic group N (-N) and channel N (-100…N). Cache-only; usually none or
   * one, two only when both are cached.
   */
  getByLegacyId(bareId: number): CachedChat[] {
    return legacyChatIdCandidates(bareId)
      .map((peerId) => this.getById(String(peerId)))
      .filter((chat): chat is CachedChat => chat !== null)
  }

  /**
   * Get chat by username (without @)
   */
  getByUsername(username: string): CachedChat | null {
    // Strip @ if present
    const cleanUsername = username.startsWith('@')
      ? username.slice(1)
      : username
    return this.getByUsernameStmt.get({ $username: cleanUsername })
  }

  /**
   * Insert or update chat
   */
  upsert(chat: CachedChatInput): void {
    const now = Date.now()
    this.upsertStmt.run({
      $chat_id: chat.chat_id,
      $type: chat.type,
      $title: chat.title,
      $username: chat.username,
      $member_count: chat.member_count,
      $access_hash: chat.access_hash,
      $is_creator: chat.is_creator,
      $is_admin: chat.is_admin,
      $last_message_id: chat.last_message_id,
      $last_message_at: chat.last_message_at,
      $fetched_at: chat.fetched_at,
      $raw_json: chat.raw_json,
      $now: now,
    })
  }

  /**
   * Bulk upsert multiple chats
   */
  upsertMany(chats: CachedChatInput[]): void {
    if (chats.length === 0) return

    // Use transaction for bulk insert
    this.db.transaction(() => {
      for (const chat of chats) {
        this.upsert(chat)
      }
    })()
  }

  /**
   * List chats with filtering and pagination
   */
  list(opts: ListChatsOptions = {}): CachedChat[] {
    const { limit = 50, offset = 0, type, orderBy = 'last_message_at' } = opts

    // Determine order clause
    const orderClause =
      orderBy === 'title'
        ? 'ORDER BY title COLLATE NOCASE ASC'
        : 'ORDER BY last_message_at DESC NULLS LAST'

    return this.db
      .query(`
        SELECT * FROM chats_cache
        WHERE ($type IS NULL OR type = $type)
        ${orderClause}
        LIMIT $limit OFFSET $offset
      `)
      .as(ChatCacheRow)
      .all({ $type: type ?? null, $limit: limit, $offset: offset })
  }

  /**
   * Search chats by title or username
   */
  search(query: string, limit = 20): CachedChat[] {
    const searchPattern = `%${query}%`

    const sql = `
      SELECT * FROM chats_cache
      WHERE title LIKE $pattern COLLATE NOCASE
         OR username LIKE $pattern COLLATE NOCASE
      ORDER BY
        CASE
          WHEN username LIKE $exact COLLATE NOCASE THEN 1
          WHEN title LIKE $exact COLLATE NOCASE THEN 2
          ELSE 3
        END,
        last_message_at DESC NULLS LAST
      LIMIT $limit
    `

    return this.db.query(sql).as(ChatCacheRow).all({
      $pattern: searchPattern,
      $exact: query,
      $limit: limit,
    })
  }

  /**
   * Count total cached chats
   */
  count(type?: ChatType): number {
    if (type) {
      const result = this.countByTypeStmt.get({ $type: type }) as {
        count: number
      } | null
      return result?.count ?? 0
    }
    const result = this.countAllStmt.get() as { count: number } | null
    return result?.count ?? 0
  }
}

/**
 * Factory function to create a ChatsCache instance
 */
export function createChatsCache(db: Database): ChatsCache {
  return new ChatsCache(db)
}
