/**
 * Tests for sync worker real job handlers
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import {
  processBackwardHistoryReal,
  processForwardCatchupReal,
  processInitialLoadReal,
  processJobReal,
} from '../daemon/sync-worker-real-jobs'
import type { RealSyncWorkerContext } from '../daemon/sync-worker-real-types'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'
import { createFakeHistory, range, rawMessage } from './helpers/fake-history'

describe('sync-worker real jobs', () => {
  let db: Database
  let ctx: RealSyncWorkerContext

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    initSyncSchema(db)

    ctx = {
      client: {
        call: mock(async () => ({ messages: [] })),
      } as unknown as TelegramClient,
      messagesCache: createMessagesCache(db),
      chatSyncState: createChatSyncStateService(db),
      jobsService: createSyncJobsService(db),
      rateLimits: createRateLimitsService(db),
      chatsCache: createChatsCache(db),
      config: {
        apiMethod: 'messages.getHistory',
        batchSize: 2,
      },
    }
  })

  afterEach(() => {
    db.close()
  })

  it('returns rate limited when API calls are blocked (forward catchup)', async () => {
    const job = ctx.jobsService.create({
      chat_id: 1,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })

    ctx.rateLimits.setFloodWait(ctx.config.apiMethod, 10)

    const result = await processForwardCatchupReal(ctx, job)

    expect(result.rateLimited).toBe(true)
    expect(result.waitSeconds).toBeGreaterThan(0)
  })

  it('returns error when input peer is missing (forward catchup)', async () => {
    const job = ctx.jobsService.create({
      chat_id: -123,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })

    const result = await processForwardCatchupReal(ctx, job)

    expect(result.success).toBe(false)
    expect(result.error).toContain('InputPeer')
  })

  it('processes forward catchup and updates cursors + progress', async () => {
    const chatId = 42
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 5,
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async (payload: Record<string, unknown>) => {
      expect(payload.minId).toBe(5)
      expect(payload.limit).toBe(2)
      return {
        messages: [
          { _: 'message', id: 6, date: 1700000000, message: 'one' },
          { _: 'message', id: 7, date: 1700000001, message: 'two' },
        ],
      }
    })

    ctx.client = { call: clientCall } as unknown as TelegramClient

    const result = await processForwardCatchupReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.messagesFetched).toBe(2)
    expect(result.hasMore).toBe(true)
    expect(result.newCursor).toBe(7)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.forward_cursor).toBe(7)
    expect(state?.synced_messages).toBe(2)

    const updatedJob = ctx.jobsService.getById(job.id)
    expect(updatedJob?.messages_fetched).toBe(2)
    expect(updatedJob?.cursor_end).toBe(7)

    expect(ctx.messagesCache.countByChatId(chatId)).toBe(2)
  })

  it('skips backward history when history is already complete', async () => {
    const chatId = 7
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    ctx.chatSyncState.markHistoryComplete(chatId)

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })

    const result = await processBackwardHistoryReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)
    expect(result.messagesFetched).toBe(0)
  })

  it('uses oldest cached message id when backward cursor is unset', async () => {
    const chatId = 99
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    ctx.messagesCache.upsert({
      chat_id: chatId,
      message_id: 20,
      message_type: 'text',
      date: 1700000000,
      raw_json: '{}',
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async (payload: Record<string, unknown>) => {
      expect(payload.offsetId).toBe(20)
      return {
        messages: [{ _: 'message', id: 15, date: 1699999999, message: 'old' }],
      }
    })

    ctx.client = { call: clientCall } as unknown as TelegramClient
    ctx.config.batchSize = 5

    const result = await processBackwardHistoryReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)
    expect(result.newCursor).toBe(15)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.backward_cursor).toBe(15)
    expect(state?.history_complete).toBe(1)
  })

  it('marks history complete when backward history returns empty', async () => {
    const chatId = 101
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async () => ({ messages: [] }))
    ctx.client = { call: clientCall } as unknown as TelegramClient

    const result = await processBackwardHistoryReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.history_complete).toBe(1)
  })

  it('initial load updates cursors and marks history complete when batch is short', async () => {
    const chatId = 55
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })

    const job = ctx.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.High,
    })

    const clientCall = mock(async () => ({
      messages: [{ _: 'message', id: 3, date: 1700000002, message: 'a' }],
    }))
    ctx.client = { call: clientCall } as unknown as TelegramClient
    ctx.config.batchSize = 5

    const result = await processInitialLoadReal(ctx, job)

    expect(result.success).toBe(true)
    expect(result.historyComplete).toBe(true)
    expect(result.newCursor).toBe(3)

    const state = ctx.chatSyncState.get(chatId)
    expect(state?.forward_cursor).toBe(3)
    expect(state?.backward_cursor).toBe(3)
    expect(state?.history_complete).toBe(1)
  })

  it('marks job failed for unknown job type', async () => {
    const job = ctx.jobsService.create({
      chat_id: 1,
      job_type: 'BogusType' as SyncJobType,
      priority: SyncPriority.High,
    })

    const result = await processJobReal(ctx, job)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown job type')

    const stored = ctx.jobsService.getById(job.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error_message).toContain('Unknown job type')
  })

  describe('exception handling', () => {
    it('handles non-flood API error in forward catchup', async () => {
      const chatId = 200
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 5,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw new Error('Network connection lost')
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processForwardCatchupReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.messagesFetched).toBe(0)
      expect(result.error).toBe('Network connection lost')
      expect(result.rateLimited).toBeUndefined()
    })

    it('handles flood wait error in forward catchup', async () => {
      const chatId = 201
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 5,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw new Error('FLOOD_WAIT_30')
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processForwardCatchupReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.messagesFetched).toBe(0)
      expect(result.rateLimited).toBe(true)
      expect(result.waitSeconds).toBe(30)
      expect(ctx.rateLimits.isBlocked(ctx.config.apiMethod)).toBe(true)
    })

    it('handles non-flood API error in backward history', async () => {
      const chatId = 202
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        backward_cursor: 100,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw new Error('Server unreachable')
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processBackwardHistoryReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.messagesFetched).toBe(0)
      expect(result.error).toBe('Server unreachable')
      expect(result.rateLimited).toBeUndefined()
    })

    it('handles flood wait error in backward history', async () => {
      const chatId = 203
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        backward_cursor: 100,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw new Error('FLOOD_WAIT_60')
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processBackwardHistoryReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.messagesFetched).toBe(0)
      expect(result.rateLimited).toBe(true)
      expect(result.waitSeconds).toBe(60)
    })

    it('handles non-flood API error in initial load', async () => {
      const chatId = 204
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw new Error('Timeout exceeded')
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processInitialLoadReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.messagesFetched).toBe(0)
      expect(result.error).toBe('Timeout exceeded')
      expect(result.rateLimited).toBeUndefined()
    })

    it('handles flood wait error in initial load', async () => {
      const chatId = 205
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw new Error('FLOOD_WAIT_45')
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processInitialLoadReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.messagesFetched).toBe(0)
      expect(result.rateLimited).toBe(true)
      expect(result.waitSeconds).toBe(45)
    })

    it('handles non-Error thrown values in forward catchup', async () => {
      const chatId = 206
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw 'string error'
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processForwardCatchupReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.error).toBe('string error')
    })

    it('handles non-Error thrown values in backward history', async () => {
      const chatId = 207
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw { code: 500 }
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processBackwardHistoryReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.error).toBe('[object Object]')
    })

    it('handles non-Error thrown values in initial load', async () => {
      const chatId = 208
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => {
        throw 42
      })
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processInitialLoadReal(ctx, job)

      expect(result.success).toBe(false)
      expect(result.error).toBe('42')
    })
  })

  describe('empty messages edge cases', () => {
    it('returns success with no more when forward catchup gets empty messages', async () => {
      const chatId = 300
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 10,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => ({ messages: [] }))
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processForwardCatchupReal(ctx, job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)
      expect(result.hasMore).toBe(false)

      const state = ctx.chatSyncState.get(chatId)
      expect(state?.last_forward_sync).not.toBeNull()
    })

    it('marks history complete when initial load gets empty messages', async () => {
      const chatId = 301
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      })

      const clientCall = mock(async () => ({ messages: [] }))
      ctx.client = { call: clientCall } as unknown as TelegramClient

      const result = await processInitialLoadReal(ctx, job)

      expect(result.success).toBe(true)
      expect(result.messagesFetched).toBe(0)

      const state = ctx.chatSyncState.get(chatId)
      expect(state?.history_complete).toBe(1)
    })
  })

  describe('forward catch-up paging', () => {
    const chatId = 4242

    beforeEach(() => {
      ctx.config.batchSize = 100
    })

    function seedChat(forwardCursor?: number) {
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: forwardCursor,
      })
    }

    function runCatchup() {
      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })
      return processForwardCatchupReal(ctx, job)
    }

    function cachedIds(): number[] {
      return range(1, 2000).filter(
        (id) => ctx.messagesCache.get(chatId, id) !== null,
      )
    }

    it('requests the oldest page above the cursor', async () => {
      seedChat(1000)
      const history = createFakeHistory(range(1, 1150))
      ctx.client = history.client

      const result = await runCatchup()

      expect(history.requests[0]).toMatchObject({
        offsetId: 1001,
        addOffset: -100,
        limit: 100,
        minId: 1000,
      })
      expect(result).toMatchObject({
        success: true,
        messagesFetched: 100,
        hasMore: true,
        newCursor: 1100,
      })
      expect(cachedIds()).toEqual(range(1001, 1100))
      expect(ctx.chatSyncState.get(chatId)?.forward_cursor).toBe(1100)
    })

    it('pages through a 150-message gap and stops on a short page', async () => {
      seedChat(1000)
      const history = createFakeHistory(range(1, 1150))
      ctx.client = history.client

      const first = await runCatchup()
      const second = await runCatchup()

      expect(first.hasMore).toBe(true)
      expect(second).toMatchObject({
        messagesFetched: 50,
        hasMore: false,
        newCursor: 1150,
      })
      expect(history.requests).toHaveLength(2)
      expect(history.requests[1]).toMatchObject({
        offsetId: 1101,
        minId: 1100,
      })
      expect(cachedIds()).toEqual(range(1001, 1150))
      expect(ctx.chatSyncState.get(chatId)?.synced_messages).toBe(150)
    })

    it('needs one empty page after a gap of exactly one batch', async () => {
      seedChat(1000)
      const history = createFakeHistory(range(1, 1100))
      ctx.client = history.client

      const first = await runCatchup()
      const second = await runCatchup()

      expect(first).toMatchObject({ hasMore: true, newCursor: 1100 })
      expect(second).toMatchObject({ messagesFetched: 0, hasMore: false })
      expect(ctx.chatSyncState.get(chatId)?.forward_cursor).toBe(1100)
      expect(cachedIds()).toEqual(range(1001, 1100))
    })

    it('makes no change when nothing is above the cursor', async () => {
      seedChat(1000)
      const history = createFakeHistory(range(1, 1000))
      ctx.client = history.client

      const result = await runCatchup()

      expect(result).toMatchObject({ messagesFetched: 0, hasMore: false })
      expect(ctx.chatSyncState.get(chatId)?.forward_cursor).toBe(1000)
      expect(cachedIds()).toEqual([])
    })

    it('ignores messages at or below the cursor', async () => {
      seedChat(1000)
      ctx.config.batchSize = 3
      ctx.client = {
        call: mock(async () => ({
          messages: [rawMessage(1001), rawMessage(1000), rawMessage(999)],
        })),
      } as unknown as TelegramClient

      const result = await runCatchup()

      expect(result).toMatchObject({
        messagesFetched: 1,
        hasMore: false,
        newCursor: 1001,
      })
      expect(cachedIds()).toEqual([1001])
    })

    it('moves the cursor past empty messages', async () => {
      seedChat(1000)
      ctx.config.batchSize = 2
      ctx.client = {
        call: mock(async () => ({
          messages: [
            { _: 'messageEmpty', id: 1002 },
            { _: 'messageEmpty', id: 1001 },
          ],
        })),
      } as unknown as TelegramClient

      const result = await runCatchup()

      expect(result).toMatchObject({ messagesFetched: 0, newCursor: 1002 })
      expect(ctx.chatSyncState.get(chatId)?.forward_cursor).toBe(1002)
    })

    it('counts only messages that were not cached yet', async () => {
      seedChat(1000)
      ctx.messagesCache.upsert({
        chat_id: chatId,
        message_id: 1051,
        message_type: 'text',
        date: 1_700_001_051,
        raw_json: '{}',
      })
      const history = createFakeHistory(range(1, 1051))
      ctx.client = history.client

      const result = await runCatchup()

      expect(result).toMatchObject({ messagesFetched: 50, newCursor: 1051 })
      expect(ctx.chatSyncState.get(chatId)?.synced_messages).toBe(50)
      expect(cachedIds()).toEqual(range(1001, 1051))
    })

    it('fetches the newest page when the chat has no cursor', async () => {
      seedChat()
      const history = createFakeHistory(range(1, 250))
      ctx.client = history.client

      const result = await runCatchup()

      expect(history.requests[0]).toMatchObject({
        offsetId: 0,
        addOffset: 0,
        minId: 0,
      })
      expect(result).toMatchObject({
        messagesFetched: 100,
        hasMore: false,
        newCursor: 250,
      })
      expect(cachedIds()).toEqual(range(151, 250))
    })
  })
})
