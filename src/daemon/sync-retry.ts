/**
 * When a failed sync job runs again, and which errors never go away.
 *
 * The daemon's client already waits out short FLOOD_WAITs and retries
 * server errors inside the call, so a job sees only what that left over:
 * long FLOOD_WAITs (a delay, handled by the worker, not here), 4xx errors,
 * network errors and timeouts, and local errors.
 */
import { tl } from '@mtcute/bun'
import { calculateReconnectDelay } from './daemon-utils'
import type { ReconnectConfig } from './types'

/**
 * Backoff for failed sync jobs: 1, 2, 4 and 8 minutes, and the fifth failure
 * is final. Not a config.json key: it isn't a TTL.
 */
export const SYNC_RETRY_CONFIG: ReconnectConfig = {
  initialDelayMs: 60_000,
  backoffMultiplier: 2,
  maxDelayMs: 8 * 60_000,
  maxAttempts: 5,
}

/** The wait before the next try of a job that failed `failures` times */
export function retryDelayMs(failures: number): number {
  return calculateReconnectDelay(failures, SYNC_RETRY_CONFIG)
}

/** RPC error codes that the same request gets again on every try */
const PERMANENT_RPC_CODES = [400, 403, 404]

/**
 * An error that a retry can't fix: a 400, 403 or 404 RPC error, or
 * CHANNEL_PRIVATE with any code. Everything else is transient, including 401
 * and 406, which are about the account and are left to the connection
 * health check.
 */
export function isPermanentSyncError(err: unknown): boolean {
  if (!tl.RpcError.is(err)) return false
  return (
    PERMANENT_RPC_CODES.includes(err.code) || err.text === 'CHANNEL_PRIVATE'
  )
}
