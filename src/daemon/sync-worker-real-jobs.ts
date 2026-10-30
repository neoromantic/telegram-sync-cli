import type { MessageInput } from '../db/messages-cache'
import { type SyncJobRow, SyncJobType } from '../db/sync-schema'
import {
  canMakeApiCall,
  getInputPeer,
  getWaitTime,
  resolveJobError,
  trackJobApiCall,
} from './sync-worker-real-context'
import {
  createMessageInputs,
  fetchMessagesRaw,
  forwardPageRequest,
  rawMessageId,
} from './sync-worker-real-helpers'
import type {
  RealJobResult,
  RealSyncWorkerContext,
} from './sync-worker-real-types'
import { processJobWithHandlers } from './sync-worker-utils'

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
 * A page that isn't full reached the newest message, so the same write sets
 * `top_message_id` to the new cursor and the chat stops being due. If a
 * dialog pass raised the top while the page was in flight, the top stays and
 * the chat stays due.
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
      permanent: true,
    }
    return result
  }

  const state = ctx.chatSyncState.get(chatId)
  // 0 is a real cursor: the first page of an empty chat leaves it there.
  const cursor = state?.forward_cursor ?? null
  const floor = cursor ?? 0
  const topBefore = state?.top_message_id ?? null

  try {
    const { messages } = await trackJobApiCall(ctx, () =>
      fetchMessagesRaw(
        ctx.client,
        inputPeer,
        forwardPageRequest(cursor, ctx.config.batchSize),
        ctx.signal,
      ),
    )

    // Guard against a server that returns messages at or below the cursor.
    const above = messages.filter((message) => rawMessageId(message) > floor)

    if (above.length === 0) {
      if (cursor === null) {
        ctx.chatSyncState.updateLastSync(chatId, 'forward')
      } else {
        // Nothing above the cursor: the chat is caught up.
        ctx.chatSyncState.recordCatchupPage(chatId, {
          forward_cursor: cursor,
          new_messages: 0,
          caught_up: true,
          top_before: topBefore,
        })
      }
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
    ctx.historyRanges.recordPage(
      chatId,
      above.map(rawMessageId),
      cursor !== null
        ? { after: cursor }
        : { reachedStart: messages.length < ctx.config.batchSize },
    )

    const hasMore = cursor !== null && above.length >= ctx.config.batchSize
    ctx.chatSyncState.recordCatchupPage(chatId, {
      forward_cursor: top,
      new_messages: newCount,
      caught_up: !hasMore,
      top_before: topBefore,
    })

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: newCount,
      cursor_end: top,
    })

    result = {
      success: true,
      messagesFetched: newCount,
      hasMore,
      newCursor: top,
    }
  } catch (err) {
    return resolveJobError(ctx, err)
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
      permanent: true,
    }
  }

  const state = ctx.chatSyncState.get(chatId)
  if (state?.history_complete) {
    return { success: true, messagesFetched: 0, historyComplete: true }
  }

  // Older versions left a forward cursor without a backward one (0.1.4's
  // catch-up, and every live message before it), or one above it (a first
  // page of only empty messages). The oldest cached message then says
  // nothing about what is cached below the forward cursor, so history pages
  // down from just above it.
  const forwardCursor = state?.forward_cursor ?? null
  let backwardCursor = state?.backward_cursor ?? null
  if (
    forwardCursor !== null &&
    (backwardCursor === null || backwardCursor > forwardCursor + 1)
  ) {
    backwardCursor = forwardCursor + 1
  }
  // Without either cursor, backfill starts at the newest page. The oldest
  // cached message marks no progress: tg send and tg messages list and get
  // cache messages anywhere in a chat, and starting below such a page would
  // skip the gap above it, or reach the start early and mark history
  // complete.
  backwardCursor ??= 0

  let result: RealJobResult

  try {
    const { messages } = await trackJobApiCall(ctx, () =>
      fetchMessagesRaw(
        ctx.client,
        inputPeer,
        { offsetId: backwardCursor, limit: ctx.config.batchSize },
        ctx.signal,
      ),
    )

    // The newest messages below the cursor, or the newest page without one
    const bounds = {
      before: backwardCursor || undefined,
      reachedStart: messages.length < ctx.config.batchSize,
    }

    if (messages.length === 0) {
      ctx.historyRanges.recordPage(chatId, [], bounds)
      ctx.chatSyncState.markHistoryComplete(chatId)
      ctx.chatSyncState.updateLastSync(chatId, 'backward')
      result = { success: true, messagesFetched: 0, historyComplete: true }
    } else {
      // Empty messages hold no data, but the cursor still moves past them.
      const ids = messages.map(rawMessageId).filter((id) => id > 0)
      const minId = ids.length > 0 ? Math.min(...ids) : backwardCursor
      const { inputs } = createMessageInputs(messages, chatId, minId, minId)

      // The first page, live updates and pages the CLI cached may hold some
      const newCount = countUncached(ctx, chatId, inputs)

      if (inputs.length > 0) {
        ctx.messagesCache.upsertBatch(inputs)
      }
      ctx.historyRanges.recordPage(chatId, messages.map(rawMessageId), bounds)

      ctx.chatSyncState.updateCursors(chatId, { backward_cursor: minId })
      ctx.chatSyncState.incrementSyncedMessages(chatId, newCount)
      ctx.chatSyncState.updateLastSync(chatId, 'backward')

      ctx.jobsService.updateProgress(job.id, {
        messages_fetched: newCount,
        cursor_end: minId,
      })

      // A page without message IDs can't move the cursor, so fetching the
      // next one would fetch the same page again.
      const historyComplete =
        ids.length === 0 || minId <= 1 || messages.length < ctx.config.batchSize
      if (historyComplete) {
        ctx.chatSyncState.markHistoryComplete(chatId)
      }

      result = {
        success: true,
        messagesFetched: newCount,
        hasMore: !historyComplete,
        newCursor: minId,
        historyComplete,
      }
    }
  } catch (err) {
    return resolveJobError(ctx, err)
  }

  return result
}

