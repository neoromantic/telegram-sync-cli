/**
 * Tests for the rate-limit wrapper around client.call
 * (src/utils/telegram-rate-limits.ts)
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'

import {
  createRateLimitsService,
  type RateLimitsService,
} from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import {
  RateLimitError,
  wrapClientCallWithRateLimits,
} from '../utils/telegram-rate-limits'

const METHOD = 'messages.getHistory'

describe('wrapClientCallWithRateLimits', () => {
  let db: Database
  let rateLimits: RateLimitsService

  beforeEach(() => {
    db = createTestCacheDatabase().db
    rateLimits = createRateLimitsService(db)
  })

  afterEach(() => {
    db.close()
  })

  function wrap(failure: unknown) {
    const call = mock(async () => {
      throw failure
    })
    const client = wrapClientCallWithRateLimits(
      { call } as unknown as TelegramClient,
      { rateLimits },
    )
    const request = { _: METHOD } as unknown as Parameters<
      TelegramClient['call']
    >[0]
    return { call, send: () => client.call(request) }
  }

  async function failureOf(send: () => Promise<unknown>): Promise<unknown> {
    try {
      await send()
    } catch (err) {
      return err
    }
    throw new Error('expected the call to fail')
  }

  it('reports the first FLOOD_WAIT as a rate limit for the method', async () => {
    const flood = tl.RpcError.fromTl({
      _: 'rpc_error',
      errorCode: 420,
      errorMessage: 'FLOOD_WAIT_30',
    })
    const { call, send } = wrap(flood)

    const first = await failureOf(send)

    expect(first).toBeInstanceOf(RateLimitError)
    expect(first).toMatchObject({ method: METHOD, waitSeconds: 30 })
    expect((first as Error).cause).toBe(flood)
    expect(rateLimits.isBlocked(METHOD)).toBe(true)

    // The next call doesn't reach Telegram
    const second = await failureOf(send)
    expect(second).toBeInstanceOf(RateLimitError)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an RPC error', new tl.RpcError(400, 'PEER_ID_INVALID')],
    [
      'an RPC error with seconds that is not a flood wait',
      tl.RpcError.fromTl({
        _: 'rpc_error',
        errorCode: 400,
        errorMessage: 'SESSION_TOO_FRESH_60',
      }),
    ],
    ['a lost connection', new Error('Connection closed')],
  ])('passes on %s as it is', async (_name, failure) => {
    const { send } = wrap(failure)

    expect(await failureOf(send)).toBe(failure)
  })
})
