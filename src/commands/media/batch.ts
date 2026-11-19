import { setTimeout as sleep, setImmediate as yieldToIO } from "node:timers/promises";
import type { TelegramClient } from "@mtcute/bun";

import { ErrorCodes } from "../../types";
import { extractAttachment } from "../../utils/attachment";
import { info } from "../../utils/output";
import { describeRateLimit, isRateLimitError } from "../../utils/telegram-rate-limits";
import { resolveHistoryChat } from "../messages/history";
import {
  type DownloadDeps,
  type DownloadResult,
  downloadOnline,
  readFromCache,
} from "./download-media";
import { checkDownloadInterrupted, MediaError } from "./errors";
import { type FetchedMessage, fetchMessagesById, messageNotFound } from "./fetch";

/**
 * Telegram's soft limits for files downloaded in parallel from one DC
 * (small_queue_max_active_operations_count and
 * large_queue_max_active_operations_count, https://core.telegram.org/api/config)
 */
export const MAX_PARALLEL_FILES = 5;
export const MAX_PARALLEL_LARGE_FILES = 2;
export const LARGE_FILE_BYTES = 20 * 1024 * 1024;
const IDS_PER_FETCH = 100;
/** Longer flood waits fail the files instead of pausing the batch */
export const MAX_BATCH_FLOOD_WAIT_SECONDS = 300;
const MAX_RETRIES = 5;

export interface BatchRequest {
  chat: string;
  messageIds: number[];
  thumb: boolean;
  fresh: boolean;
}

export interface FileFailure {
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes];
  message: string;
  details: Record<string, unknown>;
  suggestion?: string;
  retryable: boolean;
}

/** What the command does with each file as it finishes */
export interface BatchHandlers {
  /** Copy or print a downloaded file; throws a MediaError to fail it */
  done: (result: DownloadResult) => Promise<void>;
  failed: (messageId: number, failure: FileFailure) => void;
}

function rateLimitWait(err: unknown) {
  if (isRateLimitError(err)) {
    return { method: err.method, seconds: err.waitSeconds };
  }
  if (err instanceof MediaError && err.code === ErrorCodes.RATE_LIMITED) {
    return {
      method: String(err.details.method),
      seconds: Number(err.details.wait_seconds),
    };
  }
  return null;
}

function failureOf(chatId: number, messageId: number, err: unknown) {
  if (isRateLimitError(err)) {
    const { message, details, suggestion } = describeRateLimit(err.method, err.waitSeconds);
    err = new MediaError(ErrorCodes.RATE_LIMITED, message, details, suggestion);
  }
  const failure =
    err instanceof MediaError
      ? err
      : new MediaError(
          ErrorCodes.TELEGRAM_ERROR,
          `Failed to download media: ${err instanceof Error ? err.message : "Unknown error"}`,
          {},
        );
  return {
    code: failure.code,
    message: failure.message,
    details: { chatId, messageId, ...failure.details },
    suggestion: failure.suggestion,
    retryable: failure.retryable,
  } satisfies FileFailure;
}