/**
 * The first page of a chat without a forward cursor: its newest messages.
 * It sets both cursors, so catch-up pages up from the newest message and
 * history pages down from the oldest. An empty chat gets cursors at 0, so
 * its first message is caught up from the start.
 */
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

  // A chat with a forward cursor already had its first page; moving the
  // cursor to the newest message now could skip messages below it.
  const state = ctx.chatSyncState.get(chatId)
  if (state && state.forward_cursor !== null) {
    return { success: true, messagesFetched: 0 }
  }

  const inputPeer = getInputPeer(ctx, chatId)
  if (!inputPeer) {
    result = {
      success: false,
      messagesFetched: 0,
      error: `Could not build InputPeer for chat ${chatId}`,
      permanent: true,
    }
    return result
  }

  try {
    const { messages } = await trackJobApiCall(ctx, () =>
      fetchMessagesRaw(
        ctx.client,
        inputPeer,
        { limit: ctx.config.batchSize },
        ctx.signal,
      ),
    )

    // Empty messages hold no data, but they still count for the cursors.
    const ids = messages.map(rawMessageId).filter((id) => id > 0)

    if (ids.length === 0) {
      ctx.chatSyncState.recordFirstPage(chatId, {
        forward_cursor: 0,
        backward_cursor: 0,
        history_complete: true,
        new_messages: 0,
      })
      result = {
        success: true,
        messagesFetched: 0,
        newCursor: 0,
        historyComplete: true,
      }
      return result
    }

    const maxId = Math.max(...ids)
    const minId = Math.min(...ids)
    const { inputs } = createMessageInputs(messages, chatId, minId, maxId)

    // Live updates already counted the messages they cached.
    const newCount = countUncached(ctx, chatId, inputs)

    if (inputs.length > 0) {
      ctx.messagesCache.upsertBatch(inputs)
    }

    const historyComplete = minId <= 1 || messages.length < ctx.config.batchSize
    ctx.historyRanges.recordPage(chatId, messages.map(rawMessageId), {
      reachedStart: historyComplete,
    })

    ctx.chatSyncState.recordFirstPage(chatId, {
      forward_cursor: maxId,
      backward_cursor: minId,
      history_complete: historyComplete,
      new_messages: newCount,
    })

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: newCount,
      cursor_start: maxId,
      cursor_end: minId,
    })

    result = {
      success: true,
      messagesFetched: newCount,
      newCursor: maxId,
      historyComplete,
    }
  } catch (err) {
    return resolveJobError(ctx, err)
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
    permanent: true,
  }))
}
