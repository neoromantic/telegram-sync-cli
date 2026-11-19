import type { tl } from "@mtcute/bun";
import {
  isOwnOrdinaryMessage,
  nowSeconds,
  PARTICIPATION_WINDOW_SECONDS,
} from "../db/group-participation";
import {
  CHAT_INDEPENDENT_JOB_TYPES,
  type SyncJobRow,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from "../db/sync-schema";
import { toLong } from "../utils/long";
import { toPeerIdFromRawPeer } from "../utils/telegram-peer-ids";
import {
  canMakeApiCall,
  getWaitTime,
  requestPeer,
  resolveJobError,
} from "./sync-worker-real-context";
import {
  cachePageUsers,
  createMessageInputs,
  fetchMessagesByIdRaw,
  fetchMessagesRaw,
  forwardPageRequest,
  historyTotal,
  parseRawMessage,
  rawMessageId,
} from "./sync-worker-real-helpers";
import type { RealJobResult, RealSyncWorkerContext } from "./sync-worker-real-types";
import { processJobWithHandlers } from "./sync-worker-utils";

const PAUSED: RealJobResult = { success: true, messagesFetched: 0 };

async function fetchJobPage(
  ctx: RealSyncWorkerContext,
  chatId: number,
  inputPeer: tl.TypeInputPeer,
  request: Parameters<typeof fetchMessagesRaw>[2],
) {
  const page = await fetchMessagesRaw(ctx.client, inputPeer, request, ctx.signal);
  cachePageUsers(ctx.usersCache, page.users);
  const total = historyTotal(page, request);
  if (total !== null) ctx.chatSyncState.setTotalMessages(chatId, total);
  return page.messages;
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
export async function processForwardCatchupReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const chatId = job.chat_id;
  const peer = requestPeer(ctx, chatId);
  if ("result" in peer) return peer.result;

  const state = ctx.chatSyncState.get(chatId);
  const cursor = state?.forward_cursor ?? null;
  const floor = cursor ?? 0;
  const topBefore = state?.top_message_id ?? null;

  try {
    const messages = await fetchJobPage(
      ctx,
      chatId,
      peer.inputPeer,
      forwardPageRequest(cursor, ctx.config.batchSize),
    );

    if (!ctx.messagesCache.participation.captures(chatId)) return PAUSED;
    const above = messages.filter((message) => rawMessageId(message) > floor);

    if (above.length === 0) {
      if (cursor === null) {
        ctx.chatSyncState.updateLastSync(chatId, "forward");
      } else {
        ctx.chatSyncState.recordCatchupPage(chatId, {
          forward_cursor: cursor,
          new_messages: 0,
          caught_up: true,
          top_before: topBefore,
        });
      }
      const value: RealJobResult = { success: true, messagesFetched: 0, hasMore: false };
      return value;
    }

    const top = Math.max(...above.map(rawMessageId));
    const inputs = createMessageInputs(above, chatId);

    const write = ctx.messagesCache.upsertBatch(inputs);
    if (!ctx.messagesCache.participation.captures(chatId)) return PAUSED;
    const newCount = write.inserted;

    if (write.skipped === 0) {
      ctx.historyRanges.recordPage(
        chatId,
        above.map(rawMessageId),
        cursor !== null
          ? { after: cursor }
          : { reachedStart: messages.length < ctx.config.batchSize },
      );
    }

    const hasMore = cursor !== null && above.length >= ctx.config.batchSize;
    ctx.chatSyncState.recordCatchupPage(chatId, {
      forward_cursor: top,
      new_messages: newCount,
      caught_up: !hasMore,
      top_before: topBefore,
    });

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: newCount,
      cursor_end: top,
    });

    const value: RealJobResult = {
      success: true,
      messagesFetched: newCount,
      hasMore,
      newCursor: top,
    };
    return value;
  } catch (err) {
    return resolveJobError(ctx, err);
  }
}

