/**
 * Chats cache service for caching Telegram chats/dialogs
 * Uses bun:sqlite with prepared statements for typed queries
 */
import type { Database } from 'bun:sqlite'

import { legacyChatIdCandidates } from '../utils/telegram-peer-ids'
import { ChatCacheRow } from './schema'
import type { CacheConfig, ChatType } from './types'

/**
 * Cached chat data structure (matches database row)
 */
export interface CachedChat {
  chat_id: string
  type: ChatType
  title: string | null
  username: string | null
  member_count: number | null
  access_hash: string | null
  is_creator: number
  is_admin: number
  last_message_id: number | null
  last_message_at: number | null
  fetched_at: number
  raw_json: string
  created_at: number
  updated_at: number
}

/**
 * Input for creating/updating a cached chat
 */
export interface CachedChatInput {
  chat_id: string
  type: ChatType
  title: string | null
  username: string | null
  member_count: number | null
  access_hash: string | null
  is_creator: number
  is_admin: number
  last_message_id: number | null
  last_message_at: number | null
  fetched_at: number
  raw_json: string
}

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
  private deleteByIdStmt
  private countAllStmt
  private countByTypeStmt
  private getStaleStmt
  private pruneStmt

  constructor(
    private db: Database,
    _config?: CacheConfig,
  ) {
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

    this.deleteByIdStmt = db.query(
      'DELETE FROM chats_cache WHERE chat_id = $chat_id',
    )

    this.countAllStmt = db.query('SELECT COUNT(*) as count FROM chats_cache')

    this.countByTypeStmt = db.query(
      'SELECT COUNT(*) as count FROM chats_cache WHERE type = $type',
    )

    this.getStaleStmt = db
      .query('SELECT * FROM chats_cache WHERE fetched_at < $threshold')
      .as(ChatCacheRow)

    this.pruneStmt = db.query(
      'DELETE FROM chats_cache WHERE fetched_at < $threshold',
    )
  }

  /**
   * Get chat by ID
   */
  getById(chatId: string): CachedChat | null {
    const row = this.getByIdStmt.get({ $chat_id: chatId })
    return row ? this.rowToChat(row) : null
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
    const row = this.getByUsernameStmt.get({ $username: cleanUsername })
    return row ? this.rowToChat(row) : null
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

    // Build query based on whether type filter is specified
    if (type) {
      const query = `
        SELECT * FROM chats_cache
        WHERE type = $type
        ${orderClause}
        LIMIT $limit OFFSET $offset
      `
      const rows = this.db
        .query(query)
        .as(ChatCacheRow)
        .all({ $type: type, $limit: limit, $offset: offset })
      return rows.map((row) => this.rowToChat(row))
    }

    const query = `
      SELECT * FROM chats_cache
      ${orderClause}
      LIMIT $limit OFFSET $offset
    `
    const rows = this.db
      .query(query)
      .as(ChatCacheRow)
      .all({ $limit: limit, $offset: offset })
    return rows.map((row) => this.rowToChat(row))
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

    const rows = this.db.query(sql).as(ChatCacheRow).all({
      $pattern: searchPattern,
      $exact: query,
      $limit: limit,
    })

    return rows.map((row) => this.rowToChat(row))
  }

  /**
   * Get stale chats (older than TTL)
   */
  getStale(ttlMs: number): CachedChat[] {
    const threshold = Date.now() - ttlMs
    const rows = this.getStaleStmt.all({ $threshold: threshold })
    return rows.map((row) => this.rowToChat(row))
  }

  /**
   * Delete chat from cache
   */
  delete(chatId: string): boolean {
    const result = this.deleteByIdStmt.run({ $chat_id: chatId })
    return result.changes > 0
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

  /**
   * Prune old entries
   */
  prune(maxAgeMs: number): number {
    const threshold = Date.now() - maxAgeMs
    const result = this.pruneStmt.run({ $threshold: threshold })
    return result.changes
  }

  /**
   * Convert a database row to CachedChat
   */
  private rowToChat(row: ChatCacheRow): CachedChat {
    return {
      chat_id: row.chat_id,
      type: row.type as ChatType,
      title: row.title,
      username: row.username,
      member_count: row.member_count,
      access_hash: row.access_hash,
      is_creator: row.is_creator,
      is_admin: row.is_admin,
      last_message_id: row.last_message_id,
      last_message_at: row.last_message_at,
      fetched_at: row.fetched_at,
      raw_json: row.raw_json,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }
}

/**
 * Factory function to create a ChatsCache instance
 */
export function createChatsCache(
  db: Database,
  config?: CacheConfig,
): ChatsCache {
  return new ChatsCache(db, config)
}
