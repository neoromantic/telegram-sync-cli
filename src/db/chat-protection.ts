/**
 * chat_content_protection: the chat-level answer of the last online
 * content-protection check of `tg media download`, so a cache hit refuses
 * a protected chat's files offline too. Written only by the CLI.
 */
import type { Database } from 'bun:sqlite'

/** Why a chat's content is protected */
export type ChatProtectionReason = 'chat' | 'private_chat'

export interface ChatProtectionRow {
  chat_id: number
  protected: 0 | 1
  reason: ChatProtectionReason | null
  /** When the online check ran, ms */
  fetched_at: number
}

export interface ChatProtectionStore {
  get(chatId: number): ChatProtectionRow | null
  /**
   * Record an online check, a negative answer too: protection turned off
   * clears the block
   */
  record(
    chatId: number,
    result: { protected: boolean; reason: ChatProtectionReason | null },
    fetchedAt: number,
  ): void
}

export function createChatProtectionStore(db: Database): ChatProtectionStore {
  const stmts = {
    get: db.query<ChatProtectionRow, [number]>(`
      SELECT chat_id, protected, reason, fetched_at
      FROM chat_content_protection
      WHERE chat_id = ?
    `),
    record: db.prepare(`
      INSERT INTO chat_content_protection (chat_id, protected, reason, fetched_at)
      VALUES ($chat_id, $protected, $reason, $fetched_at)
      ON CONFLICT (chat_id) DO UPDATE SET
        protected = excluded.protected,
        reason = excluded.reason,
        fetched_at = excluded.fetched_at
    `),
  }

  return {
    get(chatId) {
      return stmts.get.get(chatId) ?? null
    },

    record(chatId, result, fetchedAt) {
      stmts.record.run({
        $chat_id: chatId,
        $protected: result.protected ? 1 : 0,
        $reason: result.protected ? result.reason : null,
        $fetched_at: fetchedAt,
      })
    },
  }
}
