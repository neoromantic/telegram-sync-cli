/**
 * Tests for messages cache service
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createMessagesCache,
  type MessageInput,
  type MessagesCache,
} from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

describe('MessagesCache', () => {
  let db: Database
  let cache: MessagesCache

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    cache = createMessagesCache(db)
  })

  describe('upsert', () => {
    it('inserts a new message', () => {
      const message: MessageInput = {
        chat_id: 100,
        message_id: 1,
        from_id: 123,
        text: 'Hello world',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{"_":"message"}',
      }

      cache.upsert(message)

      const retrieved = cache.get(100, 1)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.text).toBe('Hello world')
      expect(retrieved?.from_id).toBe(123)
    })

    it('updates an existing message', () => {
      const message: MessageInput = {
        chat_id: 100,
        message_id: 1,
        text: 'Original',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      }

      cache.upsert(message)
      cache.upsert({ ...message, text: 'Updated', is_edited: true })

      const retrieved = cache.get(100, 1)
      expect(retrieved?.text).toBe('Updated')
      expect(retrieved?.is_edited).toBe(1)
    })

    it('preserves created_at timestamp when updating an existing message', async () => {
      const message: MessageInput = {
        chat_id: 100,
        message_id: 1,
        text: 'Original',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      }

      // Insert original message
      cache.upsert(message)
      const original = cache.get(100, 1)
      const originalCreatedAt = original?.created_at

      expect(originalCreatedAt).toBeDefined()

      // Wait a bit to ensure timestamps would differ
      await new Promise((resolve) => setTimeout(resolve, 10))

      // Update the message
      cache.upsert({ ...message, text: 'Updated', is_edited: true })
      const updated = cache.get(100, 1)

      // created_at should be preserved
      expect(updated?.created_at).toBe(originalCreatedAt)
      // updated_at should change
      expect(updated?.updated_at).toBeGreaterThanOrEqual(originalCreatedAt!)
      // Content should be updated
      expect(updated?.text).toBe('Updated')
    })

    it('preserves created_at through multiple updates', async () => {
      const message: MessageInput = {
        chat_id: 100,
        message_id: 1,
        text: 'Version 1',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      }

      // Insert original
      cache.upsert(message)
      const original = cache.get(100, 1)
      const originalCreatedAt = original?.created_at

      // Wait and update multiple times
      await new Promise((resolve) => setTimeout(resolve, 10))
      cache.upsert({ ...message, text: 'Version 2' })

      await new Promise((resolve) => setTimeout(resolve, 10))
      cache.upsert({ ...message, text: 'Version 3' })

      await new Promise((resolve) => setTimeout(resolve, 10))
      cache.upsert({ ...message, text: 'Version 4' })

      const final = cache.get(100, 1)

      // created_at should still be the original timestamp
      expect(final?.created_at).toBe(originalCreatedAt)
      // Content should reflect latest update
      expect(final?.text).toBe('Version 4')
      // updated_at should be newer than created_at
      expect(final?.updated_at).toBeGreaterThan(originalCreatedAt!)
    })
  })

  describe('get', () => {
    it('returns null for non-existent message', () => {
      expect(cache.get(100, 999)).toBeNull()
    })

    it('retrieves message by chat_id and message_id', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 42,
        text: 'Test message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const result = cache.get(100, 42)
      expect(result).not.toBeNull()
      expect(result?.text).toBe('Test message')
    })
  })

  describe('listByChatId', () => {
    beforeEach(() => {
      // Insert test messages
      const baseTime = Date.now()
      for (let i = 1; i <= 5; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Message ${i}`,
          message_type: 'text',
          date: baseTime + i * 1000, // Each message 1 second apart
          raw_json: '{}',
        })
      }
    })

    it('returns messages in reverse chronological order', () => {
      const messages = cache.listByChatId(100, { limit: 10 })
      expect(messages).toHaveLength(5)
      expect(messages[0]!.message_id).toBe(5) // Most recent first
      expect(messages[4]!.message_id).toBe(1)
    })

    it('respects limit parameter', () => {
      const messages = cache.listByChatId(100, { limit: 3 })
      expect(messages).toHaveLength(3)
    })

    it('supports offset parameter', () => {
      const messages = cache.listByChatId(100, { limit: 2, offset: 2 })
      expect(messages).toHaveLength(2)
      expect(messages[0]!.message_id).toBe(3)
    })

    it('returns empty array for chat with no messages', () => {
      const messages = cache.listByChatId(999, { limit: 10 })
      expect(messages).toEqual([])
    })
  })

  describe('markDeleted', () => {
    it('marks a single message as deleted', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Will be deleted',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      cache.markDeleted(100, [1])

      const msg = cache.get(100, 1)
      expect(msg?.is_deleted).toBe(1)
    })

    it('marks multiple messages as deleted', () => {
      for (let i = 1; i <= 3; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Message ${i}`,
          message_type: 'text',
          date: Date.now(),
          raw_json: '{}',
        })
      }

      cache.markDeleted(100, [1, 3])

      expect(cache.get(100, 1)?.is_deleted).toBe(1)
      expect(cache.get(100, 2)?.is_deleted).toBe(0)
      expect(cache.get(100, 3)?.is_deleted).toBe(1)
    })
  })

  describe('findChatIdsByMessageIds', () => {
    it('returns empty map for empty input', () => {
      const result = cache.findChatIdsByMessageIds([])
      expect(result.chatIds.size).toBe(0)
      expect(result.ambiguous).toEqual([])
    })

    it('returns empty map when no messages found', () => {
      const result = cache.findChatIdsByMessageIds([1, 2, 3])
      expect(result.chatIds.size).toBe(0)
      expect(result.ambiguous).toEqual([])
    })

    it('finds chat IDs for existing messages', () => {
      // Create messages in different chats
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Message in chat 100',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 200,
        message_id: 2,
        text: 'Message in chat 200',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 3,
        text: 'Another in chat 100',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const { chatIds } = cache.findChatIdsByMessageIds([1, 2, 3, 999])

      expect(chatIds.size).toBe(3) // 999 not found
      expect(chatIds.get(1)).toBe(100)
      expect(chatIds.get(2)).toBe(200)
      expect(chatIds.get(3)).toBe(100)
      expect(chatIds.has(999)).toBe(false)
    })

    it('skips message IDs that exist in multiple chats', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 42,
        text: 'Message in chat 100',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 200,
        message_id: 42,
        text: 'Message in chat 200',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const result = cache.findChatIdsByMessageIds([42])

      expect(result.chatIds.has(42)).toBe(false)
      expect(result.ambiguous).toEqual([{ messageId: 42, chatIds: [100, 200] }])
    })
  })

  describe('markDeletedByMessageIds', () => {
    it('returns 0 for empty input', () => {
      expect(cache.markDeletedByMessageIds([])).toEqual({
        deleted: 0,
        ambiguous: [],
      })
    })

    it('returns 0 when no messages found', () => {
      expect(cache.markDeletedByMessageIds([1, 2, 3])).toEqual({
        deleted: 0,
        ambiguous: [],
      })
    })

    it('marks messages as deleted across multiple chats', () => {
      // Create messages in different chats (simulating DMs and groups)
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'DM message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 200,
        message_id: 2,
        text: 'Group message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 3,
        text: 'Another DM',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 300,
        message_id: 4,
        text: 'Unaffected message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      // Delete messages 1, 2, and 3 (without knowing their chat IDs)
      const { deleted } = cache.markDeletedByMessageIds([1, 2, 3])

      expect(deleted).toBe(3)
      expect(cache.get(100, 1)?.is_deleted).toBe(1)
      expect(cache.get(200, 2)?.is_deleted).toBe(1)
      expect(cache.get(100, 3)?.is_deleted).toBe(1)
      expect(cache.get(300, 4)?.is_deleted).toBe(0) // Unaffected
    })

    it('handles partial matches gracefully', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 5,
        text: 'Only existing message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      // Try to delete messages where only one exists
      const { deleted } = cache.markDeletedByMessageIds([5, 999, 1000])

      expect(deleted).toBe(1)
      expect(cache.get(100, 5)?.is_deleted).toBe(1)
    })

    it('does not delete when message ID is ambiguous across chats', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 42,
        text: 'Message in chat 100',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 200,
        message_id: 42,
        text: 'Message in chat 200',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const { deleted } = cache.markDeletedByMessageIds([42])

      expect(deleted).toBe(0)
      expect(cache.get(100, 42)?.is_deleted).toBe(0)
      expect(cache.get(200, 42)?.is_deleted).toBe(0)
    })

    it('deletes when only one matching message is not already deleted', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 42,
        text: 'Message in chat 100',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 200,
        message_id: 42,
        text: 'Message in chat 200',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      cache.markDeleted(100, [42])

      const { deleted } = cache.markDeletedByMessageIds([42])

      expect(deleted).toBe(1)
      expect(cache.get(100, 42)?.is_deleted).toBe(1)
      expect(cache.get(200, 42)?.is_deleted).toBe(1)
    })

    /** Caches message 7 in each of the given chats */
    function cacheMessageSeven(chatIds: number[]): void {
      for (const chatId of chatIds) {
        cache.upsert({
          chat_id: chatId,
          message_id: 7,
          text: `made-up message in ${chatId}`,
          message_type: 'text',
          date: 1_760_000_000,
          raw_json: '{}',
        })
      }
    }

    it("marks the private chat's message when a channel has the same ID", () => {
      cacheMessageSeven([4242, -1001234567890])

      expect(cache.markDeletedByMessageIds([7])).toEqual({
        deleted: 1,
        ambiguous: [],
      })
      expect(cache.get(4242, 7)?.is_deleted).toBe(1)
      expect(cache.get(-1001234567890, 7)?.is_deleted).toBe(0)
    })

    it("marks the basic group's message when a supergroup has the same ID", () => {
      cacheMessageSeven([-5151, -1009876543210])

      expect(cache.markDeletedByMessageIds([7])).toEqual({
        deleted: 1,
        ambiguous: [],
      })
      expect(cache.get(-5151, 7)?.is_deleted).toBe(1)
      expect(cache.get(-1009876543210, 7)?.is_deleted).toBe(0)
    })

    it('leaves an ID that only channels have', () => {
      cacheMessageSeven([-1001234567890, -1009876543210])

      expect(cache.markDeletedByMessageIds([7])).toEqual({
        deleted: 0,
        ambiguous: [],
      })
      expect(cache.get(-1001234567890, 7)?.is_deleted).toBe(0)
      expect(cache.get(-1009876543210, 7)?.is_deleted).toBe(0)
    })

    it('keeps and reports an ID that a private chat and a basic group both have', () => {
      cacheMessageSeven([4242, -5151])

      expect(cache.markDeletedByMessageIds([7])).toEqual({
        deleted: 0,
        ambiguous: [{ messageId: 7, chatIds: [-5151, 4242] }],
      })
      expect(cache.get(4242, 7)?.is_deleted).toBe(0)
      expect(cache.get(-5151, 7)?.is_deleted).toBe(0)
    })

    it('counts a repeated ID in one update once', () => {
      cacheMessageSeven([4242])

      expect(cache.markDeletedByMessageIds([7, 7])).toEqual({
        deleted: 1,
        ambiguous: [],
      })
      expect(cache.get(4242, 7)?.is_deleted).toBe(1)
    })
  })

  describe('updateText', () => {
    it('updates message text, sets is_edited flag, and stores edit_date', () => {
      const originalDate = Date.now()
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Original text',
        message_type: 'text',
        date: originalDate,
        raw_json: '{}',
      })

      const editDate = originalDate + 60000 // 1 minute later
      cache.updateText(100, 1, 'Edited text', editDate)

      const msg = cache.get(100, 1)
      expect(msg?.text).toBe('Edited text')
      expect(msg?.is_edited).toBe(1)
      expect(msg?.edit_date).toBe(editDate)
    })

    it('stores edit_date on subsequent edits', () => {
      const originalDate = Date.now()
      cache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Original text',
        message_type: 'text',
        date: originalDate,
        raw_json: '{}',
      })

      const firstEditDate = originalDate + 60000
      cache.updateText(100, 1, 'First edit', firstEditDate)

      const secondEditDate = originalDate + 120000
      cache.updateText(100, 1, 'Second edit', secondEditDate)

      const msg = cache.get(100, 1)
      expect(msg?.text).toBe('Second edit')
      expect(msg?.is_edited).toBe(1)
      expect(msg?.edit_date).toBe(secondEditDate)
    })
  })

  describe('getLatestMessageId', () => {
    it('returns null for chat with no messages', () => {
      expect(cache.getLatestMessageId(100)).toBeNull()
    })

    it('returns the highest message_id for a chat', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 5,
        text: 'A',
        message_type: 'text',
        date: 1000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 10,
        text: 'B',
        message_type: 'text',
        date: 2000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 3,
        text: 'C',
        message_type: 'text',
        date: 500,
        raw_json: '{}',
      })

      expect(cache.getLatestMessageId(100)).toBe(10)
    })
  })

  describe('getOldestMessageId', () => {
    it('returns null for chat with no messages', () => {
      expect(cache.getOldestMessageId(100)).toBeNull()
    })

    it('returns the lowest message_id for a chat', () => {
      cache.upsert({
        chat_id: 100,
        message_id: 5,
        text: 'A',
        message_type: 'text',
        date: 1000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 10,
        text: 'B',
        message_type: 'text',
        date: 2000,
        raw_json: '{}',
      })
      cache.upsert({
        chat_id: 100,
        message_id: 3,
        text: 'C',
        message_type: 'text',
        date: 500,
        raw_json: '{}',
      })

      expect(cache.getOldestMessageId(100)).toBe(3)
    })
  })

  describe('countByChatId', () => {
    it('returns 0 for chat with no messages', () => {
      expect(cache.countByChatId(100)).toBe(0)
    })

    it('counts messages in a chat', () => {
      for (let i = 1; i <= 5; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Msg ${i}`,
          message_type: 'text',
          date: Date.now(),
          raw_json: '{}',
        })
      }

      expect(cache.countByChatId(100)).toBe(5)
    })

    it('excludes deleted messages from count by default', () => {
      for (let i = 1; i <= 5; i++) {
        cache.upsert({
          chat_id: 100,
          message_id: i,
          text: `Msg ${i}`,
          message_type: 'text',
          date: Date.now(),
          raw_json: '{}',
        })
      }
      cache.markDeleted(100, [2, 4])

      expect(cache.countByChatId(100)).toBe(3)
    })
  })

  describe('upsertBatch', () => {
    it('inserts multiple messages in a transaction', () => {
      const messages: MessageInput[] = [
        {
          chat_id: 100,
          message_id: 1,
          text: 'One',
          message_type: 'text',
          date: 1000,
          raw_json: '{}',
        },
        {
          chat_id: 100,
          message_id: 2,
          text: 'Two',
          message_type: 'text',
          date: 2000,
          raw_json: '{}',
        },
        {
          chat_id: 100,
          message_id: 3,
          text: 'Three',
          message_type: 'text',
          date: 3000,
          raw_json: '{}',
        },
      ]

      cache.upsertBatch(messages)

      expect(cache.countByChatId(100)).toBe(3)
      expect(cache.get(100, 2)?.text).toBe('Two')
    })
  })
})
