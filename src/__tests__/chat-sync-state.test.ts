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
