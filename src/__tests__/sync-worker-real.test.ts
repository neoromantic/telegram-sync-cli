/**
 * Tests for real sync worker wrapper behavior
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import type {
  RealJobResult,
  RealSyncWorkerContext,
} from '../daemon/sync-worker-real-types'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { ChatsCache } from '../db/chats-cache'
import type { HistoryRanges } from '../db/history-ranges'
import type { MessagesCache } from '../db/messages-cache'
import type { RateLimitsService } from '../db/rate-limits'
import type { SyncJobsService } from '../db/sync-jobs'
import type { SyncJobRow } from '../db/sync-schema'

type ProcessJobReal = (
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
) => Promise<RealJobResult>

let processJobRealImpl = mock<ProcessJobReal>(async (_ctx, _job) => ({
  success: true,
  messagesFetched: 3,
}))
let processForwardCatchupRealImpl = mock<ProcessJobReal>(async () => ({
  success: true,
  messagesFetched: 0,
}))
let processBackwardHistoryRealImpl = mock<ProcessJobReal>(async () => ({
  success: true,
  messagesFetched: 0,
}))
let processInitialLoadRealImpl = mock<ProcessJobReal>(async () => ({
  success: true,
  messagesFetched: 0,
}))

mock.module('../daemon/sync-worker-real-jobs', () => ({
  processJobReal: (...args: Parameters<ProcessJobReal>) =>
    processJobRealImpl(...args),
  processForwardCatchupReal: (...args: Parameters<ProcessJobReal>) =>
    processForwardCatchupRealImpl(...args),
  processBackwardHistoryReal: (...args: Parameters<ProcessJobReal>) =>
    processBackwardHistoryRealImpl(...args),
  processInitialLoadReal: (...args: Parameters<ProcessJobReal>) =>
    processInitialLoadRealImpl(...args),
}))

describe('createRealSyncWorker', () => {
  beforeEach(() => {
    processJobRealImpl = mock<ProcessJobReal>(async (_ctx, _job) => ({
      success: true,
      messagesFetched: 3,
    }))
    processForwardCatchupRealImpl = mock<ProcessJobReal>(async () => ({
      success: true,
      messagesFetched: 0,
    }))
    processBackwardHistoryRealImpl = mock<ProcessJobReal>(async () => ({
      success: true,
      messagesFetched: 0,
    }))
    processInitialLoadRealImpl = mock<ProcessJobReal>(async () => ({
      success: true,
      messagesFetched: 0,
    }))
  })

  it('returns rate limited result when API is blocked', async () => {
    const rateLimits = {
      isBlocked: mock(() => true),
      getWaitTime: mock(() => 42),
    } satisfies Pick<RateLimitsService, 'isBlocked' | 'getWaitTime'>

    const jobsService = {
      getNextPending: mock(() => null),
    } satisfies Pick<SyncJobsService, 'getNextPending'>

    const { createRealSyncWorker } = await import('../daemon/sync-worker-real')

    const worker = createRealSyncWorker({
      client: {} as unknown as TelegramClient,
      messagesCache: {} as unknown as MessagesCache,
      historyRanges: {} as unknown as HistoryRanges,
      chatSyncState: {} as unknown as ChatSyncStateService,
      jobsService: jobsService as unknown as SyncJobsService,
      rateLimits: rateLimits as unknown as RateLimitsService,
      chatsCache: {} as unknown as ChatsCache,
    })

    const result = await worker.runOnceReal()

    expect(result?.rateLimited).toBe(true)
    expect(result?.waitSeconds).toBe(42)
    expect(jobsService.getNextPending).not.toHaveBeenCalled()
    expect(processJobRealImpl).not.toHaveBeenCalled()
  })

  it('processes the next pending job', async () => {
    const rateLimits = {
      isBlocked: mock(() => false),
      getWaitTime: mock(() => 0),
    } satisfies Pick<RateLimitsService, 'isBlocked' | 'getWaitTime'>

    const job = {
      id: 10,
      chat_id: 123,
      job_type: 'forward_catchup',
    } as SyncJobRow

    const jobsService = {
      getNextPending: mock(() => job),
    } satisfies Pick<SyncJobsService, 'getNextPending'>

    const { createRealSyncWorker } = await import('../daemon/sync-worker-real')

    const worker = createRealSyncWorker({
      client: {} as unknown as TelegramClient,
      messagesCache: {} as unknown as MessagesCache,
      historyRanges: {} as unknown as HistoryRanges,
      chatSyncState: {} as unknown as ChatSyncStateService,
      jobsService: jobsService as unknown as SyncJobsService,
      rateLimits: rateLimits as unknown as RateLimitsService,
      chatsCache: {} as unknown as ChatsCache,
    })

    const result = await worker.runOnceReal()

    expect(processJobRealImpl).toHaveBeenCalledWith(expect.anything(), job)
    expect(result?.messagesFetched).toBe(3)
  })

  it('uses overridden config when checking rate limits', async () => {
    const rateLimits = {
      isBlocked: mock(() => false),
      getWaitTime: mock(() => 0),
    } satisfies Pick<RateLimitsService, 'isBlocked' | 'getWaitTime'>

    const { createRealSyncWorker } = await import('../daemon/sync-worker-real')

    const worker = createRealSyncWorker({
      client: {} as unknown as TelegramClient,
      messagesCache: {} as unknown as MessagesCache,
      historyRanges: {} as unknown as HistoryRanges,
      chatSyncState: {} as unknown as ChatSyncStateService,
      jobsService: { getNextPending: mock(() => null) } as Pick<
        SyncJobsService,
        'getNextPending'
      > as unknown as SyncJobsService,
      rateLimits: rateLimits as unknown as RateLimitsService,
      chatsCache: {} as unknown as ChatsCache,
      config: {
        apiMethod: 'messages.search',
        batchSize: 5,
      },
    })

    worker.canMakeApiCall()
    worker.getWaitTime()

    expect(rateLimits.isBlocked).toHaveBeenCalledWith('messages.search')
    expect(rateLimits.getWaitTime).toHaveBeenCalledWith('messages.search')
  })

  it('delegates job handler helpers', async () => {
    const { createRealSyncWorker } = await import('../daemon/sync-worker-real')

    const worker = createRealSyncWorker({
      client: {} as unknown as TelegramClient,
      messagesCache: {} as unknown as MessagesCache,
      historyRanges: {} as unknown as HistoryRanges,
      chatSyncState: {} as unknown as ChatSyncStateService,
      jobsService: { getNextPending: mock(() => null) } as Pick<
        SyncJobsService,
        'getNextPending'
      > as unknown as SyncJobsService,
      rateLimits: {
        isBlocked: mock(() => false),
        getWaitTime: mock(() => 0),
      } as Pick<
        RateLimitsService,
        'isBlocked' | 'getWaitTime'
      > as unknown as RateLimitsService,
      chatsCache: {} as unknown as ChatsCache,
    })

    const job = { id: 1, chat_id: 1, job_type: 'forward_catchup' } as SyncJobRow
    await worker.processForwardCatchupReal(job)
    await worker.processBackwardHistoryReal(job)
    await worker.processInitialLoadReal(job)

    expect(processForwardCatchupRealImpl).toHaveBeenCalled()
    expect(processBackwardHistoryRealImpl).toHaveBeenCalled()
    expect(processInitialLoadRealImpl).toHaveBeenCalled()
  })
})