export async function processBackwardHistoryReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const chatId = job.chat_id;
  const peer = requestPeer(ctx, chatId);
  if ("result" in peer) return peer.result;

  const state = ctx.chatSyncState.get(chatId);
  if (state?.history_complete) {
    const value: RealJobResult = { success: true, messagesFetched: 0, historyComplete: true };
    return value;
  }

  const forwardCursor = state?.forward_cursor ?? null;
  let backwardCursor = state?.backward_cursor ?? null;
  if (forwardCursor !== null && (backwardCursor === null || backwardCursor > forwardCursor + 1)) {
    backwardCursor = forwardCursor + 1;
  }
  backwardCursor ??= 0;

  try {
    const messages = await fetchJobPage(ctx, chatId, peer.inputPeer, {
      offsetId: backwardCursor,
      limit: ctx.config.batchSize,
    });

    const bounds = {
      before: backwardCursor || undefined,
      reachedStart: messages.length < ctx.config.batchSize,
    };

    if (!ctx.messagesCache.participation.captures(chatId)) return PAUSED;
    if (messages.length === 0) {
      ctx.historyRanges.recordPage(chatId, [], bounds);
      ctx.chatSyncState.markHistoryComplete(chatId);
      ctx.chatSyncState.updateLastSync(chatId, "backward");
      const value: RealJobResult = { success: true, messagesFetched: 0, historyComplete: true };
      return value;
    }

    const ids = messages.map(rawMessageId).filter((id) => id > 0);
    const minId = ids.length > 0 ? Math.min(...ids) : backwardCursor;
    const inputs = createMessageInputs(messages, chatId);

    const write = ctx.messagesCache.upsertBatch(inputs);
    if (!ctx.messagesCache.participation.captures(chatId)) return PAUSED;
    const newCount = write.inserted;

    if (write.skipped === 0) {
      ctx.historyRanges.recordPage(chatId, messages.map(rawMessageId), bounds);
    }

    ctx.chatSyncState.updateBackwardCursor(chatId, minId);
    ctx.chatSyncState.incrementSyncedMessages(chatId, newCount);
    ctx.chatSyncState.updateLastSync(chatId, "backward");

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: newCount,
      cursor_end: minId,
    });

    const historyComplete =
      ids.length === 0 || minId <= 1 || messages.length < ctx.config.batchSize;
    if (historyComplete) {
      ctx.chatSyncState.markHistoryComplete(chatId);
    }

    const value: RealJobResult = {
      success: true,
      messagesFetched: newCount,
      hasMore: !historyComplete,
      newCursor: minId,
      historyComplete,
    };
    return value;
  } catch (err) {
    return resolveJobError(ctx, err);
  }
}

/**
 * The first page of a chat without a forward cursor: its newest messages.
 * It sets both cursors, so catch-up pages up from the newest message and
 * history pages down from the oldest. An empty chat gets cursors at 0, so
 * its first message is caught up from the start.
 */
export async function processInitialLoadReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const chatId = job.chat_id;

  if (!canMakeApiCall(ctx)) {
    const value: RealJobResult = {
      success: false,
      messagesFetched: 0,
      rateLimited: true,
      waitSeconds: getWaitTime(ctx),
    };
    return value;
  }

  const state = ctx.chatSyncState.get(chatId);
  if (state && state.forward_cursor !== null) {
    const value: RealJobResult = { success: true, messagesFetched: 0 };
    return value;
  }

  const peer = requestPeer(ctx, chatId);
  if ("result" in peer) return peer.result;

  try {
    const messages = await fetchJobPage(ctx, chatId, peer.inputPeer, {
      limit: ctx.config.batchSize,
    });

    const ids = messages.map(rawMessageId).filter((id) => id > 0);

    if (!ctx.messagesCache.participation.captures(chatId)) return PAUSED;
    if (ids.length === 0) {
      ctx.chatSyncState.recordFirstPage(chatId, {
        forward_cursor: 0,
        backward_cursor: 0,
        history_complete: true,
        new_messages: 0,
      });
      const value: RealJobResult = {
        success: true,
        messagesFetched: 0,
        newCursor: 0,
        historyComplete: true,
      };
      return value;
    }

    const maxId = Math.max(...ids);
    const minId = Math.min(...ids);
    const inputs = createMessageInputs(messages, chatId);

    const write = ctx.messagesCache.upsertBatch(inputs);
    if (!ctx.messagesCache.participation.captures(chatId)) return PAUSED;
    const newCount = write.inserted;

    const historyComplete = minId <= 1 || messages.length < ctx.config.batchSize;
    if (write.skipped === 0) {
      ctx.historyRanges.recordPage(chatId, messages.map(rawMessageId), {
        reachedStart: historyComplete,
      });
    }

    ctx.chatSyncState.recordFirstPage(chatId, {
      forward_cursor: maxId,
      backward_cursor: minId,
      history_complete: historyComplete,
      new_messages: newCount,
    });

    ctx.jobsService.updateProgress(job.id, {
      messages_fetched: newCount,
      cursor_start: maxId,
      cursor_end: minId,
    });

    const value: RealJobResult = {
      success: true,
      messagesFetched: newCount,
      newCursor: maxId,
      historyComplete,
    };
    return value;
  } catch (err) {
    return resolveJobError(ctx, err);
  }
}

