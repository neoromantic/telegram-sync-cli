import type { tl } from '@mtcute/bun'
import { isDaemonStopError } from './daemon-utils'
import { isPermanentSyncError } from './sync-retry'
import {
  buildInputPeer,
  extractFloodWaitSeconds,
} from './sync-worker-real-helpers'
import type {
  RealJobResult,
  RealSyncWorkerContext,
} from './sync-worker-real-types'

export function canMakeApiCall(ctx: RealSyncWorkerContext): boolean {
  return !ctx.rateLimits.isBlocked(ctx.config.apiMethod)
}

export function getWaitTime(ctx: RealSyncWorkerContext): number {
  return ctx.rateLimits.getWaitTime(ctx.config.apiMethod)
}

export function handleFloodWait(
  ctx: RealSyncWorkerContext,
  seconds: number,
): void {
  ctx.rateLimits.setFloodWait(ctx.config.apiMethod, seconds)
}

export function getInputPeer(
  ctx: RealSyncWorkerContext,
  chatId: number,
): tl.TypeInputPeer | null {
  return buildInputPeer(chatId, ctx.chatsCache)
}

export function resolveFloodWaitResult(
  ctx: RealSyncWorkerContext,
  err: unknown,
): RealJobResult | null {
  const error = err instanceof Error ? err : new Error(String(err))
  const floodWaitSeconds = extractFloodWaitSeconds(error)
  if (floodWaitSeconds === null) {
    return null
  }

  // FLOOD_WAIT_0 still asks for a pause: wait at least a second.
  const seconds = Math.max(1, floodWaitSeconds)
  handleFloodWait(ctx, seconds)
  return {
    success: false,
    messagesFetched: 0,
    rateLimited: true,
    waitSeconds: seconds,
  }
}

/**
 * The result of a job whose request failed. A request the daemon stop cut
 * short is no failure: the job is pending again as it was. A FLOOD_WAIT
 * defers the job; any other error fails it, for good if it is permanent.
 */
export function resolveJobError(
  ctx: RealSyncWorkerContext,
  err: unknown,
): RealJobResult {
  if (isDaemonStopError(err)) {
    return { success: false, messagesFetched: 0, stopped: true }
  }
  const floodResult = resolveFloodWaitResult(ctx, err)
  if (floodResult) {
    return floodResult
  }
  const error = err instanceof Error ? err : new Error(String(err))
  return {
    success: false,
    messagesFetched: 0,
    error: error.message,
    permanent: isPermanentSyncError(err),
  }
}
