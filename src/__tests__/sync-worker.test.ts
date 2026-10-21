/**
 * Tests for sync worker
 *
 * Tests for the background sync worker including:
 * - ForwardCatchup job processing
 * - BackwardHistory job processing
 * - InitialLoad job processing
 * - Rate limiting checks before API calls
 * - FLOOD_WAIT error handling
 * - Cursor updates after batch
 * - Message caching
 * - Empty result handling (no more messages)
 * - Error handling and job failure
 */
import type { Database } from 'bun:sqlite'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import {
  createSyncWorker,
  type FetchMessagesResult,
  FloodWaitError,
  type SyncTelegramClient,
  type SyncWorker,
  type TelegramMessage,
  telegramMessageToInput,
} from '../daemon/sync-worker'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import { createChatSyncStateService } from '../db/chat-sync-state'
import type { MessagesCache } from '../db/messages-cache'
import { createMessagesCache } from '../db/messages-cache'
import type { RateLimitsService } from '../db/rate-limits'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import type { SyncJobsService } from '../db/sync-jobs'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'

describe('SyncWorker', () => {
  let db: Database
  let worker: SyncWorker
  let mockClient: SyncTelegramClient
  let messagesCache: MessagesCache
  let chatSyncState: ChatSyncStateService
  let jobsService: SyncJobsService
  let rateLimits: RateLimitsService
  let originalDateNow: typeof Date.now

  // Mock client implementation
  let mockGetMessages: ReturnType<
    typeof mock<
      (
        chatId: number,
        options: { limit: number; offsetId?: number; addOffset?: number },
      ) => Promise<FetchMessagesResult>
    >
  >

  beforeEach(() => {
    // Set up database
    const testDb = createTestCacheDatabase()
    db = testDb.db
    initSyncSchema(db)

    // Create services
    messagesCache = createMessagesCache(db)
    chatSyncState = createChatSyncStateService(db)
    jobsService = createSyncJobsService(db)
    rateLimits = createRateLimitsService(db)

    // Create mock client
    mockGetMessages = mock(
      async (
        _chatId: number,
        _options: { limit: number; offsetId?: number; addOffset?: number },
      ): Promise<FetchMessagesResult> => ({
        messages: [],
        noMoreMessages: false,
      }),
    )

    mockClient = {
      getMessages: mockGetMessages,
    }

    // Create worker
    worker = createSyncWorker({
      client: mockClient,
      messagesCache,
      chatSyncState,
      jobsService,
      rateLimits,
      config: {
        batchSize: 100,
        apiMethod: 'messages.getHistory',
      },
    })

    // Store original Date.now
    originalDateNow = Date.now
  })

  afterEach(() => {
    // Restore Date.now
    Date.now = originalDateNow
    db.close()
  })

  /**
   * Helper to create a test message
   */
  function createTestMessage(
    id: number,
    text: string,
    date?: number,
  ): TelegramMessage {
    return {
      id,
      message: text,
      date: date ?? Math.floor(Date.now() / 1000),
      fromId: { userId: 123 },
      out: false,
    }
  }

  /**
   * Helper to set up a chat sync state
   */
  function setupChatState(
    chatId: number,
    options: {
      forwardCursor?: number
      backwardCursor?: number
      historyComplete?: boolean
    } = {},
  ): void {
    chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: options.forwardCursor,
      backward_cursor: options.backwardCursor,
    })

    if (options.historyComplete) {
      chatSyncState.markHistoryComplete(chatId)
    }
  }

  /**
   * Helper to mock Date.now to a specific timestamp
   */
  function mockTime(timestampMs: number): void {
    Date.now = () => timestampMs
  }

  // ===========================================================================
  // telegramMessageToInput
  // ===========================================================================

  describe('telegramMessageToInput', () => {
    it('converts a basic text message', () => {
      const msg: TelegramMessage = {
        id: 1,
        message: 'Hello world',
        date: 1700000000,
        fromId: { userId: 123 },
        out: false,
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.chat_id).toBe(100)
      expect(input.message_id).toBe(1)
      expect(input.text).toBe('Hello world')
      expect(input.from_id).toBe(123)
      expect(input.date).toBe(1700000000)
      expect(input.message_type).toBe('text')
      expect(input.has_media).toBe(false)
      expect(input.is_outgoing).toBe(false)
    })

    it('handles outgoing messages', () => {
      const msg: TelegramMessage = {
        id: 1,
        message: 'Sent message',
        date: 1700000000,
        out: true,
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.is_outgoing).toBe(true)
    })

    it('handles messages with media', () => {
      const msg: TelegramMessage = {
        id: 1,
        message: 'Photo caption',
        date: 1700000000,
        media: { photo: {} },
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.message_type).toBe('media')
      expect(input.has_media).toBe(true)
    })

    it('handles reply messages', () => {
      const msg: TelegramMessage = {
        id: 2,
        message: 'Reply',
        date: 1700000000,
        replyTo: { replyToMsgId: 1 },
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.reply_to_id).toBe(1)
    })

    it('handles forwarded messages', () => {
      const msg: TelegramMessage = {
        id: 3,
        message: 'Forwarded',
        date: 1700000000,
        fwdFrom: { fromId: { userId: 456 } },
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.forward_from_id).toBe(456)
    })

    it('handles edited messages', () => {
      const msg: TelegramMessage = {
        id: 4,
        message: 'Edited text',
        date: 1700000000,
        editDate: 1700001000,
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.is_edited).toBe(true)
      expect(input.edit_date).toBe(1700001000)
    })

    it('handles pinned messages', () => {
      const msg: TelegramMessage = {
        id: 5,
        message: 'Pinned',
        date: 1700000000,
        pinned: true,
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.is_pinned).toBe(true)
    })

    it('handles messages with null values', () => {
      const msg: TelegramMessage = {
        id: 6,
        date: 1700000000,
        // No message text, no from_id, etc.
      }

      const input = telegramMessageToInput(100, msg)

      expect(input.text).toBeNull()
      expect(input.from_id).toBeNull()
      expect(input.reply_to_id).toBeNull()
      expect(input.forward_from_id).toBeNull()
    })

    it('stores raw_json correctly', () => {
      const msg: TelegramMessage = {
        id: 7,
        message: 'Test',
        date: 1700000000,
      }

      const input = telegramMessageToInput(100, msg)

      expect(JSON.parse(input.raw_json)).toEqual(msg)
    })
  })

  // ===========================================================================
  // ForwardCatchup job processing
  // ===========================================================================

  describe('processForwardCatchup', () => {
    it('fetches messages newer than forward cursor', async () => {
      setupChatState(100, { forwardCursor: 50 })

      const newMessages = [
        createTestMessage(52, 'New message 1'),
        createTestMessage(51, 'New message 2'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages: newMessages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processForwardCatchup(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(2)

      // Verify messages were cached
      expect(messagesCache.get(100, 51)).not.toBeNull()
      expect(messagesCache.get(100, 52)).not.toBeNull()

      // Verify cursor was updated to newest message
      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(52)
    })

    it('handles no new messages', async () => {
      setupChatState(100, { forwardCursor: 50 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processForwardCatchup(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)
    })

    it('updates synced messages count', async () => {
      setupChatState(100, { forwardCursor: 50 })

      const newMessages = [
        createTestMessage(53, 'Message 1'),
        createTestMessage(52, 'Message 2'),
        createTestMessage(51, 'Message 3'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages: newMessages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job)

      const state = chatSyncState.get(100)
      expect(state?.synced_messages).toBe(3)
    })

    it('updates last forward sync timestamp', async () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      setupChatState(100, { forwardCursor: 50 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [createTestMessage(51, 'Test')],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job)

      const state = chatSyncState.get(100)
      expect(state?.last_forward_sync).toBe(baseTime)
    })

    it('calls getMessages with correct parameters', async () => {
      setupChatState(100, { forwardCursor: 50 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job)

      expect(mockGetMessages).toHaveBeenCalledWith(100, {
        limit: 100,
        offsetId: 50,
        addOffset: -100,
      })
    })
  })

  // ===========================================================================
  // BackwardHistory job processing
  // ===========================================================================

  describe('processBackwardHistory', () => {
    it('fetches messages older than backward cursor', async () => {
      setupChatState(100, { backwardCursor: 50 })

      const oldMessages = [
        createTestMessage(49, 'Old message 1'),
        createTestMessage(48, 'Old message 2'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages: oldMessages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      const result = await worker.processBackwardHistory(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(2)

      // Verify messages were cached
      expect(messagesCache.get(100, 48)).not.toBeNull()
      expect(messagesCache.get(100, 49)).not.toBeNull()

      // Verify cursor was updated to oldest message
      const state = chatSyncState.get(100)
      expect(state?.backward_cursor).toBe(48)
    })

    it('marks history complete when no more messages', async () => {
      setupChatState(100, { backwardCursor: 10 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      const result = await worker.processBackwardHistory(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)

      const state = chatSyncState.get(100)
      expect(state?.history_complete).toBe(1)
    })

    it('skips processing if history is already complete', async () => {
      setupChatState(100, { backwardCursor: 50, historyComplete: true })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      const result = await worker.processBackwardHistory(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)

      // getMessages should not have been called
      expect(mockGetMessages).not.toHaveBeenCalled()
    })

    it('starts at the newest page when no backward cursor is set', async () => {
      setupChatState(100)

      // Cached messages, for example from tg messages list, mark no progress
      messagesCache.upsert({
        chat_id: 100,
        message_id: 100,
        message_type: 'text',
        date: 1700000000,
        raw_json: '{}',
      })
      messagesCache.upsert({
        chat_id: 100,
        message_id: 50, // This is the oldest
        message_type: 'text',
        date: 1699999000,
        raw_json: '{}',
      })

      mockGetMessages.mockImplementation(async () => ({
        messages: [createTestMessage(49, 'Older')],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await worker.processBackwardHistory(job)

      expect(mockGetMessages).toHaveBeenCalledWith(100, {
        limit: 100,
        offsetId: 0,
      })
    })

    it('updates last backward sync timestamp', async () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      setupChatState(100, { backwardCursor: 50 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [createTestMessage(49, 'Test')],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await worker.processBackwardHistory(job)

      const state = chatSyncState.get(100)
      expect(state?.last_backward_sync).toBe(baseTime)
    })
  })

  // ===========================================================================
  // InitialLoad job processing
  // ===========================================================================

  describe('processInitialLoad', () => {
    it('fetches most recent messages', async () => {
      setupChatState(100)

      const recentMessages = [
        createTestMessage(100, 'Newest'),
        createTestMessage(99, 'Second'),
        createTestMessage(98, 'Third'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages: recentMessages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      const result = await worker.processInitialLoad(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(3)

      // Verify all messages were cached
      expect(messagesCache.get(100, 98)).not.toBeNull()
      expect(messagesCache.get(100, 99)).not.toBeNull()
      expect(messagesCache.get(100, 100)).not.toBeNull()
    })

    it('sets both forward and backward cursors', async () => {
      setupChatState(100)

      const messages = [
        createTestMessage(100, 'Newest'),
        createTestMessage(95, 'Middle'),
        createTestMessage(90, 'Oldest'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(100) // Newest
      expect(state?.backward_cursor).toBe(90) // Oldest
    })

    it('marks history complete for empty chats', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      const result = await worker.processInitialLoad(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)

      const state = chatSyncState.get(100)
      expect(state?.history_complete).toBe(1)
    })

    it('marks history complete when fewer messages than batch size', async () => {
      setupChatState(100)

      // Return only 5 messages when batch size is 100
      const messages = [
        createTestMessage(5, 'Msg 5'),
        createTestMessage(4, 'Msg 4'),
        createTestMessage(3, 'Msg 3'),
        createTestMessage(2, 'Msg 2'),
        createTestMessage(1, 'Msg 1'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      const state = chatSyncState.get(100)
      expect(state?.history_complete).toBe(1)
    })

    it('calls getMessages without offset for initial load', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      expect(mockGetMessages).toHaveBeenCalledWith(100, {
        limit: 100,
      })
    })

    it('updates job progress with cursor range', async () => {
      setupChatState(100)

      const messages = [
        createTestMessage(100, 'Newest'),
        createTestMessage(90, 'Oldest'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.cursor_start).toBe(100)
      expect(updatedJob?.cursor_end).toBe(90)
      expect(updatedJob?.messages_fetched).toBe(2)
    })
  })

  // ===========================================================================
  // Rate limiting checks before API calls
  // ===========================================================================

  describe('rate limiting checks', () => {
    it('returns rate limited result when blocked', async () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      setupChatState(100)
      rateLimits.setFloodWait('messages.getHistory', 30)

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processForwardCatchup(job)

      expect(result.success).toBe(false)
      expect(result.rateLimited).toBe(true)
      expect(result.waitSeconds).toBeGreaterThan(0)

      // getMessages should not have been called
      expect(mockGetMessages).not.toHaveBeenCalled()
    })

    it('canMakeApiCall returns false when rate limited', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      rateLimits.setFloodWait('messages.getHistory', 30)

      expect(worker.canMakeApiCall()).toBe(false)
    })

    it('canMakeApiCall returns true when not rate limited', () => {
      expect(worker.canMakeApiCall()).toBe(true)
    })

    it('getWaitTime returns remaining seconds when blocked', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      rateLimits.setFloodWait('messages.getHistory', 60)

      // Move forward 20 seconds
      mockTime(baseTime + 20000)

      expect(worker.getWaitTime()).toBe(40)
    })

    it('records API call before making request', async () => {
      setupChatState(100)

      const recordCallSpy = spyOn(rateLimits, 'recordCall')

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job)

      expect(recordCallSpy).toHaveBeenCalledWith('messages.getHistory')
    })

    it('all job types check rate limits', async () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      setupChatState(100)
      rateLimits.setFloodWait('messages.getHistory', 30)

      // Test ForwardCatchup
      const forwardJob = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })
      const forwardResult = await worker.processForwardCatchup(forwardJob)
      expect(forwardResult.rateLimited).toBe(true)

      // Test BackwardHistory
      const backwardJob = jobsService.create({
        chat_id: 101,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      setupChatState(101)
      const backwardResult = await worker.processBackwardHistory(backwardJob)
      expect(backwardResult.rateLimited).toBe(true)

      // Test InitialLoad
      const initialJob = jobsService.create({
        chat_id: 102,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })
      setupChatState(102)
      const initialResult = await worker.processInitialLoad(initialJob)
      expect(initialResult.rateLimited).toBe(true)

      // No API calls should have been made
      expect(mockGetMessages).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // FLOOD_WAIT error handling
  // ===========================================================================

  describe('FLOOD_WAIT error handling', () => {
    it('handles FloodWaitError and records flood wait', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => {
        throw new FloodWaitError(45, 'messages.getHistory')
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processForwardCatchup(job)

      expect(result.success).toBe(false)
      expect(result.rateLimited).toBe(true)
      expect(result.waitSeconds).toBe(45)

      // Verify flood wait was recorded
      expect(rateLimits.isBlocked('messages.getHistory')).toBe(true)
    })

    it('FloodWaitError is properly constructed', () => {
      const error = new FloodWaitError(30, 'messages.getHistory')

      expect(error.seconds).toBe(30)
      expect(error.method).toBe('messages.getHistory')
      expect(error.message).toBe('FLOOD_WAIT_30')
      expect(error.name).toBe('FloodWaitError')
    })

    it('FLOOD_WAIT fails the job with appropriate message', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => {
        throw new FloodWaitError(120, 'messages.getHistory')
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processJob(job)

      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.status).toBe(SyncJobStatus.Failed)
      expect(updatedJob?.error_message).toContain('Rate limited')
      expect(updatedJob?.error_message).toContain('120')
    })

    it('subsequent requests are blocked after FLOOD_WAIT', async () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      setupChatState(100)
      setupChatState(101)

      // First request gets FLOOD_WAIT
      mockGetMessages.mockImplementationOnce(async () => {
        throw new FloodWaitError(30, 'messages.getHistory')
      })

      const job1 = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job1)

      // Second request should be blocked without calling API
      const job2 = jobsService.create({
        chat_id: 101,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result2 = await worker.processForwardCatchup(job2)

      expect(result2.rateLimited).toBe(true)
      // mockGetMessages should have been called only once
      expect(mockGetMessages).toHaveBeenCalledTimes(1)
    })
  })

  // ===========================================================================
  // Cursor updates after batch
  // ===========================================================================

  describe('cursor updates after batch', () => {
    it('forward catchup updates forward cursor to newest message', async () => {
      setupChatState(100, { forwardCursor: 50 })

      const messages = [
        createTestMessage(55, 'Msg 55'),
        createTestMessage(53, 'Msg 53'),
        createTestMessage(51, 'Msg 51'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job)

      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(55)
    })

    it('backward history updates backward cursor to oldest message', async () => {
      setupChatState(100, { backwardCursor: 50 })

      const messages = [
        createTestMessage(49, 'Msg 49'),
        createTestMessage(47, 'Msg 47'),
        createTestMessage(45, 'Msg 45'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await worker.processBackwardHistory(job)

      const state = chatSyncState.get(100)
      expect(state?.backward_cursor).toBe(45)
    })

    it('initial load sets both cursors correctly', async () => {
      setupChatState(100)

      const messages = [
        createTestMessage(200, 'Newest'),
        createTestMessage(150, 'Middle'),
        createTestMessage(100, 'Oldest'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(200)
      expect(state?.backward_cursor).toBe(100)
    })

    it('job progress is updated with cursor positions', async () => {
      setupChatState(100, { forwardCursor: 50 })

      const messages = [
        createTestMessage(55, 'Msg'),
        createTestMessage(52, 'Msg'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processForwardCatchup(job)

      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.cursor_end).toBe(55)
      expect(updatedJob?.messages_fetched).toBe(2)
    })
  })

  // ===========================================================================
  // Message caching
  // ===========================================================================

  describe('message caching', () => {
    it('caches all fetched messages', async () => {
      setupChatState(100)

      const messages = [
        createTestMessage(5, 'Message 5'),
        createTestMessage(4, 'Message 4'),
        createTestMessage(3, 'Message 3'),
        createTestMessage(2, 'Message 2'),
        createTestMessage(1, 'Message 1'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      // Verify all messages were cached
      for (const msg of messages) {
        const cached = messagesCache.get(100, msg.id)
        expect(cached).not.toBeNull()
        expect(cached?.text).toBe(msg.message)
      }
    })

    it('uses batch insert for efficiency', async () => {
      setupChatState(100)

      const upsertBatchSpy = spyOn(messagesCache, 'upsertBatch')

      const messages = [
        createTestMessage(3, 'Msg 3'),
        createTestMessage(2, 'Msg 2'),
        createTestMessage(1, 'Msg 1'),
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      expect(upsertBatchSpy).toHaveBeenCalledTimes(1)
      expect(upsertBatchSpy.mock.calls[0]?.[0]).toHaveLength(3)
    })

    it('preserves message metadata in cache', async () => {
      setupChatState(100)

      const messages: TelegramMessage[] = [
        {
          id: 1,
          message: 'Test message',
          date: 1700000000,
          fromId: { userId: 123 },
          replyTo: { replyToMsgId: 5 },
          out: true,
          pinned: true,
          editDate: 1700001000,
        },
      ]

      mockGetMessages.mockImplementation(async () => ({
        messages,
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      const cached = messagesCache.get(100, 1)
      expect(cached).not.toBeNull()
      expect(cached?.from_id).toBe(123)
      expect(cached?.reply_to_id).toBe(5)
      expect(cached?.is_outgoing).toBe(1)
      expect(cached?.is_pinned).toBe(1)
      expect(cached?.is_edited).toBe(1)
      expect(cached?.edit_date).toBe(1700001000)
    })

    it('increments synced messages count correctly', async () => {
      setupChatState(100)

      // First batch
      mockGetMessages.mockImplementationOnce(async () => ({
        messages: [createTestMessage(3, 'Msg'), createTestMessage(2, 'Msg')],
        noMoreMessages: false,
      }))

      const job1 = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job1)

      let state = chatSyncState.get(100)
      expect(state?.synced_messages).toBe(2)

      // Second batch - backward history
      mockGetMessages.mockImplementationOnce(async () => ({
        messages: [createTestMessage(1, 'Msg')],
        noMoreMessages: true,
      }))

      const job2 = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      // Reset history_complete for testing
      db.run(
        `UPDATE chat_sync_state SET history_complete = 0 WHERE chat_id = 100`,
      )

      await worker.processBackwardHistory(job2)

      state = chatSyncState.get(100)
      expect(state?.synced_messages).toBe(3)
    })
  })

  // ===========================================================================
  // Empty result handling (no more messages)
  // ===========================================================================

  describe('empty result handling', () => {
    it('handles empty message list in forward catchup', async () => {
      setupChatState(100, { forwardCursor: 50 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processForwardCatchup(job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)

      // Cursor should remain unchanged
      const state = chatSyncState.get(100)
      expect(state?.forward_cursor).toBe(50)
    })

    it('marks history complete when backward history returns empty', async () => {
      setupChatState(100, { backwardCursor: 10 })

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await worker.processBackwardHistory(job)

      const state = chatSyncState.get(100)
      expect(state?.history_complete).toBe(1)
    })

    it('marks history complete for empty chat in initial load', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processInitialLoad(job)

      const state = chatSyncState.get(100)
      expect(state?.history_complete).toBe(1)
    })

    it('noMoreMessages flag triggers history complete', async () => {
      setupChatState(100, { backwardCursor: 50 })

      // Return some messages but indicate no more exist
      mockGetMessages.mockImplementation(async () => ({
        messages: [createTestMessage(49, 'Last message')],
        noMoreMessages: true,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      await worker.processBackwardHistory(job)

      const state = chatSyncState.get(100)
      expect(state?.history_complete).toBe(1)
    })
  })

  // ===========================================================================
  // Error handling and job failure
  // ===========================================================================

  describe('error handling and job failure', () => {
    it('marks job as failed on generic error', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => {
        throw new Error('Network error')
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processJob(job)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')

      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.status).toBe(SyncJobStatus.Failed)
      expect(updatedJob?.error_message).toBe('Network error')
    })

    it('handles unknown errors gracefully', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => {
        throw 'string error'
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.processJob(job)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Unknown error')
    })

    it('marks job as running before processing', async () => {
      setupChatState(100)

      let jobStatusDuringCall: string | undefined

      mockGetMessages.mockImplementation(async () => {
        // Check job status during the API call
        const currentJob = jobsService.getById(1)
        jobStatusDuringCall = currentJob?.status
        return { messages: [], noMoreMessages: false }
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processJob(job)

      expect(jobStatusDuringCall).toBe(SyncJobStatus.Running)
    })

    it('marks job as completed on success', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => ({
        messages: [createTestMessage(1, 'Test')],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.processJob(job)

      const updatedJob = jobsService.getById(job.id)
      expect(updatedJob?.status).toBe(SyncJobStatus.Completed)
    })

    it('handles unknown job type', async () => {
      setupChatState(100)

      const job = jobsService.create({
        chat_id: 100,
        job_type: 'unknown_type' as SyncJobType,
        priority: SyncPriority.Medium,
      })

      const result = await worker.processJob(job)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Unknown job type')
    })

    it('does not cache partial results on error', async () => {
      setupChatState(100)

      // This test verifies that if we throw before caching, nothing is cached
      mockGetMessages.mockImplementation(async () => {
        throw new Error('API error')
      })

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await worker.processJob(job)

      // No messages should be in cache
      expect(messagesCache.countByChatId(100)).toBe(0)
    })
  })

  // ===========================================================================
  // runOnce method
  // ===========================================================================

  describe('runOnce', () => {
    it('processes next pending job', async () => {
      setupChatState(100)

      mockGetMessages.mockImplementation(async () => ({
        messages: [createTestMessage(1, 'Test')],
        noMoreMessages: false,
      }))

      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.runOnce()

      expect(result).not.toBeNull()
      expect(result?.success).toBe(true)
    })

    it('returns null when no pending jobs', async () => {
      const result = await worker.runOnce()

      expect(result).toBeNull()
    })

    it('returns rate limited when globally blocked', async () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      rateLimits.setFloodWait('messages.getHistory', 60)

      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const result = await worker.runOnce()

      expect(result).not.toBeNull()
      expect(result?.rateLimited).toBe(true)
      expect(result?.waitSeconds).toBeGreaterThan(0)
    })

    it('processes jobs in priority order', async () => {
      setupChatState(100)
      setupChatState(200)

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: false,
      }))

      // Create low priority job first
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      // Create high priority job second
      jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      await worker.runOnce()

      // High priority job should have been processed (chat_id 200)
      expect(mockGetMessages).toHaveBeenCalledWith(200, expect.anything())
    })
  })

  // ===========================================================================
  // Configuration
  // ===========================================================================

  describe('configuration', () => {
    it('uses custom batch size', async () => {
      const customWorker = createSyncWorker({
        client: mockClient,
        messagesCache,
        chatSyncState,
        jobsService,
        rateLimits,
        config: {
          batchSize: 50,
          apiMethod: 'messages.getHistory',
        },
      })

      setupChatState(100)

      mockGetMessages.mockImplementation(async () => ({
        messages: [],
        noMoreMessages: false,
      }))

      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      await customWorker.processInitialLoad(job)

      expect(mockGetMessages).toHaveBeenCalledWith(100, {
        limit: 50,
      })
    })

    it('uses custom API method for rate limiting', async () => {
      const customWorker = createSyncWorker({
        client: mockClient,
        messagesCache,
        chatSyncState,
        jobsService,
        rateLimits,
        config: {
          batchSize: 100,
          apiMethod: 'custom.method',
        },
      })

      const baseTime = 1700000000000
      mockTime(baseTime)

      rateLimits.setFloodWait('custom.method', 30)

      expect(customWorker.canMakeApiCall()).toBe(false)

      // Default method should still be unblocked
      expect(worker.canMakeApiCall()).toBe(true)
    })
  })
})
