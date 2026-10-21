/**
 * Tests for sync worker real job handlers
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'
import {
  processBackwardHistoryReal,
  processForwardCatchupReal,
  processInitialLoadReal,
  processJobReal,
} from '../daemon/sync-worker-real-jobs'
import type {
  RealJobResult,
  RealSyncWorkerContext,
} from '../daemon/sync-worker-real-types'
import { processJobWithHandlers } from '../daemon/sync-worker-utils'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
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
      historyRanges: createHistoryRanges(db),
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

  /** The ranges a chat's pages recorded, oldest first */
  function storedRanges(chatId: number) {
    return db
      .query(
        'SELECT low, high FROM history_ranges WHERE chat_id = ? ORDER BY low',
      )
      .all(chatId)
  }

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
    expect(storedRanges(chatId)).toEqual([{ low: 6, high: 7 }])
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

  it('starts backfill at the newest page when the backward cursor is unset', async () => {
    const chatId = 99
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    // Pages that tg messages list and get cached: the start of the chat, one
    // message in the middle and the newest two
    for (const id of [1, 2, 3, 20, 29, 30]) {
      ctx.messagesCache.upsert({
        chat_id: chatId,
        message_id: id,
        message_type: 'text',
        date: 1700000000 + id,
        raw_json: '{}',
      })
    }
    const history = createFakeHistory(range(1, 30))
    ctx.client = history.client
    ctx.config.batchSize = 5

    const job = () =>
      ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      })

    const firstJob = job()
    const first = await processBackwardHistoryReal(ctx, firstJob)

    expect(history.requests[0]).toMatchObject({ offsetId: 0, limit: 5 })
    // 29 and 30 were cached already, so only 26-28 count
    expect(first).toMatchObject({
      success: true,
      messagesFetched: 3,
      newCursor: 26,
      hasMore: true,
      historyComplete: false,
    })
    expect(ctx.jobsService.getById(firstJob.id)?.messages_fetched).toBe(3)
    expect(ctx.chatSyncState.get(chatId)?.synced_messages).toBe(3)

    for (let i = 0; i < 10; i++) {
      const result = await processBackwardHistoryReal(ctx, job())
      if (result.historyComplete) break
    }

    expect(ctx.chatSyncState.get(chatId)?.history_complete).toBe(1)
    expect(ctx.messagesCache.countByChatId(chatId)).toBe(30)
    // The pages join into one range, which the CLI pages it cached don't break
    expect(storedRanges(chatId)).toEqual([{ low: 1, high: 30 }])
    // Every gap is filled, and only the 24 messages that weren't cached count
    expect(ctx.chatSyncState.get(chatId)?.synced_messages).toBe(24)
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
    expect(storedRanges(chatId)).toEqual([])
  })

  it('covers the rest of the chat when the page below the cursor is empty', async () => {
    const chatId = 102
    ctx.chatSyncState.upsert({
      chat_id: chatId,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      backward_cursor: 40,
    })
    ctx.messagesCache.upsert({
      chat_id: chatId,
      message_id: 40,
      message_type: 'text',
      date: 1700000040,
      raw_json: '{}',
    })
    ctx.historyRanges.add(chatId, { low: 40, high: 41 })
    ctx.client = {
      call: mock(async () => ({ messages: [] })),
    } as unknown as TelegramClient

    const result = await processBackwardHistoryReal(
      ctx,
      ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      }),
    )

    expect(result.historyComplete).toBe(true)
    expect(storedRanges(chatId)).toEqual([{ low: 1, high: 41 }])
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
    expect(storedRanges(chatId)).toEqual([{ low: 1, high: 3 }])
  })

  it('marks job failed for unknown job type', async () => {
    ctx.chatSyncState.upsert({
      chat_id: 1,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
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
    expect(stored?.attempts).toBe(1)
  })

  describe('job outcomes', () => {
    const NOW = 1_700_000_000_000
    const CHAT = 300
    const realNow = Date.now

    beforeEach(() => {
      Date.now = () => NOW
      ctx.chatSyncState.upsert({
        chat_id: CHAT,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 5,
        backward_cursor: 100,
      })
    })

    afterEach(() => {
      Date.now = realNow
    })

    function queue(jobType = SyncJobType.BackwardHistory, chatId = CHAT) {
      return ctx.jobsService.create({
        chat_id: chatId,
        job_type: jobType,
        priority: SyncPriority.High,
      })
    }

    function throwing(err: unknown) {
      const call = mock(async () => {
        throw err
      })
      ctx.client = { call } as unknown as TelegramClient
      return call
    }

    const failedRows = () =>
      db.query("SELECT id FROM sync_jobs WHERE status = 'failed'").all()

    it('retries a job after a transient error', async () => {
      throwing(new Error('connection reset'))
      const job = queue()

      const result = await processJobReal(ctx, job)

      expect(result.outcome).toEqual({
        state: 'retrying',
        attempts: 1,
        nextRunAt: NOW + 60_000,
      })
      expect(ctx.jobsService.getById(job.id)).toEqual({
        ...job,
        status: 'pending',
        attempts: 1,
        next_run_at: NOW + 60_000,
        error_message: 'connection reset',
        started_at: null,
      })
    })

    for (const [label, err] of [
      ['400 CHANNEL_PRIVATE', new tl.RpcError(400, 'CHANNEL_PRIVATE')],
      ['403', new tl.RpcError(403, 'CHAT_ADMIN_REQUIRED')],
      ['404', new tl.RpcError(404, 'NOT_FOUND')],
      ['406 CHANNEL_PRIVATE', new tl.RpcError(406, 'CHANNEL_PRIVATE')],
    ] as const) {
      it(`fails a job at once on RPC error ${label}`, async () => {
        throwing(err)
        const job = queue()

        const result = await processJobReal(ctx, job)

        expect(result.permanent).toBe(true)
        expect(result.outcome).toEqual({
          state: 'failed',
          attempts: 1,
          nextRunAt: null,
        })
        expect(ctx.jobsService.getById(job.id)).toMatchObject({
          status: 'failed',
          attempts: 1,
          error_message: err.message,
        })
      })
    }

    for (const jobType of [
      SyncJobType.ForwardCatchup,
      SyncJobType.BackwardHistory,
      SyncJobType.InitialLoad,
    ]) {
      it(`fails a ${jobType} job at once when the InputPeer is missing`, async () => {
        const chatId = -1009876543210
        ctx.chatSyncState.upsert({
          chat_id: chatId,
          chat_type: 'channel',
          sync_priority: SyncPriority.High,
          sync_enabled: true,
          forward_cursor: jobType === SyncJobType.InitialLoad ? undefined : 5,
          backward_cursor: 100,
        })
        const job = queue(jobType, chatId)

        const result = await processJobReal(ctx, job)

        expect(result.error).toContain('InputPeer')
        expect(ctx.jobsService.getById(job.id)).toMatchObject({
          status: 'failed',
          attempts: 1,
        })
      })
    }

    for (const [label, err] of [
      ['FLOOD_WAIT_600', new Error('FLOOD_WAIT_600')],
      [
        'an RpcError 420 with seconds',
        tl.RpcError.fromTl({
          _: 'rpcError',
          errorCode: 420,
          errorMessage: 'FLOOD_WAIT_600',
        }),
      ],
    ] as const) {
      it(`defers a job on ${label} without using an attempt`, async () => {
        throwing(err)
        const job = queue()

        const result = await processJobReal(ctx, job)

        expect(result.outcome).toEqual({
          state: 'deferred',
          attempts: 0,
          nextRunAt: NOW + 600_000,
        })
        expect(ctx.jobsService.getById(job.id)).toMatchObject({
          status: 'pending',
          attempts: 0,
          next_run_at: NOW + 600_000,
          error_message: 'Rate limited: wait 600s',
        })
        expect(ctx.rateLimits.isBlocked(ctx.config.apiMethod)).toBe(true)
        expect(failedRows()).toEqual([])
        expect(ctx.jobsService.getNextPending()).toBeNull()

        // After the wait the same job runs and completes
        Date.now = () => NOW + 600_000
        ctx.client = {
          call: mock(async () => ({ messages: [rawMessage(99)] })),
        } as unknown as TelegramClient
        const next = ctx.jobsService.getNextPending()
        expect(next?.id).toBe(job.id)
        const retried = await processJobReal(ctx, next!)

        expect(retried.success).toBe(true)
        expect(ctx.jobsService.getById(job.id)?.status).toBe('completed')
      })
    }

    it('defers a job on FLOOD_WAIT_0 by a second', async () => {
      throwing(new Error('FLOOD_WAIT_0'))
      const job = queue()

      const result = await processJobReal(ctx, job)

      expect(result).toMatchObject({ rateLimited: true, waitSeconds: 1 })
      expect(ctx.jobsService.getById(job.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        next_run_at: NOW + 1000,
        error_message: 'Rate limited: wait 1s',
      })
    })

    it('defers a job whose call is blocked by an earlier FLOOD_WAIT', async () => {
      const call = throwing(new Error('unreachable'))
      ctx.rateLimits.setFloodWait(ctx.config.apiMethod, 30)
      const job = queue()

      const result = await processJobReal(ctx, job)

      expect(call).not.toHaveBeenCalled()
      expect(result.outcome?.state).toBe('deferred')
      expect(ctx.jobsService.getById(job.id)).toMatchObject({
        status: 'pending',
        attempts: 0,
        next_run_at: NOW + 30_000,
      })
    })

    for (const [label, err, attempts] of [
      ['a transient error', new Error('connection reset'), 0],
      ['a FLOOD_WAIT', new Error('FLOOD_WAIT_30'), 0],
      ['a permanent error', new tl.RpcError(400, 'CHANNEL_PRIVATE'), 0],
      ['its last attempt', new Error('connection reset'), 4],
    ] as const) {
      it(`drops a job whose chat was turned off while it ran, on ${label}`, async () => {
        ctx.client = {
          call: mock(async () => {
            // tg chats sync --off runs while the call is in flight
            ctx.chatSyncState.setSyncMode(CHAT, 'off')
            ctx.jobsService.cancelPendingForChat(CHAT)
            throw err
          }),
        } as unknown as TelegramClient
        const queued = queue()
        db.run('UPDATE sync_jobs SET attempts = ? WHERE id = ?', [
          attempts,
          queued.id,
        ])
        const job = ctx.jobsService.getById(queued.id)!

        const result = await processJobReal(ctx, job)

        expect(result.outcome).toEqual({
          state: 'cancelled',
          attempts,
          nextRunAt: null,
        })
        expect(ctx.jobsService.getById(job.id)).toBeNull()
        expect(failedRows()).toEqual([])
      })
    }

    it('never leaves a job running when a handler returns no error', async () => {
      const job = queue()

      const result = await processJobWithHandlers(
        ctx,
        job,
        {
          [SyncJobType.BackwardHistory]: async (): Promise<RealJobResult> => ({
            success: false,
            messagesFetched: 0,
          }),
        },
        () => ({ success: false, messagesFetched: 0 }),
      )

      expect(result.outcome?.state).toBe('retrying')
      expect(ctx.jobsService.getById(job.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        error_message: 'Job ended without a result',
      })
    })

    it('retries a job whose handler throws a transient error', async () => {
      const job = queue()

      const result = await processJobWithHandlers(
        ctx,
        job,
        {
          [SyncJobType.BackwardHistory]: async (): Promise<RealJobResult> => {
            throw new Error('database is locked')
          },
        },
        () => ({ success: false, messagesFetched: 0 }),
      )

      expect(result).toMatchObject({
        error: 'database is locked',
        permanent: false,
        outcome: { state: 'retrying', attempts: 1 },
      })
    })
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
      expect(storedRanges(chatId)).toEqual([{ low: 1001, high: 1150 }])
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
      expect(storedRanges(chatId)).toEqual([{ low: 151, high: 250 }])
    })
  })

  describe('forward catch-up and the newest message', () => {
    const chatId = 4444

    beforeEach(() => {
      ctx.config.batchSize = 100
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
      })
    })

    function runCatchup() {
      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      return processForwardCatchupReal(ctx, job)
    }

    const state = () => ctx.chatSyncState.get(chatId)
    const isDue = () =>
      ctx.chatSyncState.getCatchupDue().some((chat) => chat.chat_id === chatId)

    it('keeps the chat due after a full page', async () => {
      ctx.chatSyncState.raiseTopMessageId(chatId, 1150)
      ctx.client = createFakeHistory(range(1, 1150)).client

      const result = await runCatchup()

      expect(result).toMatchObject({ hasMore: true, newCursor: 1100 })
      expect(state()?.top_message_id).toBe(1150)
      expect(isDue()).toBe(true)
    })

    it('settles the top at the cursor after a short page', async () => {
      ctx.chatSyncState.raiseTopMessageId(chatId, 1150)
      ctx.client = createFakeHistory(range(1, 1150)).client

      await runCatchup()
      const second = await runCatchup()

      expect(second).toMatchObject({ hasMore: false, newCursor: 1150 })
      expect(state()?.forward_cursor).toBe(1150)
      expect(state()?.top_message_id).toBe(1150)
      expect(isDue()).toBe(false)
    })

    it('settles an unknown top', async () => {
      ctx.client = createFakeHistory(range(1, 1020)).client

      await runCatchup()

      expect(state()?.top_message_id).toBe(1020)
      expect(isDue()).toBe(false)
    })

    it('settles in one call when nothing is above the cursor', async () => {
      // The dialog's newest message was deleted before catch-up ran
      ctx.chatSyncState.raiseTopMessageId(chatId, 1001)
      const history = createFakeHistory(range(1, 1000))
      ctx.client = history.client

      const result = await runCatchup()

      expect(result).toMatchObject({ messagesFetched: 0, hasMore: false })
      expect(history.requests).toHaveLength(1)
      expect(state()?.forward_cursor).toBe(1000)
      expect(state()?.top_message_id).toBe(1000)
      expect(isDue()).toBe(false)
    })

    it('keeps the chat due if the top rose during the fetch', async () => {
      ctx.chatSyncState.raiseTopMessageId(chatId, 1020)
      const history = createFakeHistory(range(1, 1020))
      ctx.client = {
        call: async (request: Parameters<TelegramClient['call']>[0]) => {
          // A dialog pass sees message 1021 while the page is in flight
          history.add(1021)
          ctx.chatSyncState.raiseTopMessageId(chatId, 1021)
          return history.client.call(request)
        },
      } as unknown as TelegramClient

      await runCatchup()

      expect(state()?.forward_cursor).toBe(1021)
      expect(state()?.top_message_id).toBe(1021)
      expect(isDue()).toBe(false)

      ctx.client = {
        call: async (request: Parameters<TelegramClient['call']>[0]) => {
          // This time the new message arrives after the page was fetched
          const page = await history.client.call(request)
          history.add(1022)
          ctx.chatSyncState.raiseTopMessageId(chatId, 1022)
          return page
        },
      } as unknown as TelegramClient

      ctx.chatSyncState.markTopUnknown([chatId])
      await runCatchup()

      expect(state()?.forward_cursor).toBe(1021)
      expect(state()?.top_message_id).toBe(1022)
      expect(isDue()).toBe(true)
    })

    it('leaves the top alone when the page fails', async () => {
      ctx.chatSyncState.raiseTopMessageId(chatId, 1150)
      ctx.client = {
        call: mock(async () => {
          throw new Error('FLOOD_WAIT_30')
        }),
      } as unknown as TelegramClient

      const result = await runCatchup()

      expect(result.rateLimited).toBe(true)
      expect(state()?.forward_cursor).toBe(1000)
      expect(state()?.top_message_id).toBe(1150)
      expect(isDue()).toBe(true)
    })
  })

  describe('initial load', () => {
    const chatId = 4343

    beforeEach(() => {
      ctx.config.batchSize = 100
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
    })

    function runJob(jobType: SyncJobType) {
      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: jobType,
        priority: SyncPriority.High,
      })
      return processJobReal(ctx, job)
    }

    it('counts only messages that were not cached yet', async () => {
      // Two messages arrived live before the first page
      for (const id of [249, 250]) {
        ctx.messagesCache.upsert({
          chat_id: chatId,
          message_id: id,
          message_type: 'text',
          date: 1_700_000_000 + id,
          raw_json: '{}',
        })
      }
      ctx.chatSyncState.incrementSyncedMessages(chatId, 2)
      ctx.client = createFakeHistory(range(1, 250)).client

      const result = await runJob(SyncJobType.InitialLoad)

      expect(result).toMatchObject({
        success: true,
        messagesFetched: 98,
        newCursor: 250,
        historyComplete: false,
      })
      const state = ctx.chatSyncState.get(chatId)
      expect(state?.synced_messages).toBe(100)
      expect(state?.forward_cursor).toBe(250)
      expect(state?.backward_cursor).toBe(151)
      expect(state?.history_complete).toBe(0)
      expect(state?.top_message_id).toBe(250)
      const [job] = ctx.jobsService.getJobsForChat(chatId)
      expect(job?.messages_fetched).toBe(98)
    })

    it('leaves an empty chat at cursor 0 so catch-up starts from its first message', async () => {
      const history = createFakeHistory([])
      ctx.client = history.client

      const first = await runJob(SyncJobType.InitialLoad)

      expect(first).toMatchObject({ success: true, messagesFetched: 0 })
      let state = ctx.chatSyncState.get(chatId)
      expect(state?.forward_cursor).toBe(0)
      expect(state?.backward_cursor).toBe(0)
      expect(state?.history_complete).toBe(1)

      history.add(1, 2, 3)
      const catchup = await runJob(SyncJobType.ForwardCatchup)

      expect(history.requests[1]).toMatchObject({
        offsetId: 1,
        addOffset: -100,
        minId: 0,
      })
      expect(catchup).toMatchObject({ messagesFetched: 3, newCursor: 3 })
      state = ctx.chatSyncState.get(chatId)
      expect(state?.forward_cursor).toBe(3)
      expect(ctx.messagesCache.countByChatId(chatId)).toBe(3)
    })

    it('takes the cursors from empty messages too', async () => {
      ctx.config.batchSize = 2
      ctx.client = {
        call: mock(async () => ({
          messages: [
            { _: 'messageEmpty', id: 31 },
            { _: 'messageEmpty', id: 30 },
          ],
        })),
      } as unknown as TelegramClient

      const result = await runJob(SyncJobType.InitialLoad)

      expect(result).toMatchObject({ success: true, newCursor: 31 })
      const state = ctx.chatSyncState.get(chatId)
      expect(state?.forward_cursor).toBe(31)
      expect(state?.backward_cursor).toBe(30)
      expect(state?.history_complete).toBe(0)
    })

    it('reopens history when a chat marked complete has a full page now', async () => {
      // An empty chat from an older version: complete, but no cursor
      ctx.chatSyncState.markHistoryComplete(chatId)
      ctx.client = createFakeHistory(range(1, 150)).client

      await runJob(SyncJobType.InitialLoad)

      const state = ctx.chatSyncState.get(chatId)
      expect(state?.backward_cursor).toBe(51)
      expect(state?.history_complete).toBe(0)
    })

    it('raises the top to at least the newest message on the page', async () => {
      ctx.chatSyncState.raiseTopMessageId(chatId, 240)
      ctx.client = createFakeHistory(range(1, 250)).client

      await runJob(SyncJobType.InitialLoad)

      expect(ctx.chatSyncState.get(chatId)?.top_message_id).toBe(250)
    })

    it('keeps a higher top, so the chat is caught up next', async () => {
      // The dialog pass saw message 260; the page only got up to 250
      ctx.chatSyncState.raiseTopMessageId(chatId, 260)
      ctx.client = createFakeHistory(range(1, 250)).client

      await runJob(SyncJobType.InitialLoad)

      expect(ctx.chatSyncState.get(chatId)?.top_message_id).toBe(260)
      expect(
        ctx.chatSyncState.getCatchupDue().map((chat) => chat.chat_id),
      ).toEqual([chatId])
    })

    it('makes no call for a chat that already has a forward cursor', async () => {
      ctx.chatSyncState.updateCursors(chatId, { forward_cursor: 1000 })
      const history = createFakeHistory(range(1, 1150))
      ctx.client = history.client

      const result = await runJob(SyncJobType.InitialLoad)

      expect(result).toMatchObject({ success: true, messagesFetched: 0 })
      expect(history.requests).toHaveLength(0)
      expect(ctx.chatSyncState.get(chatId)?.forward_cursor).toBe(1000)
    })
  })

  describe('backward history', () => {
    const chatId = 5151

    beforeEach(() => {
      ctx.config.batchSize = 100
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 300,
        backward_cursor: 201,
      })
    })

    function runHistory() {
      const job = ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      })
      return processJobReal(ctx, job)
    }

    const state = () => ctx.chatSyncState.get(chatId)

    it('moves the cursor past a full page of empty messages', async () => {
      ctx.config.batchSize = 2
      const call = mock(async (request: { offsetId: number }) => ({
        messages: [
          { _: 'messageEmpty', id: request.offsetId - 1 },
          { _: 'messageEmpty', id: request.offsetId - 2 },
        ],
      }))
      ctx.client = { call } as unknown as TelegramClient

      const first = await runHistory()
      const second = await runHistory()

      expect(first).toMatchObject({
        success: true,
        messagesFetched: 0,
        hasMore: true,
        newCursor: 199,
      })
      expect(call.mock.calls.map(([request]) => request.offsetId)).toEqual([
        201, 199,
      ])
      expect(second).toMatchObject({ hasMore: true, newCursor: 197 })
      expect(state()?.backward_cursor).toBe(197)
      expect(state()?.history_complete).toBe(0)
      expect(state()?.synced_messages).toBe(0)
    })

    it('stops on a page without message IDs instead of fetching it again', async () => {
      ctx.config.batchSize = 2
      ctx.client = {
        call: mock(async () => ({
          messages: [{ _: 'messageEmpty' }, { _: 'messageEmpty' }],
        })),
      } as unknown as TelegramClient

      const result = await runHistory()

      expect(result).toMatchObject({
        success: true,
        hasMore: false,
        historyComplete: true,
      })
      expect(state()?.backward_cursor).toBe(201)
      expect(state()?.history_complete).toBe(1)
    })

    it('counts only messages that were not cached yet', async () => {
      // Live updates cached two of the page's messages
      for (const id of [150, 200]) {
        ctx.messagesCache.upsert({
          chat_id: chatId,
          message_id: id,
          message_type: 'text',
          date: 1_700_000_000 + id,
          raw_json: '{}',
        })
      }
      ctx.client = createFakeHistory(range(1, 300)).client

      const result = await runHistory()

      expect(result).toMatchObject({
        success: true,
        messagesFetched: 98,
        hasMore: true,
        newCursor: 101,
      })
      expect(state()?.synced_messages).toBe(98)
      const [job] = ctx.jobsService.getJobsForChat(chatId)
      expect(job?.messages_fetched).toBe(98)
    })

    /** A chat as an older version left it: no backward cursor */
    function seedLegacy(forwardCursor: number, backwardCursor: number | null) {
      ctx.chatSyncState.delete(chatId)
      ctx.chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: forwardCursor,
        backward_cursor: backwardCursor,
      })
    }

    it('pages down from the forward cursor when there is no backward cursor', async () => {
      // 0.1.4 cached message 50 live and moved the cursor to 300 by
      // catch-up; 51-200 were never fetched
      seedLegacy(300, null)
      for (const id of [50, ...range(201, 300)]) {
        ctx.messagesCache.upsert({
          chat_id: chatId,
          message_id: id,
          message_type: 'text',
          date: 1_700_000_000 + id,
          raw_json: '{}',
        })
      }
      const history = createFakeHistory(range(1, 300))
      ctx.client = history.client

      const fetched: number[] = []
      for (let run = 0; run < 5 && !state()?.history_complete; run++) {
        fetched.push((await runHistory()).messagesFetched)
      }

      expect(history.requests.map((request) => request.offsetId)).toEqual([
        301, 201, 101,
      ])
      expect(fetched).toEqual([0, 100, 99])
      expect(ctx.messagesCache.countByChatId(chatId)).toBe(300)
      expect(state()?.backward_cursor).toBe(1)
      expect(state()?.history_complete).toBe(1)
    })

    it('ignores a backward cursor above the forward cursor', async () => {
      // An older first page of only empty messages left these cursors
      seedLegacy(0, Number.MAX_SAFE_INTEGER)
      const history = createFakeHistory(range(1, 5))
      ctx.client = history.client

      const result = await runHistory()

      expect(history.requests.map((request) => request.offsetId)).toEqual([1])
      expect(result).toMatchObject({ success: true, historyComplete: true })
      expect(state()?.history_complete).toBe(1)
    })
  })
})
