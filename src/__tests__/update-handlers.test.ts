/**
 * Tests for update handlers
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  createUpdateHandlers,
  type UpdateContext,
  type UpdateHandlers,
} from '../daemon/handlers'
import type { DaemonLogger } from '../daemon/types'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema, SyncPriority } from '../db/sync-schema'

describe('UpdateHandlers', () => {
  let db: Database
  let handlers: UpdateHandlers
  let messagesCache: ReturnType<typeof createMessagesCache>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    messagesCache = createMessagesCache(db)
    chatSyncState = createChatSyncStateService(db)
    handlers = createUpdateHandlers({ db, messagesCache, chatSyncState })
  })

  describe('handleNewMessage', () => {
    it('stores a new message in cache', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 1,
        fromId: 123,
        text: 'Hello, world!',
        date: Date.now(),
        isOutgoing: false,
      })

      const cached = messagesCache.get(100, 1)
      expect(cached).not.toBeNull()
      expect(cached?.text).toBe('Hello, world!')
      expect(cached?.from_id).toBe(123)
    })

    it('stores raw_json when rawMessage is provided', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      const rawMessage = {
        _: 'message',
        id: 42,
        peerId: { _: 'peerUser', userId: 123 },
        message: 'Test with raw JSON',
        date: 1700000000,
        out: false,
        mentioned: false,
        mediaUnread: false,
        silent: false,
        post: false,
        fromScheduled: false,
        legacy: false,
        editHide: false,
        pinned: false,
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 42,
        fromId: 123,
        text: 'Test with raw JSON',
        date: 1700000000,
        isOutgoing: false,
        rawMessage,
      })

      const cached = messagesCache.get(100, 42)
      expect(cached).not.toBeNull()
      expect(cached?.raw_json).toBe(JSON.stringify(rawMessage))

      // Verify the raw JSON can be parsed back
      const parsed = JSON.parse(cached!.raw_json)
      expect(parsed._).toBe('message')
      expect(parsed.id).toBe(42)
      expect(parsed.peerId.userId).toBe(123)
    })

    it('stores empty object when rawMessage is not provided', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 99,
        fromId: 123,
        text: 'No raw message',
        date: Date.now(),
        isOutgoing: false,
      })

      const cached = messagesCache.get(100, 99)
      expect(cached).not.toBeNull()
      expect(cached?.raw_json).toBe('{}')
    })

    it('seeds sync state using provided chat type', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 200,
        chatType: 'channel',
        messageId: 1,
        fromId: 123,
        text: 'Channel post',
        date: Date.now(),
        isOutgoing: false,
      })

      const state = chatSyncState.get(200)
      expect(state?.chat_type).toBe('channel')
      expect(state?.sync_enabled).toBe(0)
    })

    it('gives a small basic group first seen live its tier', async () => {
      await handlers.handleNewMessage(
        { accountId: 1, receivedAt: Date.now() },
        {
          chatId: -4001,
          chatType: 'group',
          memberCount: 10,
          messageId: 1,
          text: 'Hi all',
          date: 1_700_000_000,
          isOutgoing: false,
        },
      )

      const state = chatSyncState.get(-4001)
      expect(state?.member_count).toBe(10)
      expect(state?.sync_priority).toBe(SyncPriority.High)
      expect(state?.sync_enabled).toBe(1)
    })

    it('leaves a supergroup without a member count off', async () => {
      await handlers.handleNewMessage(
        { accountId: 1, receivedAt: Date.now() },
        {
          chatId: -1001234567890,
          chatType: 'supergroup',
          messageId: 1,
          text: 'Hi all',
          date: 1_700_000_000,
          isOutgoing: false,
        },
      )

      const state = chatSyncState.get(-1001234567890)
      expect(state?.member_count).toBeNull()
      expect(state?.sync_priority).toBe(SyncPriority.Low)
      expect(state?.sync_enabled).toBe(0)
    })

    it('stores forward_from_id when provided', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 300,
        messageId: 7,
        fromId: 123,
        forwardFromId: 456,
        text: 'Forwarded message',
        date: Date.now(),
        isOutgoing: false,
      })

      const cached = messagesCache.get(300, 7)
      expect(cached?.forward_from_id).toBe(456)
    })

    it('leaves the forward cursor to catch-up for newer messages', async () => {
      // Messages 6-9 may have arrived while the daemon was stopped, so a
      // live message 10 must not mark them as cached.
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: 1,
        sync_enabled: true,
        forward_cursor: 5,
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 10,
        fromId: 123,
        text: 'New message',
        date: Date.now(),
        isOutgoing: false,
      })

      expect(messagesCache.get(100, 10)).not.toBeNull()
      expect(chatSyncState.get(100)?.forward_cursor).toBe(5)
    })

    it('does not set a forward cursor for a new chat', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 102,
        messageId: 10,
        fromId: 123,
        text: 'First live message',
        date: Date.now(),
        isOutgoing: false,
      })

      expect(chatSyncState.get(102)?.forward_cursor).toBeNull()
    })

    it('does not regress forward cursor for older messages', async () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: 1,
        sync_enabled: true,
        forward_cursor: 10,
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 5,
        fromId: 123,
        text: 'Old message',
        date: Date.now(),
        isOutgoing: false,
      })

      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(10)
    })

    it('updates last forward sync timestamp', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 101,
        messageId: 1,
        fromId: 123,
        text: 'Track sync',
        date: Date.now(),
        isOutgoing: false,
      })

      const state = chatSyncState.get(101)
      expect(state?.last_forward_sync).not.toBeNull()
    })

    it('increments synced messages count', async () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: 1,
        sync_enabled: true,
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 1,
        fromId: 123,
        text: 'Message 1',
        date: Date.now(),
        isOutgoing: false,
      })

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 2,
        fromId: 123,
        text: 'Message 2',
        date: Date.now(),
        isOutgoing: false,
      })

      const state = chatSyncState.get(100)
      expect(state?.synced_messages).toBe(2)
    })
  })

  describe('handleEditMessage', () => {
    it('updates message text', async () => {
      // Insert original message
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Original text',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleEditMessage(ctx, {
        chatId: 100,
        messageId: 1,
        newText: 'Edited text',
        editDate: Date.now(),
      })

      const cached = messagesCache.get(100, 1)
      expect(cached?.text).toBe('Edited text')
      expect(cached?.is_edited).toBe(1)
    })
  })

  describe('handleDeleteMessages', () => {
    it('marks messages as deleted', async () => {
      // Insert messages
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'Message 1',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      messagesCache.upsert({
        chat_id: 100,
        message_id: 2,
        text: 'Message 2',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleDeleteMessages(ctx, {
        chatId: 100,
        messageIds: [1, 2],
      })

      expect(messagesCache.get(100, 1)?.is_deleted).toBe(1)
      expect(messagesCache.get(100, 2)?.is_deleted).toBe(1)
    })
  })

  describe('handleDeleteMessagesWithoutChat', () => {
    it('marks messages as deleted when chat ID is unknown', async () => {
      // Insert messages in different chats (simulating DMs and groups)
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1,
        text: 'DM message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })
      messagesCache.upsert({
        chat_id: 200,
        message_id: 2,
        text: 'Group message',
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Delete messages without providing chat IDs (as mtcute does for non-channel chats)
      const deletedCount = await handlers.handleDeleteMessagesWithoutChat(ctx, {
        messageIds: [1, 2],
      })

      expect(deletedCount).toBe(2)
      expect(messagesCache.get(100, 1)?.is_deleted).toBe(1)
      expect(messagesCache.get(200, 2)?.is_deleted).toBe(1)
    })

    it('returns 0 when messages are not in cache', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Try to delete messages that don't exist in cache
      const deletedCount = await handlers.handleDeleteMessagesWithoutChat(ctx, {
        messageIds: [999, 1000],
      })

      expect(deletedCount).toBe(0)
    })

    it('handles empty message IDs array', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      const deletedCount = await handlers.handleDeleteMessagesWithoutChat(ctx, {
        messageIds: [],
      })

      expect(deletedCount).toBe(0)
    })
  })

  describe('handleBatchMessages', () => {
    it('processes multiple messages efficiently', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      const messages = Array.from({ length: 50 }, (_, i) => ({
        chatId: 100,
        messageId: i + 1,
        fromId: 123,
        text: `Message ${i + 1}`,
        date: Date.now() + i * 1000,
        isOutgoing: false,
      }))

      await handlers.handleBatchMessages(ctx, messages)

      expect(messagesCache.countByChatId(100)).toBe(50)
      expect(messagesCache.get(100, 1)?.text).toBe('Message 1')
      expect(messagesCache.get(100, 50)?.text).toBe('Message 50')
    })

    it('stores raw_json for batch messages', async () => {
      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      const messages = [
        {
          chatId: 200,
          messageId: 1,
          fromId: 123,
          text: 'Batch message 1',
          date: Date.now(),
          isOutgoing: false,
          rawMessage: { _: 'message', id: 1, data: 'first' },
        },
        {
          chatId: 200,
          messageId: 2,
          fromId: 123,
          text: 'Batch message 2',
          date: Date.now() + 1000,
          isOutgoing: false,
          rawMessage: { _: 'message', id: 2, data: 'second' },
        },
        {
          chatId: 200,
          messageId: 3,
          fromId: 123,
          text: 'Batch message 3 - no raw',
          date: Date.now() + 2000,
          isOutgoing: false,
          // No rawMessage - should default to '{}'
        },
      ]

      await handlers.handleBatchMessages(ctx, messages)

      const msg1 = messagesCache.get(200, 1)
      const msg2 = messagesCache.get(200, 2)
      const msg3 = messagesCache.get(200, 3)

      expect(msg1?.raw_json).toBe(
        JSON.stringify({ _: 'message', id: 1, data: 'first' }),
      )
      expect(msg2?.raw_json).toBe(
        JSON.stringify({ _: 'message', id: 2, data: 'second' }),
      )
      expect(msg3?.raw_json).toBe('{}')
    })

    it('updates forward and backward cursors based on batch range', async () => {
      chatSyncState.upsert({
        chat_id: 500,
        chat_type: 'private',
        sync_priority: 1,
        sync_enabled: true,
        forward_cursor: 10,
        backward_cursor: 5,
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleBatchMessages(ctx, [
        {
          chatId: 500,
          messageId: 12,
          fromId: 1,
          text: 'Newer',
          date: Date.now(),
          isOutgoing: false,
        },
        {
          chatId: 500,
          messageId: 3,
          fromId: 1,
          text: 'Older',
          date: Date.now(),
          isOutgoing: false,
        },
      ])

      const state = chatSyncState.get(500)
      expect(state?.forward_cursor).toBe(12)
      expect(state?.backward_cursor).toBe(3)
    })
  })
})

describe('UpdateHandlers error handling', () => {
  let db: Database
  let messagesCache: ReturnType<typeof createMessagesCache>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>
  let mockLogger: DaemonLogger
  let errorLogs: string[]

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    messagesCache = createMessagesCache(db)
    chatSyncState = createChatSyncStateService(db)
    errorLogs = []
    mockLogger = {
      info: mock(() => {}),
      debug: mock(() => {}),
      warn: mock(() => {}),
      error: mock((msg: string) => {
        errorLogs.push(msg)
      }),
    }
  })

  describe('handleNewMessage', () => {
    it('logs error and continues when database operation fails', async () => {
      // Create handlers with mock logger
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      // Spy on messagesCache.upsert to throw an error
      const upsertSpy = spyOn(messagesCache, 'upsert').mockImplementation(
        () => {
          throw new Error('Database write failed')
        },
      )

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Should NOT throw
      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 1,
        fromId: 123,
        text: 'Hello',
        date: Date.now(),
        isOutgoing: false,
      })

      // Should have logged the error
      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('Failed to handle new message')
      expect(errorLogs[0]).toContain('chatId=100')
      expect(errorLogs[0]).toContain('messageId=1')
      expect(errorLogs[0]).toContain('Database write failed')

      upsertSpy.mockRestore()
    })
  })

  describe('handleEditMessage', () => {
    it('logs error and continues when database operation fails', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      const updateTextSpy = spyOn(
        messagesCache,
        'updateText',
      ).mockImplementation(() => {
        throw new Error('Update failed')
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Should NOT throw
      await handlers.handleEditMessage(ctx, {
        chatId: 200,
        messageId: 5,
        newText: 'Edited',
        editDate: Date.now(),
      })

      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('Failed to handle edit message')
      expect(errorLogs[0]).toContain('chatId=200')
      expect(errorLogs[0]).toContain('messageId=5')
      expect(errorLogs[0]).toContain('Update failed')

      updateTextSpy.mockRestore()
    })
  })

  describe('handleDeleteMessages', () => {
    it('logs error and continues when database operation fails', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      const markDeletedSpy = spyOn(
        messagesCache,
        'markDeleted',
      ).mockImplementation(() => {
        throw new Error('Delete failed')
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Should NOT throw
      await handlers.handleDeleteMessages(ctx, {
        chatId: 300,
        messageIds: [10, 11, 12],
      })

      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('Failed to handle delete messages')
      expect(errorLogs[0]).toContain('chatId=300')
      expect(errorLogs[0]).toContain('messageIds=[10,11,12]')
      expect(errorLogs[0]).toContain('Delete failed')

      markDeletedSpy.mockRestore()
    })
  })

  describe('handleBatchMessages', () => {
    it('logs error for failed chat but continues processing other chats', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      // Track which chats were processed
      const processedChats: number[] = []
      const originalUpsertBatch = messagesCache.upsertBatch.bind(messagesCache)

      // Make upsertBatch fail only for chat 200
      const upsertBatchSpy = spyOn(
        messagesCache,
        'upsertBatch',
      ).mockImplementation((inputs) => {
        const chatId = inputs[0]?.chat_id ?? 0
        processedChats.push(chatId)
        if (chatId === 200) {
          throw new Error('Batch insert failed for chat 200')
        }
        return originalUpsertBatch(inputs)
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Messages for two different chats
      const messages = [
        {
          chatId: 100,
          messageId: 1,
          fromId: 123,
          text: 'Chat 100 msg',
          date: Date.now(),
          isOutgoing: false,
        },
        {
          chatId: 200,
          messageId: 1,
          fromId: 456,
          text: 'Chat 200 msg',
          date: Date.now(),
          isOutgoing: false,
        },
        {
          chatId: 300,
          messageId: 1,
          fromId: 789,
          text: 'Chat 300 msg',
          date: Date.now(),
          isOutgoing: false,
        },
      ]

      // Should NOT throw
      await handlers.handleBatchMessages(ctx, messages)

      // All 3 chats should have been attempted
      expect(processedChats.length).toBe(3)

      // Should have logged an error for chat 200
      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('chatId=200')
      expect(errorLogs[0]).toContain('Batch insert failed for chat 200')

      // Chat 100 should have been successfully stored
      expect(messagesCache.get(100, 1)?.text).toBe('Chat 100 msg')

      // Chat 300 should have been successfully stored
      expect(messagesCache.get(300, 1)?.text).toBe('Chat 300 msg')

      upsertBatchSpy.mockRestore()
    })

    it('logs error with context including messageIds', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      const upsertBatchSpy = spyOn(
        messagesCache,
        'upsertBatch',
      ).mockImplementation(() => {
        throw new Error('Batch failed')
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      const messages = [
        {
          chatId: 500,
          messageId: 1,
          fromId: 123,
          text: 'Msg 1',
          date: Date.now(),
          isOutgoing: false,
        },
        {
          chatId: 500,
          messageId: 2,
          fromId: 123,
          text: 'Msg 2',
          date: Date.now(),
          isOutgoing: false,
        },
        {
          chatId: 500,
          messageId: 3,
          fromId: 123,
          text: 'Msg 3',
          date: Date.now(),
          isOutgoing: false,
        },
      ]

      await handlers.handleBatchMessages(ctx, messages)

      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('Failed to handle batch messages')
      expect(errorLogs[0]).toContain('chatId=500')
      expect(errorLogs[0]).toContain('messageCount=3')
      expect(errorLogs[0]).toContain('Batch failed')

      upsertBatchSpy.mockRestore()
    })

    it('truncates long messageId lists in error log', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      const upsertBatchSpy = spyOn(
        messagesCache,
        'upsertBatch',
      ).mockImplementation(() => {
        throw new Error('Batch failed')
      })

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      // Create 10 messages - should only log first 5 IDs
      const messages = Array.from({ length: 10 }, (_, i) => ({
        chatId: 600,
        messageId: i + 1,
        fromId: 123,
        text: `Msg ${i + 1}`,
        date: Date.now(),
        isOutgoing: false,
      }))

      await handlers.handleBatchMessages(ctx, messages)

      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('messageIds=[1,2,3,4,5...')
      expect(errorLogs[0]).not.toContain('messageIds=[1,2,3,4,5,6')

      upsertBatchSpy.mockRestore()
    })
  })

  describe('handleDeleteMessages', () => {
    it('logs error and continues when delete fails', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      const deleteSpy = spyOn(messagesCache, 'markDeleted').mockImplementation(
        () => {
          throw new Error('Delete failed')
        },
      )

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleDeleteMessages(ctx, {
        chatId: 300,
        messageIds: [1, 2],
      })

      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('Failed to handle delete messages')
      expect(errorLogs[0]).toContain('chatId=300')
      deleteSpy.mockRestore()
    })
  })

  describe('handleBatchMessages', () => {
    it('logs per-chat errors and continues processing other chats', async () => {
      const handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger: mockLogger,
      })

      const originalUpsert = messagesCache.upsertBatch.bind(messagesCache)
      const upsertSpy = spyOn(messagesCache, 'upsertBatch').mockImplementation(
        (inputs) => {
          if (inputs[0]?.chat_id === 900) {
            throw new Error('Batch failed')
          }
          return originalUpsert(inputs)
        },
      )

      const ctx: UpdateContext = {
        accountId: 1,
        receivedAt: Date.now(),
      }

      await handlers.handleBatchMessages(ctx, [
        {
          chatId: 900,
          messageId: 1,
          fromId: 1,
          text: 'bad',
          date: Date.now(),
          isOutgoing: false,
        },
        {
          chatId: 901,
          messageId: 2,
          fromId: 1,
          text: 'ok',
          date: Date.now(),
          isOutgoing: false,
        },
      ])

      expect(errorLogs.length).toBe(1)
      expect(errorLogs[0]).toContain('chatId=900')
      expect(messagesCache.get(901, 2)).not.toBeNull()
      upsertSpy.mockRestore()
    })
  })
})
