/**
 * Tests for chat sync state service
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  type ChatSyncStateInput,
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../db/chat-sync-state'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema, SyncPriority } from '../db/sync-schema'

describe('ChatSyncStateService', () => {
  let db: Database
  let service: ChatSyncStateService

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    service = createChatSyncStateService(db)
  })

  describe('upsert', () => {
    it('creates new sync state for a chat', () => {
      const input: ChatSyncStateInput = {
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      }

      service.upsert(input)

      const state = service.get(100)
      expect(state).not.toBeNull()
      expect(state?.chat_type).toBe('private')
      expect(state?.sync_priority).toBe(SyncPriority.High)
      expect(state?.sync_enabled).toBe(1)
    })

    it('updates existing sync state', () => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.Medium,
        sync_enabled: false,
      })

      const state = service.get(100)
      expect(state?.sync_priority).toBe(SyncPriority.Medium)
      expect(state?.sync_enabled).toBe(0)
    })
  })

  describe('upsert member_count', () => {
    it('keeps the stored count when the update has none', () => {
      service.upsert({
        chat_id: -4001,
        chat_type: 'group',
        member_count: 42,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })

      service.upsert({
        chat_id: -4001,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })
      expect(service.get(-4001)?.member_count).toBe(42)

      service.upsert({
        chat_id: -4001,
        chat_type: 'group',
        member_count: 12,
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      expect(service.get(-4001)?.member_count).toBe(12)
    })
  })

  describe('setSyncMode', () => {
    const CHANNEL = -1001234567890

    beforeEach(() => {
      service.upsert({
        chat_id: CHANNEL,
        chat_type: 'channel',
        member_count: 5000,
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
      })
    })

    // What the dialog pass writes for the channel from the policy
    const passUpsert = (enabled: boolean, memberCount?: number) =>
      service.upsert({
        chat_id: CHANNEL,
        chat_type: 'supergroup',
        member_count: memberCount,
        sync_priority: enabled ? SyncPriority.High : SyncPriority.Low,
        sync_enabled: enabled,
      })

    it('starts at auto', () => {
      expect(service.get(CHANNEL)?.sync_mode).toBe('auto')
    })

    it('writes the sync_enabled and sync_priority each mode means', () => {
      service.setSyncMode(CHANNEL, 'on')
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: 'on',
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
      })

      service.setSyncMode(CHANNEL, 'off')
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: 'off',
        sync_enabled: 0,
      })

      service.setSyncMode(CHANNEL, 'auto')
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: 'auto',
        sync_enabled: 0,
        sync_priority: SyncPriority.Low,
      })
    })

    it('keeps a chat turned on through a dialog pass', () => {
      service.setSyncMode(CHANNEL, 'on')

      passUpsert(false, 6000)

      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: 'on',
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
        chat_type: 'supergroup',
        member_count: 6000,
      })
    })

    it('keeps a chat turned off through a dialog pass', () => {
      service.setSyncMode(CHANNEL, 'off')

      passUpsert(true, 10)

      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: 'off',
        sync_enabled: 0,
        member_count: 10,
      })
    })

    it('lets the policy decide under auto', () => {
      passUpsert(true, 10)
      expect(service.get(CHANNEL)).toMatchObject({
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
      })

      passUpsert(false)
      expect(service.get(CHANNEL)).toMatchObject({
        sync_enabled: 0,
        sync_priority: SyncPriority.Low,
      })
    })
  })

  describe('top_message_id', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
      })
    })

    const due = () => service.getCatchupDue().map((chat) => chat.chat_id)

    it('starts unknown, which counts as behind', () => {
      expect(service.get(100)?.top_message_id).toBeNull()
      expect(due()).toEqual([100])
    })

    it('only rises', () => {
      service.raiseTopMessageId(100, 1150)
      service.raiseTopMessageId(100, 1100)
      expect(service.get(100)?.top_message_id).toBe(1150)
      expect(due()).toEqual([100])
    })

    it('is not due once the top is at or below the cursor', () => {
      service.raiseTopMessageId(100, 1000)
      expect(due()).toEqual([])
    })

    it('is due only for enabled chats with a cursor', () => {
      service.upsert({
        chat_id: 200,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      service.upsert({
        chat_id: 300,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
        forward_cursor: 10,
      })
      expect(due()).toEqual([100])
    })

    it('settles at the new cursor after a page that reached the newest message', () => {
      service.raiseTopMessageId(100, 1200)
      service.recordCatchupPage(100, {
        forward_cursor: 1150,
        new_messages: 150,
        caught_up: true,
        top_before: 1200,
      })

      const state = service.get(100)
      expect(state?.forward_cursor).toBe(1150)
      expect(state?.top_message_id).toBe(1150)
      expect(state?.synced_messages).toBe(150)
      expect(state?.last_forward_sync).not.toBeNull()
      expect(due()).toEqual([])
    })

    it('keeps a top that rose during the fetch', () => {
      service.raiseTopMessageId(100, 1150)
      // A dialog pass saw a newer message while the page was in flight
      service.raiseTopMessageId(100, 1160)
      service.recordCatchupPage(100, {
        forward_cursor: 1150,
        new_messages: 150,
        caught_up: true,
        top_before: 1150,
      })

      expect(service.get(100)?.top_message_id).toBe(1160)
      expect(due()).toEqual([100])
    })

    it('leaves the top alone after a full page', () => {
      service.raiseTopMessageId(100, 1150)
      service.recordCatchupPage(100, {
        forward_cursor: 1100,
        new_messages: 100,
        caught_up: false,
        top_before: 1150,
      })

      expect(service.get(100)?.top_message_id).toBe(1150)
      expect(due()).toEqual([100])
    })

    it('marks chats caught up or unknown', () => {
      service.markCaughtUp([100])
      expect(service.get(100)?.top_message_id).toBe(1000)

      service.markTopUnknown([100])
      expect(service.get(100)?.top_message_id).toBeNull()
    })
  })

  describe('updateCursors', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    })

    it('updates forward cursor', () => {
      service.updateCursors(100, { forward_cursor: 1000 })

      const state = service.get(100)
      expect(state?.forward_cursor).toBe(1000)
    })

    it('updates backward cursor', () => {
      service.updateCursors(100, { backward_cursor: 500 })

      const state = service.get(100)
      expect(state?.backward_cursor).toBe(500)
    })

    it('updates both cursors', () => {
      service.updateCursors(100, { forward_cursor: 1000, backward_cursor: 500 })

      const state = service.get(100)
      expect(state?.forward_cursor).toBe(1000)
      expect(state?.backward_cursor).toBe(500)
    })
  })

  describe('markHistoryComplete', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    })

    it('marks history as complete', () => {
      service.markHistoryComplete(100)

      const state = service.get(100)
      expect(state?.history_complete).toBe(1)
    })
  })

  describe('incrementSyncedMessages', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    })

    it('increments synced messages count', () => {
      service.incrementSyncedMessages(100, 10)
      expect(service.get(100)?.synced_messages).toBe(10)

      service.incrementSyncedMessages(100, 5)
      expect(service.get(100)?.synced_messages).toBe(15)
    })
  })

  describe('getEnabledChats', () => {
    beforeEach(() => {
      // Create chats with different sync settings
      service.upsert({
        chat_id: 1,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      service.upsert({
        chat_id: 2,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })
      service.upsert({
        chat_id: 3,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
      })
      service.upsert({
        chat_id: 4,
        chat_type: 'supergroup',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    })

    it('returns only enabled chats', () => {
      const enabled = service.getEnabledChats()
      expect(enabled).toHaveLength(3)
      expect(enabled.map((c) => c.chat_id)).toContain(1)
      expect(enabled.map((c) => c.chat_id)).toContain(2)
      expect(enabled.map((c) => c.chat_id)).toContain(4)
      expect(enabled.map((c) => c.chat_id)).not.toContain(3)
    })

    it('orders by priority (lower number = higher priority)', () => {
      const enabled = service.getEnabledChats()
      expect(enabled[0]!.sync_priority).toBeLessThanOrEqual(
        enabled[1]!.sync_priority,
      )
    })
  })

  describe('getChatsByPriority', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 1,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      service.upsert({
        chat_id: 2,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      service.upsert({
        chat_id: 3,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })
    })

    it('returns chats with specific priority', () => {
      const highPriority = service.getChatsByPriority(SyncPriority.High)
      expect(highPriority).toHaveLength(2)
      expect(
        highPriority.every((c) => c.sync_priority === SyncPriority.High),
      ).toBe(true)
    })
  })

  describe('getIncompleteHistory', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 1,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      service.upsert({
        chat_id: 2,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      service.markHistoryComplete(1)
    })

    it('returns only chats with incomplete history', () => {
      const incomplete = service.getIncompleteHistory()
      expect(incomplete).toHaveLength(1)
      expect(incomplete[0]!.chat_id).toBe(2)
    })

    it('excludes disabled chats', () => {
      service.upsert({
        chat_id: 3,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
      })

      const incomplete = service.getIncompleteHistory()
      expect(incomplete.map((c) => c.chat_id)).not.toContain(3)
    })
  })

  describe('delete', () => {
    it('removes sync state for a chat', () => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      expect(service.get(100)).not.toBeNull()

      service.delete(100)
      expect(service.get(100)).toBeNull()
    })
  })

  describe('updateLastSync', () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    })

    it('updates last_forward_sync timestamp', () => {
      const before = service.get(100)?.last_forward_sync
      expect(before).toBeNull()

      service.updateLastSync(100, 'forward')

      const after = service.get(100)?.last_forward_sync
      expect(after).not.toBeNull()
      expect(after).toBeGreaterThan(0)
    })

    it('updates last_backward_sync timestamp', () => {
      service.updateLastSync(100, 'backward')

      const state = service.get(100)
      expect(state?.last_backward_sync).not.toBeNull()
    })
  })

  describe('resetSyncState', () => {
    beforeEach(() => {
      // Create a chat with cursors and progress
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 500,
      })
      service.markHistoryComplete(100)
      service.incrementSyncedMessages(100, 50)
    })

    it('resets all fields by default', () => {
      // Verify initial state
      let state = service.get(100)
      expect(state?.forward_cursor).toBe(1000)
      expect(state?.backward_cursor).toBe(500)
      expect(state?.history_complete).toBe(1)
      expect(state?.synced_messages).toBe(50)

      // Reset
      service.resetSyncState(100)

      // Verify reset state
      state = service.get(100)
      expect(state?.forward_cursor).toBeNull()
      expect(state?.backward_cursor).toBeNull()
      expect(state?.history_complete).toBe(0)
      expect(state?.synced_messages).toBe(0)
    })

    it('resets only forward cursor when specified', () => {
      service.resetSyncState(100, {
        forward_cursor: true,
        backward_cursor: false,
        history_complete: false,
        synced_messages: false,
      })

      const state = service.get(100)
      expect(state?.forward_cursor).toBeNull()
      expect(state?.backward_cursor).toBe(500)
      expect(state?.history_complete).toBe(1)
      expect(state?.synced_messages).toBe(50)
    })

    it('resets only backward cursor when specified', () => {
      service.resetSyncState(100, {
        forward_cursor: false,
        backward_cursor: true,
        history_complete: false,
        synced_messages: false,
      })

      const state = service.get(100)
      expect(state?.forward_cursor).toBe(1000)
      expect(state?.backward_cursor).toBeNull()
      expect(state?.history_complete).toBe(1)
      expect(state?.synced_messages).toBe(50)
    })

    it('resets cursors without affecting history_complete or synced_messages', () => {
      service.resetSyncState(100, {
        forward_cursor: true,
        backward_cursor: true,
        history_complete: false,
        synced_messages: false,
      })

      const state = service.get(100)
      expect(state?.forward_cursor).toBeNull()
      expect(state?.backward_cursor).toBeNull()
      expect(state?.history_complete).toBe(1)
      expect(state?.synced_messages).toBe(50)
    })

    it('allows re-syncing after reset (Issue #27)', () => {
      // This is the main use case: reset cursors to NULL so upsert won't use COALESCE
      service.resetSyncState(100)

      // Verify cursors are NULL
      let state = service.get(100)
      expect(state?.forward_cursor).toBeNull()
      expect(state?.backward_cursor).toBeNull()

      // Now upsert with new cursor values
      service.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 2000,
        backward_cursor: 1500,
      })

      // Verify new values are set (not the old ones via COALESCE)
      state = service.get(100)
      expect(state?.forward_cursor).toBe(2000)
      expect(state?.backward_cursor).toBe(1500)
    })
  })
})