/** Most message IDs one `getMessages` request asks for */
export const REFETCH_BATCH_SIZE = 100;

/**
 * Fetch again the chat's messages that an older version cached live with
 * raw_json '{}' (#130), up to 100 per request, and write them like a sync
 * page does: raw_json, attachments and the other columns. A message Telegram
 * no longer has stays as it is. The job starts above its `cursor_start`; if
 * '{}' rows are left above its batch (a full batch, or a live message cached
 * while it ran), it queues the next job above it, so the rows that stay '{}'
 * are asked for once.
 */
export async function processRefetchMessagesReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const chatId = job.chat_id;
  const after = job.cursor_start ?? 0;
  const ids = ctx.messagesCache.listEmptyRawJsonIds(chatId, after, REFETCH_BATCH_SIZE);
  if (ids.length === 0) {
    const value: RealJobResult = { success: true, messagesFetched: 0 };
    return value;
  }

  const peer = requestPeer(ctx, chatId);
  if ("result" in peer) return peer.result;

  try {
    const page = await fetchMessagesByIdRaw(ctx.client, peer.inputPeer, ids, ctx.signal);
    cachePageUsers(ctx.usersCache, page.users);

    const wanted = new Set(ids);
    const inputs = page.messages
      .filter(
        (message) =>
          wanted.has(rawMessageId(message)) &&
          toPeerIdFromRawPeer(
            (message as { peerId?: Parameters<typeof toPeerIdFromRawPeer>[0] }).peerId,
          ) === chatId,
      )
      .map((message) => parseRawMessage(message, chatId))
      .filter((input) => input !== null);
    const { written } = ctx.messagesCache.upsertBatch(inputs);

    const last = Math.max(...ids);
    ctx.jobsService.updateProgress(job.id, {
      cursor_start: last,
      messages_fetched: written,
    });
    const more = ctx.messagesCache.listEmptyRawJsonIds(chatId, last, 1);
    const queued = ctx.jobsService
      .getJobsForChat(chatId)
      .some(
        (other) =>
          other.job_type === SyncJobType.RefetchMessages && other.status === SyncJobStatus.Pending,
      );
    if (more.length > 0 && !queued) {
      ctx.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.RefetchMessages,
        priority: SyncPriority.Background,
        cursor_start: last,
      });
    }
    const value: RealJobResult = { success: true, messagesFetched: written };
    return value;
  } catch (err) {
    return resolveJobError(ctx, err);
  }
}

/**
 * Fetch senders missing from the cache (#143): ask Telegram for one message
 * of each of up to 100 of the chat's senders, by ID, and cache the senders
 * its reply carries; the messages themselves aren't written again. Senders
 * it doesn't return wait 30 days, as do those of a chat it refuses for good
 * (left, private). A chat with more senders waiting gets its next job at the
 * scheduler's next refresh.
 */
