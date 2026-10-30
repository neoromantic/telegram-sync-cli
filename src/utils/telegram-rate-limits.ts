import type { Database } from 'bun:sqlite'
import { type TelegramClient, tl } from '@mtcute/bun'
import { getAccountCacheDb } from '../db'
import {
  createRateLimitsService,
  type RateLimitsService,
} from '../db/rate-limits'

export class RateLimitError extends Error {
  readonly method: string
  readonly waitSeconds: number

  constructor(method: string, waitSeconds: number, options?: ErrorOptions) {
    super(`Rate limited for ${method}: wait ${waitSeconds}s`, options)
    this.name = 'RateLimitError'
    this.method = method
    this.waitSeconds = waitSeconds
  }
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError
}

const services = new Map<number, { db: Database; service: RateLimitsService }>()

/**
 * The account's rate limits, kept in its own cache: the CLI and the daemon
 * coordinate per account, and a FLOOD_WAIT one account recorded never
 * blocks another
 */
export function getRateLimitsService(accountId: number): RateLimitsService {
  const db = getAccountCacheDb(accountId)
  const cached = services.get(accountId)
  if (cached && cached.db === db) return cached.service
  const service = createRateLimitsService(db)
  services.set(accountId, { db, service })
  return service
}

function extractFloodWaitSeconds(error: unknown): number | null {
  if (error instanceof Error) {
    const match = error.message.match(/FLOOD_WAIT_(\d+)/)
    if (match?.[1]) {
      return parseInt(match[1], 10)
    }

    const waitMatch = error.message.match(/[Ww]ait of (\d+) seconds/)
    if (waitMatch?.[1]) {
      return parseInt(waitMatch[1], 10)
    }
  }

  const anyError = error as { seconds?: number }
  if (typeof anyError?.seconds === 'number') {
    return anyError.seconds
  }

  return null
}

/** A FLOOD_WAIT from Telegram, as opposed to another error that has seconds */
function isFloodWait(error: unknown): boolean {
  if (tl.RpcError.is(error)) return error.code === tl.RpcError.FLOOD
  return error instanceof Error && /FLOOD_WAIT_\d+/.test(error.message)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return String(error)
}

/** Telegram's error code (420 for a FLOOD_WAIT), or null for another error */
function apiErrorCode(error: unknown): number | null {
  if (tl.RpcError.is(error)) return error.code
  return extractFloodWaitSeconds(error) ? tl.RpcError.FLOOD : null
}

/**
 * Make one API call and account for it: count it in its rate window, and
 * log it to api_activity when it ends, with when it started (ms), whether
 * it succeeded, Telegram's error code and how long it took. A FLOOD_WAIT it
 * fails with is recorded, so the method's next calls wait it out. The
 * call's result or error passes through.
 */
export async function trackApiCall<T>(
  rateLimits: RateLimitsService,
  method: string,
  call: () => Promise<T>,
  context?: string,
): Promise<T> {
  const start = rateLimits.now()
  rateLimits.recordCall(method)

  try {
    const result = await call()
    rateLimits.logActivity({
      timestamp: start,
      method,
      success: 1,
      response_ms: rateLimits.now() - start,
      context,
    })
    return result
  } catch (err) {
    const waitSeconds = extractFloodWaitSeconds(err)
    if (waitSeconds) {
      rateLimits.setFloodWait(method, waitSeconds)
    }

    rateLimits.logActivity({
      timestamp: start,
      method,
      success: 0,
      error_code: apiErrorCode(err),
      response_ms: rateLimits.now() - start,
      context: getErrorMessage(err),
    })
    throw err
  }
}

async function callWithRateLimits<T>({
  method,
  call,
  rateLimits,
  context,
}: {
  method: string
  call: () => Promise<T>
  rateLimits: RateLimitsService
  context?: string
}): Promise<T> {
  if (rateLimits.isBlocked(method)) {
    throw new RateLimitError(method, rateLimits.getWaitTime(method))
  }

  try {
    return await trackApiCall(rateLimits, method, call, context)
  } catch (err) {
    const waitSeconds = extractFloodWaitSeconds(err)
    // The first flood wait reads like a call to a method that is blocked
    if (waitSeconds && isFloodWait(err)) {
      throw new RateLimitError(method, waitSeconds, { cause: err })
    }
    throw err
  }
}

type ClientCallRequest = Parameters<TelegramClient['call']>[0]
type ClientCallOptions = Parameters<TelegramClient['call']>[1]

export type RateLimitsTarget = { context?: string } & (
  | { accountId: number; rateLimits?: undefined }
  | { rateLimits: RateLimitsService; accountId?: undefined }
)

/**
 * Check and record every call of the client in the rate limits of the
 * account it belongs to
 */
export function wrapClientCallWithRateLimits(
  client: TelegramClient,
  options: RateLimitsTarget,
): TelegramClient {
  const rateLimits =
    options.rateLimits === undefined
      ? getRateLimitsService(options.accountId)
      : options.rateLimits
  const clientAny = client as TelegramClient & {
    __rateLimitWrapped?: boolean
    __rateLimitContext?: string
    __rateLimitOriginalCall?: TelegramClient['call']
  }

  if (clientAny.__rateLimitWrapped) {
    if (options.context) {
      clientAny.__rateLimitContext = options.context
    }
    return client
  }

  clientAny.__rateLimitWrapped = true
  clientAny.__rateLimitContext = options.context
  const originalCall = client.call.bind(client)
  clientAny.__rateLimitOriginalCall = originalCall

  clientAny.call = (async (
    request: ClientCallRequest,
    callOptions?: ClientCallOptions,
  ) => {
    const method = request._ ?? 'unknown'
    return callWithRateLimits({
      method,
      rateLimits,
      context: clientAny.__rateLimitContext,
      call: () => originalCall(request, callOptions),
    })
  }) as TelegramClient['call']

  return client
}
