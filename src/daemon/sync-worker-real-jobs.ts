import type { MessageInput } from '../db/messages-cache'
import { type SyncJobRow, SyncJobType } from '../db/sync-schema'
import {
  canMakeApiCall,
  getInputPeer,
  getWaitTime,
  recordApiCall,
  resolveFloodWaitResult,
} from './sync-worker-real-context'
import {
  createMessageInputs,
  fetchMessagesRaw,
} from './sync-worker-real-helpers'
import type {
  RealJobResult,
  RealSyncWorkerContext,
} from './sync-worker-real-types'
import { processJobWithHandlers } from './sync-worker-utils'

/**
 * The page a forward catch-up fetches. With a cursor it is the oldest
 * `limit` messages above the cursor: a negative `addOffset` makes
 * `offsetId` inclusive, so the page starts one above the cursor, and `minId`
 * keeps older messages out. Without a cursor it is the newest page.
 */
function forwardPageRequest(cursor: number | null, limit: number) {
  if (cursor === null) {
    return { limit }
  }
  return { offsetId: cursor + 1, addOffset: -limit, limit, minId: cursor }
}

function rawMessageId(message: unknown): number {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === 'number' ? id : 0
}

function countUncached(
  ctx: RealSyncWorkerContext,
  chatId: number,
  inputs: MessageInput[],
): number {
  return inputs.filter(
    (input) => ctx.messagesCache.get(chatId, input.message_id) === null,
  ).length
}

/**
 * Forward catch-up keeps one rule: every message up to `forward_cursor` is
 * cached. Live updates don't move the cursor, because messages that arrived
 * while the daemon was stopped may sit below them. Each job caches the page
 * just above the cursor and moves the cursor to its newest message; a full
 * page means there may be more, so the scheduler queues the next page.
 *
 * A chat without a cursor gets its newest page; older history is the
 * backward job's.
 */
export async function processForwardCatchupReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  let result: RealJobResult
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    result = {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
    return result
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    result = {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
    }
    return result
  }

  const storedCursor = ctx.chatSyncState.get(chatId)?.forward_cursor
  const cursor = storedCursor && storedCursor > 0 ? storedCursor : null
  const floor = cursor ?? 0

  try {
    recordApiCall(ctx)

    const { messages } = await fetchMessagesRaw(
      ctx.client,
      inputPeer,
      forwardPageRequest(cursor, ctx.config.batchSize),
    )

    // Guard against a server that returns messages at or below the cursor.
    const above = messages.filter((message) => rawMessageId(message) > floor)

    if (above.length === 0) {
      ctx.chatSyncState.updateLastSync(chatId, 'forward')
      result = { success: true, messagesFetched: 0, hasMore: false }
      return result
    }

    // Empty messages hold no data, but the cursor still moves past them.
    const top = Math.max(...above.map(rawMessageId))
    const { inputs } = createMessageInputs(above, chatId, floor, floor)

    // Live updates already counted the messages they cached.
    const newCount = countUncached(ctx, chatId, inputs)

    if (inputs.length > 0) {
      ctx.messagesCache.upsertBatch(inputs)
    }

    ctx.chatSyncState.updateCursors(chatId, { forward_cursor: top })
    ctx.chatSyncState.incrementSyncedMessages(chatId, newCount)
    ctx.chatSyncState.updateLastSync(chatId, 'forward')

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: newCount,
      cursor_end: top,
    })

    result = {
      success: true,
      messagesFetched: newCount,
      hasMore: cursor !== null && above.length >= ctx.config.batchSize,
      newCursor: top,
    }
  } catch (err) {
    const floodResult = resolveFloodWaitResult(ctx, err)
    if (floodResult) {
      return floodResult
    }
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      messagesFetched: 0,
      error: error.message,
    }
  }

  return result
}