function batchTransfers(client: TelegramClient, signal?: AbortSignal) {
  let until = 0;
  const paused = new Error("Batch paused");
  const facade = Object.create(client) as TelegramClient;
  let fullUser: Promise<unknown> | undefined;
  class ObservedWait extends Error {}
  function pause(err: unknown) {
    const wait = rateLimitWait(err);
    if (!wait || wait.seconds > MAX_BATCH_FLOOD_WAIT_SECONDS) return false;
    const now = Date.now();
    if (until <= now) {
      info(`[flood-wait] ${wait.method}: pausing the batch for ${wait.seconds}s`);
    }
    until = Math.max(until, now + wait.seconds * 1000);
    return true;
  }
  facade.call = (async (request, options) => {
    signal?.throwIfAborted();
    if (Date.now() < until) throw paused;
    const call = () =>
      client.call(request, { ...options, floodSleepThreshold: 0 }).catch((err) => {
        if (pause(err)) throw new ObservedWait("Flood wait", { cause: err });
        throw err;
      });
    if (request._ !== "users.getFullUser") return call();
    fullUser ??= call().catch((err) => {
      fullUser = undefined;
      throw err;
    });
    return fullUser;
  }) as TelegramClient["call"];

  async function retry<T>(action: () => Promise<T>, parts: () => number = () => 0) {
    let waits = 0;
    let seen = parts();
    for (;;) {
      signal?.throwIfAborted();
      const delay = until - Date.now();
      if (delay > 0) {
        await sleep(delay, undefined, { signal });
        continue;
      }
      try {
        return await action();
      } catch (err) {
        if (err === paused) continue;
        if (!(err instanceof ObservedWait) && !pause(err)) throw err;
        if (parts() > seen) {
          seen = parts();
          waits = 0;
        }
        if (++waits > MAX_RETRIES) {
          throw err instanceof ObservedWait ? err.cause : err;
        }
      }
    }
  }
  return { client: facade, retry };
}

export async function downloadBatch(
  deps: DownloadDeps,
  request: BatchRequest,
  handlers: BatchHandlers,
) {
  const chat = await resolveHistoryChat(deps.history.client, request.chat, deps.history);
  const single = (messageId: number) => ({ ...request, messageId });
  let failures = 0;
  const fail = (id: number, err: unknown) => {
    handlers.failed(id, failureOf(chat.chatId, id, err));
    failures++;
  };
  const online: number[] = [];
  for (const id of request.messageIds) {
    checkDownloadInterrupted(deps.signal);
    try {
      const hit = !request.fresh && readFromCache(deps, chat, single(id));
      if (hit) await handlers.done(hit);
      else online.push(id);
    } catch (err) {
      checkDownloadInterrupted(deps.signal);
      fail(id, err);
    }
    await yieldToIO();
  }
  checkDownloadInterrupted(deps.signal);
  if (!online.length) return failures;

  const { client, retry } = batchTransfers(deps.getClient(), deps.signal);
  const fileDeps = { ...deps, getClient: () => client };
  for (let at = 0; at < online.length; at += IDS_PER_FETCH) {
    const ids = online.slice(at, at + IDS_PER_FETCH);
    let page: Map<number, FetchedMessage>;
    try {
      page = await retry(() => fetchMessagesById(client, chat, ids, deps.signal));
    } catch (err) {
      checkDownloadInterrupted(deps.signal);
      for (const id of ids) fail(id, err);
      continue;
    }
    const fetchedAt = (deps.now ?? Date.now)();
    const small: FetchedMessage[] = [];
    const large: FetchedMessage[] = [];
    for (const id of ids) {
      const item = page.get(id);
      if (!item) {
        fail(id, messageNotFound(chat.chatId, id));
        continue;
      }
      const size = request.thumb ? 0 : (extractAttachment(item.message)?.size ?? 0);
      const queue = size >= LARGE_FILE_BYTES ? large : small;
      queue.push({ ...item, fetchedAt });
    }
    const worker = async (takesLarge: boolean) => {
      while (!deps.signal?.aborted) {
        const item = (takesLarge && large.shift()) || small.shift();
        if (!item) return;
        const id = item.message.id;
        let parts = 0;
        const counted = { ...fileDeps, progress: () => () => void parts++ };
        try {
          const result = await retry(
            () => downloadOnline(counted, chat, single(id), item),
            () => parts,
          );
          checkDownloadInterrupted(deps.signal);
          await handlers.done(result);
        } catch (err) {
          if (deps.signal?.aborted) return;
          fail(id, err);
        }
      }
    };
    await Promise.all(
      Array.from({ length: MAX_PARALLEL_FILES }, (_, i) => worker(i < MAX_PARALLEL_LARGE_FILES)),
    );
    checkDownloadInterrupted(deps.signal);
  }
  return failures;
}
