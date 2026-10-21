/**
 * Chat sync state service
 * Manages per-chat synchronization state with dual cursors
 */
import type { Database } from 'bun:sqlite'
import {
  ChatSyncStateRow,
  determineSyncPolicy,
  type SyncChatType,
  type SyncMode,
  SyncPriority,
} from './sync-schema'

/**
 * Input for creating/updating chat sync state
 */
export interface ChatSyncStateInput {
  chat_id: number
  chat_type: SyncChatType
  /** Omitted or null keeps the stored count */
  member_count?: number | null
  sync_priority: SyncPriority
  sync_enabled: boolean
  forward_cursor?: number | null
  backward_cursor?: number | null
  total_messages?: number | null
}

/**
 * Options for updating cursors
 */
export interface UpdateCursorsOptions {
  forward_cursor?: number
  backward_cursor?: number
}

/**
 * The result of a chat's first page (the `initial_load` job)
 */
export interface FirstPageResult {
  /** Newest message ID on the page, 0 for an empty chat */
  forward_cursor: number
  /** Oldest message ID on the page, 0 for an empty chat */
  backward_cursor: number
  /** The page reached the start of the chat */
  history_complete: boolean
  /** Messages on the page that weren't cached yet */
  new_messages: number
}

/**
 * The result of one forward catch-up page
 */
export interface CatchupPageResult {
  /** The newest message ID on the page, or the old cursor if it was empty */
  forward_cursor: number
  /** Messages on the page that weren't cached yet */
  new_messages: number
  /**
   * The page reached the newest message (it wasn't full): settle
   * top_message_id at the new cursor, unless it changed during the fetch
   */
  caught_up: boolean
  /** top_message_id as read before the fetch */
  top_before: number | null
}

/**
 * Options for resetting sync state
 */
export interface ResetSyncStateOptions {
  /** Reset forward cursor to NULL (default: true) */
  forward_cursor?: boolean
  /** Reset backward cursor to NULL (default: true) */
  backward_cursor?: boolean
  /** Reset history_complete to 0 (default: true) */
  history_complete?: boolean
  /** Reset synced_messages to 0 (default: true) */
  synced_messages?: boolean
}

/**
 * Chat sync state service interface
 */
export interface ChatSyncStateService {
  /** Get sync state for a chat */
  get(chatId: number): ChatSyncStateRow | null
  /** Create or update sync state */
  upsert(input: ChatSyncStateInput): void
  /** Update cursors for a chat */
  updateCursors(chatId: number, options: UpdateCursorsOptions): void
  /** Mark history as complete */
  markHistoryComplete(chatId: number): void
  /** Increment synced messages count */
  incrementSyncedMessages(chatId: number, count: number): void
  /** Get all enabled chats ordered by priority */
  getEnabledChats(): ChatSyncStateRow[]
  /** Get chats by priority level */
  getChatsByPriority(priority: SyncPriority): ChatSyncStateRow[]
  /** Get chats with incomplete history (for backfill) */
  getIncompleteHistory(): ChatSyncStateRow[]
  /** Enabled chats without a forward cursor: they need their first page */
  getInitialLoadDue(): ChatSyncStateRow[]
  /**
   * Store a chat's first page: both cursors, history_complete and the
   * counter. Does nothing if the chat already has a forward cursor.
   */
  recordFirstPage(chatId: number, page: FirstPageResult): void
  /**
   * Enabled chats whose forward cursor is behind: top_message_id is unknown
   * or above the cursor
   */
  getCatchupDue(): ChatSyncStateRow[]
  /** Enabled chats with a forward cursor */
  getEnabledWithCursor(): ChatSyncStateRow[]
  /** Enabled chats that had their first page and have history left */
  getHistoryDue(): ChatSyncStateRow[]
  /** Store one catch-up page: the cursor, the counter and maybe the top */
  recordCatchupPage(chatId: number, page: CatchupPageResult): void
  /** Raise top_message_id to the given ID; never lowers it */
  raiseTopMessageId(chatId: number, topMessageId: number): void
  /** Mark chats as caught up: top_message_id = forward_cursor */
  markCaughtUp(chatIds: Iterable<number>): void
  /** Mark chats' newest message as unknown, so each gets one catch-up */
  markTopUnknown(chatIds: Iterable<number>): void
  /** Delete sync state for a chat */
  delete(chatId: number): void
  /** Update last sync timestamp */
  updateLastSync(chatId: number, type: 'forward' | 'backward'): void
  /** Enable or disable sync for a chat */
  setSyncEnabled(chatId: number, enabled: boolean): void
  /**
   * Set the user's choice and the sync_enabled and sync_priority it means:
   * 'on' syncs at High, 'off' doesn't sync, 'auto' follows the policy
   */
  setSyncMode(chatId: number, mode: SyncMode): void
  /** Reset sync state to allow re-syncing (sets cursors to NULL) */
  resetSyncState(chatId: number, options?: ResetSyncStateOptions): void
}

