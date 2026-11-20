import type { Database } from "bun:sqlite";

import { legacyChatIdCandidates } from "../utils/telegram-peer-ids";
import { ChatCacheRow } from "./schema";
import type { ChatType } from "./types";

/**
 * Cached chat data structure (matches database row)
 */
export type CachedChat = ChatCacheRow;

/**
 * A chats_cache row to write. Only a dialog carries the unread state, so
 * null or left out keeps the cached one.
 */
export type CachedChatInput = Omit<
  CachedChat,
  "created_at" | "updated_at" | "unread_count" | "read_inbox_max_id"
> &
  Partial<Pick<CachedChat, "unread_count" | "read_inbox_max_id">>;

/**
 * Options for listing chats
 */
export interface ListChatsOptions {
  limit?: number;
  offset?: number;
  type?: ChatType;
  orderBy?: "last_message_at" | "title";
  /** Only chats with unread messages */
  unread?: boolean;
}

/**
 * Chats cache service class
 */
export class ChatsCache {
  private getByIdStmt;
  private getByUsernameStmt;
  private upsertStmt;
  private countAllStmt;
  private countByTypeStmt;
  private noteLiveMessageStmt;
  private setReadInboxStmt;

  constructor(private db: Database) {
    this.getByIdStmt = db
      .query("SELECT * FROM chats_cache WHERE chat_id = $chat_id")
      .as(ChatCacheRow);

    this.getByUsernameStmt = db
      .query(
        "SELECT * FROM chats_cache WHERE username = $username COLLATE NOCASE ORDER BY fetched_at DESC LIMIT 1",
      )
      .as(ChatCacheRow);

    this.upsertStmt = db.query(`
      INSERT INTO chats_cache (
        chat_id, type, title, username, member_count, access_hash,
        is_creator, is_admin, last_message_id, last_message_at,
        fetched_at, raw_json, created_at, updated_at,
        unread_count, read_inbox_max_id
      ) VALUES (
        $chat_id, $type, $title, $username, $member_count, $access_hash,
        $is_creator, $is_admin, $last_message_id, $last_message_at,
        $fetched_at, $raw_json, $now, $now,
        $unread_count, $read_inbox_max_id
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
        updated_at = $now,
        unread_count = COALESCE(excluded.unread_count, unread_count),
        read_inbox_max_id = COALESCE(
          excluded.read_inbox_max_id, read_inbox_max_id
        )
    `);

    this.countAllStmt = db.query("SELECT COUNT(*) as count FROM chats_cache");

    this.countByTypeStmt = db.query("SELECT COUNT(*) as count FROM chats_cache WHERE type = $type");

    this.noteLiveMessageStmt = db.query(`
      UPDATE chats_cache SET
        unread_count = CASE
          WHEN $incoming = 1
            AND $message_id > read_inbox_max_id
            AND $message_id > COALESCE(last_message_id, 0)
          THEN unread_count + 1
          ELSE unread_count
        END,
        last_message_id = MAX(COALESCE(last_message_id, 0), $message_id),
        last_message_at = MAX(COALESCE(last_message_at, 0), $date),
        updated_at = $now
      WHERE chat_id = $chat_id
    `);

    this.setReadInboxStmt = db.query(`
      UPDATE chats_cache SET
        unread_count = $unread_count,
        read_inbox_max_id = $max_id,
        updated_at = $now
      WHERE chat_id = $chat_id
    `);
  }

  /**
   * Get chat by ID
   */
  getById(chatId: string) {
    return this.getByIdStmt.get({ $chat_id: chatId });
  }

  /**
   * The cached chats a bare positive ID from 0.2.0 or older can name:
   * basic group N (-N) and channel N (-100…N). Cache-only; usually none or
   * one, two only when both are cached.
   */
  getByLegacyId(bareId: number) {
    return legacyChatIdCandidates(bareId)
      .map((peerId) => this.getById(String(peerId)))
      .filter((chat): chat is CachedChat => chat !== null);
  }

  /**
   * Get chat by username (without @); the latest fetched owner of a
   * username that moved wins
   */
  getByUsername(username: string) {
    const cleanUsername = username.startsWith("@") ? username.slice(1) : username;
    return this.getByUsernameStmt.get({ $username: cleanUsername });
  }

  /**
   * Insert or update chat
   */
  upsert(chat: CachedChatInput) {
    const now = Date.now();
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
      $unread_count: chat.unread_count ?? null,
      $read_inbox_max_id: chat.read_inbox_max_id ?? null,
    });
  }

  /**
   * A live message: it raises the chat's newest message and, if it is an
   * incoming one past both the newest message and the read boundary, the
   * unread count. `date` is in milliseconds. No row, no change.
   */
  noteLiveMessage(chatId: string, message: { id: number; date: number; incoming: boolean }) {
    this.noteLiveMessageStmt.run({
      $chat_id: chatId,
      $message_id: message.id,
      $date: message.date,
      $incoming: message.incoming ? 1 : 0,
      $now: Date.now(),
    });
  }

  /**
   * The chat's unread state as Telegram reported it: a read update or the
   * dialog after `tg messages read`. False when the chat has no row.
   */
  setReadInbox(chatId: string, maxId: number, unreadCount: number) {
    const result = this.setReadInboxStmt.run({
      $chat_id: chatId,
      $max_id: maxId,
      $unread_count: unreadCount,
      $now: Date.now(),
    });
    return result.changes > 0;
  }

  /**
   * Bulk upsert multiple chats
   */
  upsertMany(chats: CachedChatInput[]) {
    if (chats.length === 0) return;

    this.db.transaction(() => {
      for (const chat of chats) {
        this.upsert(chat);
      }
    })();
  }

  /**
   * List chats with filtering and pagination
   */
  list(opts: ListChatsOptions = {}) {
    const { limit = 50, offset = 0, type, orderBy = "last_message_at", unread = false } = opts;

    const orderClause =
      orderBy === "title"
        ? "ORDER BY title COLLATE NOCASE ASC"
        : "ORDER BY last_message_at DESC NULLS LAST";

    return this.db
      .query(`
        SELECT * FROM chats_cache
        WHERE ($type IS NULL OR type = $type)
          ${unread ? "AND unread_count > 0" : ""}
        ${orderClause}
        LIMIT $limit OFFSET $offset
      `)
      .as(ChatCacheRow)
      .all({ $type: type || null, $limit: limit, $offset: offset });
  }

  /**
   * Search chats by title or username
   */
  search(query: string, limit = 20) {
    const searchPattern = `%${query}%`;

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
    `;

    return this.db.query(sql).as(ChatCacheRow).all({
      $pattern: searchPattern,
      $exact: query,
      $limit: limit,
    });
  }

  /**
   * Count total cached chats
   */
  count(type?: ChatType) {
    if (type) {
      const result = this.countByTypeStmt.get({ $type: type }) as {
        count: number;
      } | null;
      return result?.count ?? 0;
    }
    const result = this.countAllStmt.get() as { count: number } | null;
    return result?.count ?? 0;
  }

  /** Whether a dialog list or an update gave any chat its unread state */
  hasUnreadState() {
    return (
      this.db.query("SELECT 1 FROM chats_cache WHERE unread_count IS NOT NULL LIMIT 1").get() !==
      null
    );
  }
}

/**
 * Factory function to create a ChatsCache instance
 */
export function createChatsCache(db: Database) {
  return new ChatsCache(db);
}