export async function processFetchSendersReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const batch = ctx.senderLookups.nextBatch(job.chat_id, REFETCH_BATCH_SIZE);
  if (batch.length === 0) {
    const value: RealJobResult = { success: true, messagesFetched: 0 };
    return value;
  }

  const senderIds = batch.map((lookup) => lookup.sender_id);
  const peer = requestPeer(ctx, job.chat_id);
  if ("result" in peer) {
    if (peer.result.permanent) ctx.senderLookups.finish(senderIds, Date.now());
    return peer.result;
  }

  try {
    const page = await fetchMessagesByIdRaw(
      ctx.client,
      peer.inputPeer,
      batch.map((lookup) => lookup.message_id),
      ctx.signal,
    );
    cachePageUsers(ctx.usersCache, page.users);
    ctx.senderLookups.finish(senderIds, Date.now());
    const value: RealJobResult = { success: true, messagesFetched: 0 };
    return value;
  } catch (err) {
    const result = resolveJobError(ctx, err);
    if (result.permanent) ctx.senderLookups.finish(senderIds, Date.now());
    return result;
  }
}

const PARTICIPATION_SEARCH_LIMIT = 10;

/**
 * Search the group for the account's own messages of the last 90 days and
 * record the newest ordinary one, or that there is none
 * (src/db/group-participation.ts). Only the date is kept: the messages go
 * through no write here. An error records nothing, so the state stays as
 * it was; the job is retried like any other.
 */
export async function processCheckGroupParticipationReal(
  ctx: RealSyncWorkerContext,
  job: SyncJobRow,
) {
  const chatId = job.chat_id;
  const peer = requestPeer(ctx, chatId);
  if ("result" in peer) return peer.result;

  try {
    ctx.signal?.throwIfAborted();
    const since = nowSeconds() - PARTICIPATION_WINDOW_SECONDS;
    const request: tl.messages.RawSearchRequest = {
      _: "messages.search",
      peer: peer.inputPeer,
      q: "",
      fromId: { _: "inputPeerSelf" },
      filter: { _: "inputMessagesFilterEmpty" },
      minDate: since,
      maxDate: 0,
      offsetId: 0,
      addOffset: 0,
      limit: PARTICIPATION_SEARCH_LIMIT,
      maxId: 0,
      minId: 0,
      hash: toLong(0),
    };
    const result = ctx.signal
      ? await ctx.client.call(request, { abortSignal: ctx.signal })
      : await ctx.client.call(request);
    const found = ("messages" in result ? result.messages : [])
      .map((message) => parseRawMessage(message, chatId))
      .filter((input) => input !== null && isOwnOrdinaryMessage(input) && input.date >= since)
      .map((input) => input!.date);
    const newest = found.length > 0 ? Math.max(...found) : null;
    ctx.messagesCache.participation.recordCheck(chatId, newest);
    const value: RealJobResult = { success: true, messagesFetched: 0 };
    return value;
  } catch (err) {
    return resolveJobError(ctx, err);
  }
}

async function processFullSyncReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const result = await processInitialLoadReal(ctx, job);
  if (result.success && !result.historyComplete) {
    const value: RealJobResult = { ...result, hasMore: true };
    return value;
  }
  return result;
}

const JOB_HANDLERS: Partial<
  Record<SyncJobType, (ctx: RealSyncWorkerContext, job: SyncJobRow) => Promise<RealJobResult>>
> = {
  [SyncJobType.ForwardCatchup]: processForwardCatchupReal,
  [SyncJobType.BackwardHistory]: processBackwardHistoryReal,
  [SyncJobType.InitialLoad]: processInitialLoadReal,
  [SyncJobType.FullSync]: processFullSyncReal,
  [SyncJobType.RefetchMessages]: processRefetchMessagesReal,
  [SyncJobType.FetchSenders]: processFetchSendersReal,
  [SyncJobType.CheckGroupParticipation]: processCheckGroupParticipationReal,
};

export async function processJobReal(ctx: RealSyncWorkerContext, job: SyncJobRow) {
  const handlers =
    !CHAT_INDEPENDENT_JOB_TYPES.includes(job.job_type) &&
    !ctx.messagesCache.participation.captures(job.chat_id)
      ? { [job.job_type]: async () => PAUSED }
      : JOB_HANDLERS;
  return processJobWithHandlers(ctx, job, handlers, (jobType) => ({
    success: false,
    messagesFetched: 0,
    error: `Unknown job type: ${jobType}`,
    permanent: true,
  }));
}
