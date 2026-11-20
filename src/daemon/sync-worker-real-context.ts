import type { tl } from "@mtcute/bun";
import { isDaemonStopError } from "./daemon-utils";
import { buildInputPeer, extractFloodWaitSeconds } from "./sync-worker-real-helpers";
import type { RealJobResult, RealSyncWorkerContext } from "./sync-worker-real-types";
import { isPermanentSyncError } from "./sync-worker-utils";

export function canMakeApiCall(ctx: RealSyncWorkerContext) {
  return !ctx.rateLimits.isBlocked(ctx.config.apiMethod);
}

export function getWaitTime(ctx: RealSyncWorkerContext) {
  return ctx.rateLimits.getWaitTime(ctx.config.apiMethod);
}

function handleFloodWait(ctx: RealSyncWorkerContext, seconds: number) {
  ctx.rateLimits.setFloodWait(ctx.config.apiMethod, seconds);
}

type PeerRequest = { inputPeer: tl.TypeInputPeer } | { result: RealJobResult };

/**
 * The chat's InputPeer for a job's request, or the job's result when it
 * can't make one: deferred while the API method is rate limited, failed for
 * good when the cache can't build the peer.
 */
export function requestPeer(ctx: RealSyncWorkerContext, chatId: number) {
  if (!canMakeApiCall(ctx)) {
    const request: PeerRequest = {
      result: {
        success: false,
        messagesFetched: 0,
        rateLimited: true,
        waitSeconds: getWaitTime(ctx),
      },
    };
    return request;
  }
  const inputPeer = buildInputPeer(chatId, ctx.chatsCache);
  if (!inputPeer) {
    const request: PeerRequest = {
      result: {
        success: false,
        messagesFetched: 0,
        error: `Could not build InputPeer for chat ${chatId}`,
        permanent: true,
      },
    };
    return request;
  }
  const request: PeerRequest = { inputPeer };
  return request;
}

export function resolveFloodWaitResult(ctx: RealSyncWorkerContext, err: unknown) {
  const error = err instanceof Error ? err : new Error(String(err));
  const floodWaitSeconds = extractFloodWaitSeconds(error);
  if (floodWaitSeconds === null) {
    const result: RealJobResult | null = null;
    return result;
  }

  const seconds = Math.max(1, floodWaitSeconds);
  handleFloodWait(ctx, seconds);
  const result: RealJobResult | null = {
    success: false,
    messagesFetched: 0,
    rateLimited: true,
    waitSeconds: seconds,
  };
  return result;
}

/**
 * The result of a job whose request failed. A request the daemon stop cut
 * short is no failure: the job is pending again as it was. A FLOOD_WAIT
 * defers the job; any other error fails it, for good if it is permanent.
 */
export function resolveJobError(ctx: RealSyncWorkerContext, err: unknown) {
  if (isDaemonStopError(err)) {
    const result: RealJobResult = { success: false, messagesFetched: 0, stopped: true };
    return result;
  }
  const floodResult = resolveFloodWaitResult(ctx, err);
  if (floodResult) return floodResult;
  const error = err instanceof Error ? err : new Error(String(err));
  const result: RealJobResult = {
    success: false,
    messagesFetched: 0,
    error: error.message,
    permanent: isPermanentSyncError(err),
  };
  return result;
}