export async function processBackwardHistoryReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    return {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    return {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
    }
  }

  const state = ctx.chatSyncState.get(chatId)
  if (state?.history_complete) {
    return { success: true, messagesFetched: 0, historyComplete: true }
  }

  let backwardCursor = state?.backward_cursor
  if (backwardCursor === null || backwardCursor === undefined) {
    backwardCursor = ctx.messagesCache.getOldestMessageId(chatId) ?? 0
  }

  let result: RealJobResult

  try {
    recordApiCall(ctx)

    const { messages } = await fetchMessagesRaw(ctx.client, inputPeer, {
      offsetId: backwardCursor,
      limit: ctx.config.batchSize,
    })

    if (messages.length === 0) {
      ctx.chatSyncState.markHistoryComplete(chatId)
      ctx.chatSyncState.updateLastSync(chatId, 'backward')
      result = { success: true, messagesFetched: 0, historyComplete: true }
    } else {
      const { inputs, minId } = createMessageInputs(
        messages,
        chatId,
        backwardCursor || Number.MAX_SAFE_INTEGER,
        backwardCursor || 0,
      )

      if (inputs.length > 0) {
        ctx.messagesCache.upsertBatch(inputs)
      }

      ctx.chatSyncState.updateCursors(chatId, { backward_cursor: minId })
      ctx.chatSyncState.incrementSyncedMessages(chatId, inputs.length)
      ctx.chatSyncState.updateLastSync(chatId, 'backward')

      ctx.jobsService.updateProgress(job.id, {
        messages_fetched: inputs.length,
        cursor_end: minId,
      })

      const historyComplete =
        minId === 1 || messages.length < ctx.config.batchSize
      if (historyComplete) {
        ctx.chatSyncState.markHistoryComplete(chatId)
      }

      result = {
        success: true,
        messagesFetched: inputs.length,
        hasMore: !historyComplete,
        newCursor: minId,
        historyComplete,
      }
    }
  } catch (err) {
    const floodResult = resolveFloodWaitResult(ctx, err)
    if (floodResult) {
      return floodResult
    }
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      messagesFetched: 0,
      error: error.message,
    }
  }

  return result
}

export async function processInitialLoadReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  let result: RealJobResult
  const chatId = job.chat_id

  if (!canMakeApiCall(ctx)) {
    result = {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    }
    return result
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    result = {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
    }
    return result
  }

  try {
    recordApiCall(ctx)

    const { messages } = await fetchMessagesRaw(ctx.client, inputPeer, {
      limit: ctx.config.batchSize,
    })

    if (messages.length === 0) {
      ctx.chatSyncState.markHistoryComplete(chatId)
      result = { success: true, messagesFetched: 0 }
      return result
    }

    const { inputs, minId, maxId } = createMessageInputs(
      messages,
      chatId,
      Number.MAX_SAFE_INTEGER,
      0,
    )

    if (inputs.length > 0) {
      ctx.messagesCache.upsertBatch(inputs)
    }

    ctx.chatSyncState.updateCursors(chatId, {
      forward_cursor: maxId,
      backward_cursor: minId,
    })
    ctx.chatSyncState.incrementSyncedMessages(chatId, inputs.length)
    ctx.chatSyncState.updateLastSync(chatId, 'forward')

    const historyComplete = messages.length < ctx.config.batchSize
    if (historyComplete) {
      ctx.chatSyncState.markHistoryComplete(chatId)
    }

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: inputs.length,
      cursor_start: maxId,
      cursor_end: minId,
    })

    result = {
      success: true,
      messagesFetched: inputs.length,
      newCursor: maxId,
      historyComplete,
    }
  } catch (err) {
    const floodResult = resolveFloodWaitResult(ctx, err)
    if (floodResult) {
      return floodResult
    }
    const error = err instanceof Error ? err : new Error(String(err))
    result = {
      success: false,
      messagesFetched: 0,
      error: error.message,
    }
  }

  return result
}

async function processFullSyncReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  const result = await processInitialLoadReal(ctx, job)
  if (result.success && !result.historyComplete) {
    return { ...result, hasMore: true }
  }
  return result
}

const JOB_HANDLERS: Partial<
  Record<
    SyncJobType,
    (ctx: RealSyncWorkerContext, job: SyncJobRow) => Promise<RealJobResult>
  >
> = {
  [SyncJobType.ForwardCatchup]: processForwardCatchupReal,
  [SyncJobType.BackwardHistory]: processBackwardHistoryReal,
  [SyncJobType.InitialLoad]: processInitialLoadReal,
  [SyncJobType.FullSync]: processFullSyncReal,
}

export async function processJobReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
): Promise<RealJobResult> {
  return processJobWithHandlers(ctx, job, JOB_HANDLERS, (jobType) => ({
    success: false,
    messagesFetched: 0,
    error: `Unknown job type: ${jobType}`,
  }))
}
