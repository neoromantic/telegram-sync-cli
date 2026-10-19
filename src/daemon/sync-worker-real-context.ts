import type { tl } from '@mtcute/bun'
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

export function recordApiCall(ctx: RealSyncWorkerContext): void {
  ctx.rateLimits.recordCall(ctx.config.apiMethod)
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
  if (!floodWaitSeconds) {
    return null
  }

  handleFloodWait(ctx, floodWaitSeconds)
  return {
    success: false,
    messagesFetched: 0,
    rateLimited: true,
    waitSeconds: floodWaitSeconds,
  }
}
