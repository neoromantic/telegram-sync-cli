import type { Database } from 'bun:sqlite'
import type { TelegramClient } from '@mtcute/bun'
import { getCacheDb } from '../db'
import {
  createRateLimitsService,
  type RateLimitsService,
} from '../db/rate-limits'

export class RateLimitError extends Error {
  readonly method: string
  readonly waitSeconds: number

  constructor(method: string, waitSeconds: number) {
    super(`Rate limited for ${method}: wait ${waitSeconds}s`)
    this.name = 'RateLimitError'
    this.method = method
    this.waitSeconds = waitSeconds
  }
}

export function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError
}

let cachedDb: Database | null = null
let cachedService: RateLimitsService | null = null

export function getRateLimitsService(): RateLimitsService {
  const db = getCacheDb()
  if (!cachedService || cachedDb !== db) {
    cachedDb = db
    cachedService = createRateLimitsService(db)
  }
  return cachedService
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

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return String(error)
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

  const start = Date.now()
  const timestamp = Math.floor(start / 1000)
  rateLimits.recordCall(method)

  try {
    const result = await call()
    rateLimits.logActivity({
      timestamp,
      method,
      success: 1,
      response_ms: Date.now() - start,
      context,
    })
    return result
  } catch (err) {
    const waitSeconds = extractFloodWaitSeconds(err)
    if (waitSeconds) {
      rateLimits.setFloodWait(method, waitSeconds)
    }

    rateLimits.logActivity({
      timestamp,
      method,
      success: 0,
      error_code: waitSeconds ? 420 : null,
      response_ms: Date.now() - start,
      context: getErrorMessage(err),
    })
    throw err
  }
}

type ClientCallRequest = Parameters<TelegramClient['call']>[0]
type ClientCallOptions = Parameters<TelegramClient['call']>[1]

export function wrapClientCallWithRateLimits(
  client: TelegramClient,
  options: {
    context?: string
    rateLimits?: RateLimitsService
  } = {},
): TelegramClient {
  const rateLimits = options.rateLimits ?? getRateLimitsService()
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
