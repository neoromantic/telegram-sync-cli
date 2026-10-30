/**
 * Every API call of the daemon's clients goes to the account's rate window
 * and api_activity (#127): sync pages, contacts checks, dialog passes, the
 * joined-communities check, getMe at start, reconnect and health checks,
 * and mtcute's own calls (updates.getDifference and the like). A network
 * middleware sees each request mtcute sends, whichever method made it.
 */
import type { Database } from 'bun:sqlite'
import type { RpcCallMiddleware } from '@mtcute/bun'
import {
  createRateLimitsService,
  type RateLimitsService,
} from '../db/rate-limits'
import { getErrorMessage } from './daemon-utils'

/** What a call's activity row goes into, or null to log nothing */
export type ActivityTarget = () => Database | null

/** An RPC error mtcute's network layer returns instead of throwing */
function rpcErrorOf(
  result: unknown,
): { errorCode: number; errorMessage: string } | null {
  const value = result as {
    _?: unknown
    errorCode?: unknown
    errorMessage?: unknown
  } | null
  if (value?._ !== 'mt_rpc_error') return null
  return {
    errorCode: Number(value.errorCode),
    errorMessage: String(value.errorMessage),
  }
}

/**
 * Count each request in its rate window and log it to api_activity: its
 * start in ms, success, Telegram's error code and how long it took. It sits
 * inside the flood waiter, so a FLOOD_WAIT and the retry after it are two
 * rows. A write that fails (a locked cache) never fails the request.
 */
export function apiActivityMiddleware(
  target: ActivityTarget,
  context = 'daemon',
): RpcCallMiddleware {
  const services = new WeakMap<Database, RateLimitsService>()
  const serviceFor = (db: Database) => {
    let service = services.get(db)
    if (!service) {
      service = createRateLimitsService(db)
      services.set(db, service)
    }
    return service
  }

  return async (ctx, next) => {
    const db = target()
    let rateLimits: RateLimitsService
    try {
      if (!db) return next(ctx)
      rateLimits = serviceFor(db)
    } catch {
      // A cache that can't be written to still lets the request through
      return next(ctx)
    }
    const method = ctx.request._
    const start = rateLimits.now()
    const log = (
      success: number,
      errorCode: number | null,
      message: string | null,
    ) => {
      try {
        rateLimits.logActivity({
          timestamp: start,
          method,
          success,
          error_code: errorCode,
          response_ms: rateLimits.now() - start,
          context: message ?? context,
        })
      } catch {
        // The request's outcome matters more than its log line
      }
    }
    try {
      rateLimits.recordCall(method)
    } catch {
      // Same as above
    }

    try {
      const result = await next(ctx)
      const error = rpcErrorOf(result)
      if (error) log(0, error.errorCode, error.errorMessage)
      else log(1, null, null)
      return result
    } catch (err) {
      log(0, null, getErrorMessage(err))
      throw err
    }
  }
}