/**
 * Create a chat sync state service
 */
export function createChatSyncStateService(db: Database): ChatSyncStateService {
  const stmts = {
    get: db
      .query(`
      SELECT * FROM chat_sync_state WHERE chat_id = $chat_id
    `)
      .as(ChatSyncStateRow),

    upsert: db.prepare(`
      INSERT INTO chat_sync_state (
        chat_id, chat_type, member_count, sync_priority, sync_enabled,
        forward_cursor, backward_cursor, total_messages, updated_at
      ) VALUES (
        $chat_id, $chat_type, $member_count, $sync_priority, $sync_enabled,
        $forward_cursor, $backward_cursor, $total_messages, $now
      )
      ON CONFLICT(chat_id) DO UPDATE SET
        chat_type = excluded.chat_type,
        member_count = COALESCE(excluded.member_count, chat_sync_state.member_count),
        -- A mode set with tg chats sync outlives the policy.
        sync_priority = CASE WHEN chat_sync_state.sync_mode = 'on'
          THEN 1 ELSE excluded.sync_priority END,
        sync_enabled = CASE chat_sync_state.sync_mode
          WHEN 'on' THEN 1 WHEN 'off' THEN 0 ELSE excluded.sync_enabled END,
        forward_cursor = COALESCE(excluded.forward_cursor, chat_sync_state.forward_cursor),
        backward_cursor = COALESCE(excluded.backward_cursor, chat_sync_state.backward_cursor),
        total_messages = COALESCE(excluded.total_messages, chat_sync_state.total_messages),
        updated_at = excluded.updated_at
    `),

    updateForwardCursor: db.prepare(`
      UPDATE chat_sync_state
      SET forward_cursor = $cursor, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    updateBackwardCursor: db.prepare(`
      UPDATE chat_sync_state
      SET backward_cursor = $cursor, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    updateBothCursors: db.prepare(`
      UPDATE chat_sync_state
      SET forward_cursor = $forward, backward_cursor = $backward, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    markHistoryComplete: db.prepare(`
      UPDATE chat_sync_state
      SET history_complete = 1, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    incrementSyncedMessages: db.prepare(`
      UPDATE chat_sync_state
      SET synced_messages = synced_messages + $count, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    getEnabledChats: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE sync_enabled = 1
      ORDER BY sync_priority ASC, chat_id ASC
    `)
      .as(ChatSyncStateRow),

    getChatsByPriority: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE sync_priority = $priority AND sync_enabled = 1
      ORDER BY chat_id ASC
    `)
      .as(ChatSyncStateRow),

    getIncompleteHistory: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE history_complete = 0 AND sync_enabled = 1
      ORDER BY sync_priority ASC, chat_id ASC
    `)
      .as(ChatSyncStateRow),

    getInitialLoadDue: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE sync_enabled = 1 AND forward_cursor IS NULL
      ORDER BY sync_priority ASC, chat_id ASC
    `)
      .as(ChatSyncStateRow),

    recordFirstPage: db.prepare(`
      UPDATE chat_sync_state
      SET forward_cursor = $forward,
          backward_cursor = $backward,
          history_complete = $complete,
          top_message_id = MAX(COALESCE(top_message_id, 0), $forward),
          synced_messages = synced_messages + $count,
          last_forward_sync = $now,
          updated_at = $now
      WHERE chat_id = $chat_id AND forward_cursor IS NULL
    `),

    getCatchupDue: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE sync_enabled = 1
        AND forward_cursor IS NOT NULL
        AND (top_message_id IS NULL OR top_message_id > forward_cursor)
      ORDER BY sync_priority ASC, chat_id ASC
    `)
      .as(ChatSyncStateRow),

    getEnabledWithCursor: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE sync_enabled = 1 AND forward_cursor IS NOT NULL
      ORDER BY chat_id ASC
    `)
      .as(ChatSyncStateRow),

    getHistoryDue: db
      .query(`
      SELECT * FROM chat_sync_state
      WHERE sync_enabled = 1
        AND forward_cursor IS NOT NULL
        AND history_complete = 0
      ORDER BY sync_priority ASC, chat_id ASC
    `)
      .as(ChatSyncStateRow),

    // A top raised during the fetch (by a dialog pass) is newer than the
    // page, so it stays and the chat stays due.
    recordCatchupPage: db.prepare(`
      UPDATE chat_sync_state
      SET forward_cursor = $cursor,
          top_message_id = CASE
            WHEN $caught_up = 1
              AND COALESCE(top_message_id, -1) <= COALESCE($top_before, -1)
            THEN $cursor
            ELSE top_message_id
          END,
          synced_messages = synced_messages + $count,
          last_forward_sync = $now,
          updated_at = $now
      WHERE chat_id = $chat_id
    `),

    raiseTopMessageId: db.prepare(`
      UPDATE chat_sync_state
      SET top_message_id = MAX(COALESCE(top_message_id, 0), $top),
          updated_at = $now
      WHERE chat_id = $chat_id
    `),

    markCaughtUp: db.prepare(`
      UPDATE chat_sync_state
      SET top_message_id = forward_cursor, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    markTopUnknown: db.prepare(`
      UPDATE chat_sync_state
      SET top_message_id = NULL, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    delete: db.prepare(`
      DELETE FROM chat_sync_state WHERE chat_id = $chat_id
    `),

    updateLastForwardSync: db.prepare(`
      UPDATE chat_sync_state
      SET last_forward_sync = $now, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    updateLastBackwardSync: db.prepare(`
      UPDATE chat_sync_state
      SET last_backward_sync = $now, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    setSyncEnabled: db.prepare(`
      UPDATE chat_sync_state
      SET sync_enabled = $enabled, updated_at = $now
      WHERE chat_id = $chat_id
    `),

    setSyncMode: db.prepare(`
      UPDATE chat_sync_state
      SET sync_mode = $mode,
          sync_enabled = $enabled,
          sync_priority = $priority,
          updated_at = $now
      WHERE chat_id = $chat_id
    `),

    resetSyncState: db.prepare(`
      UPDATE chat_sync_state
      SET
        forward_cursor = CASE WHEN $reset_forward = 1 THEN NULL ELSE forward_cursor END,
        backward_cursor = CASE WHEN $reset_backward = 1 THEN NULL ELSE backward_cursor END,
        history_complete = CASE WHEN $reset_history = 1 THEN 0 ELSE history_complete END,
        synced_messages = CASE WHEN $reset_synced = 1 THEN 0 ELSE synced_messages END,
        updated_at = $now
      WHERE chat_id = $chat_id
    `),
  }

  return {
    get(chatId: number): ChatSyncStateRow | null {
      return stmts.get.get({ $chat_id: chatId }) ?? null
    },

    upsert(input: ChatSyncStateInput): void {
      stmts.upsert.run({
        $chat_id: input.chat_id,
        $chat_type: input.chat_type,
        $member_count: input.member_count ?? null,
        $sync_priority: input.sync_priority,
        $sync_enabled: input.sync_enabled ? 1 : 0,
        $forward_cursor: input.forward_cursor ?? null,
        $backward_cursor: input.backward_cursor ?? null,
        $total_messages: input.total_messages ?? null,
        $now: Date.now(),
      })
    },

    updateCursors(chatId: number, options: UpdateCursorsOptions): void {
      const now = Date.now()

      if (
        options.forward_cursor !== undefined &&
        options.backward_cursor !== undefined
      ) {
        stmts.updateBothCursors.run({
          $chat_id: chatId,
          $forward: options.forward_cursor,
          $backward: options.backward_cursor,
          $now: now,
        })
      } else if (options.forward_cursor !== undefined) {
        stmts.updateForwardCursor.run({
          $chat_id: chatId,
          $cursor: options.forward_cursor,
          $now: now,
        })
      } else if (options.backward_cursor !== undefined) {
        stmts.updateBackwardCursor.run({
          $chat_id: chatId,
          $cursor: options.backward_cursor,
          $now: now,
        })
      }
    },

    markHistoryComplete(chatId: number): void {
      stmts.markHistoryComplete.run({
        $chat_id: chatId,
        $now: Date.now(),
      })
    },

    incrementSyncedMessages(chatId: number, count: number): void {
      stmts.incrementSyncedMessages.run({
        $chat_id: chatId,
        $count: count,
        $now: Date.now(),
      })
    },

    getEnabledChats(): ChatSyncStateRow[] {
      return stmts.getEnabledChats.all()
    },

    getChatsByPriority(priority: SyncPriority): ChatSyncStateRow[] {
      return stmts.getChatsByPriority.all({ $priority: priority })
    },

    getIncompleteHistory(): ChatSyncStateRow[] {
      return stmts.getIncompleteHistory.all()
    },

    getInitialLoadDue(): ChatSyncStateRow[] {
      return stmts.getInitialLoadDue.all()
    },

    recordFirstPage(chatId: number, page: FirstPageResult): void {
      stmts.recordFirstPage.run({
        $chat_id: chatId,
        $forward: page.forward_cursor,
        $backward: page.backward_cursor,
        $complete: page.history_complete ? 1 : 0,
        $count: page.new_messages,
        $now: Date.now(),
      })
    },

    getCatchupDue(): ChatSyncStateRow[] {
      return stmts.getCatchupDue.all()
    },

    getEnabledWithCursor(): ChatSyncStateRow[] {
      return stmts.getEnabledWithCursor.all()
    },

    getHistoryDue(): ChatSyncStateRow[] {
      return stmts.getHistoryDue.all()
    },

    recordCatchupPage(chatId: number, page: CatchupPageResult): void {
      stmts.recordCatchupPage.run({
        $chat_id: chatId,
        $cursor: page.forward_cursor,
        $caught_up: page.caught_up ? 1 : 0,
        $top_before: page.top_before,
        $count: page.new_messages,
        $now: Date.now(),
      })
    },

    raiseTopMessageId(chatId: number, topMessageId: number): void {
      stmts.raiseTopMessageId.run({
        $chat_id: chatId,
        $top: topMessageId,
        $now: Date.now(),
      })
    },

    markCaughtUp(chatIds: Iterable<number>): void {
      const now = Date.now()
      db.transaction(() => {
        for (const chatId of chatIds) {
          stmts.markCaughtUp.run({ $chat_id: chatId, $now: now })
        }
      })()
    },

    markTopUnknown(chatIds: Iterable<number>): void {
      const now = Date.now()
      db.transaction(() => {
        for (const chatId of chatIds) {
          stmts.markTopUnknown.run({ $chat_id: chatId, $now: now })
        }
      })()
    },

    delete(chatId: number): void {
      stmts.delete.run({ $chat_id: chatId })
    },

    updateLastSync(chatId: number, type: 'forward' | 'backward'): void {
      const now = Date.now()
      if (type === 'forward') {
        stmts.updateLastForwardSync.run({ $chat_id: chatId, $now: now })
      } else {
        stmts.updateLastBackwardSync.run({ $chat_id: chatId, $now: now })
      }
    },

    setSyncEnabled(chatId: number, enabled: boolean): void {
      stmts.setSyncEnabled.run({
        $chat_id: chatId,
        $enabled: enabled ? 1 : 0,
        $now: Date.now(),
      })
    },

    setSyncMode(chatId: number, mode: SyncMode): void {
      const state = stmts.get.get({ $chat_id: chatId })
      if (!state) return

      const policy = determineSyncPolicy(
        state.chat_type as SyncChatType,
        state.member_count,
      )
      const enabled =
        mode === 'on' ? true : mode === 'off' ? false : policy.enabled
      stmts.setSyncMode.run({
        $chat_id: chatId,
        $mode: mode,
        $enabled: enabled ? 1 : 0,
        $priority: mode === 'on' ? SyncPriority.High : policy.priority,
        $now: Date.now(),
      })
    },

    resetSyncState(chatId: number, options: ResetSyncStateOptions = {}): void {
      const {
        forward_cursor = true,
        backward_cursor = true,
        history_complete = true,
        synced_messages = true,
      } = options

      stmts.resetSyncState.run({
        $chat_id: chatId,
        $reset_forward: forward_cursor ? 1 : 0,
        $reset_backward: backward_cursor ? 1 : 0,
        $reset_history: history_complete ? 1 : 0,
        $reset_synced: synced_messages ? 1 : 0,
        $now: Date.now(),
      })
    },
  }
}
