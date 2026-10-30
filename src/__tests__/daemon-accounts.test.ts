/**
 * Unit tests for daemon account helpers (no getCacheDb dependency)
 */
import { describe, expect, it, mock } from 'bun:test'
import type {
  DeleteMessageUpdate,
  Message,
  RawUpdateInfo,
  RpcCallMiddleware,
  RpcCallMiddlewareContext,
  TelegramClient,
  tl,
} from '@mtcute/bun'
import {
  closeClientSafe,
  daemonNetworkMiddlewares,
  removeEventHandlers,
  resolveRealtimeMessageType,
  resolveSyncChatType,
  scheduleReconnect,
  setupSignalHandlers,
} from '../daemon/daemon-accounts'
import { floodWaitSecondsOf } from '../daemon/daemon-api-activity'
import {
  type AccountRuntime,
  createDaemonRuntime,
  type DaemonContext,
  requestShutdown,
} from '../daemon/daemon-context'
import { isDaemonStopError } from '../daemon/daemon-utils'
import { createSyncPacer } from '../daemon/sync-pacing'
import type { AccountConnectionState } from '../daemon/types'
import { createRateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'

class MockEmitter<T> {
  handlers: Array<(value: T) => void> = []
  get length() {
    return this.handlers.length
  }
  add = (handler: (value: T) => void) => {
    this.handlers.push(handler)
  }
  remove = (handler: (value: T) => void) => {
    this.handlers = this.handlers.filter((entry) => entry !== handler)
  }
  emit = (value: T) => {
    for (const handler of this.handlers) {
      handler(value)
    }
  }
  once = (handler: (value: T) => void) => {
    const wrapper = (value: T) => {
      this.remove(wrapper)
      handler(value)
    }
    this.add(wrapper)
  }
  listeners = () => this.handlers
  clear = () => {
    this.handlers = []
  }
  forwardTo = (_emitter: MockEmitter<T>) => {}
}

const createClientWithEvents = (): TelegramClient => {
  const client = {
    onNewMessage: new MockEmitter<Message>(),
    onEditMessage: new MockEmitter<Message>(),
    onDeleteMessage: new MockEmitter<DeleteMessageUpdate>(),
    onRawUpdate: new MockEmitter<RawUpdateInfo>(),
    onConnectionState: new MockEmitter<string>(),
  }

  return client as unknown as TelegramClient
}

const asTelegramClient = (client: unknown): TelegramClient =>
  client as TelegramClient

function createLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

function createContext(): DaemonContext {
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli.pid',
    verbosity: 'normal',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 2,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: createLogger(),
    pidFile: {
      acquire: () => {},
      release: () => {},
      read: () => null,
      isRunning: () => false,
      sendSignal: () => false,
      getPath: () => '/tmp/tgcli.pid',
    },
    state: {
      running: true,
      accounts: new Map(),
      shutdownRequested: false,
    },
    accountsDb: {
      getAll: () => [],
      getById: () => null,
      getByPhone: () => null,
      getByUserId: () => null,
      getByUsername: () => null,
      getAllByLabel: () => [],
      getActive: () => null,
      create: () => {
        throw new Error('not used')
      },
      update: () => null,
      updateSession: () => {},
      setActive: () => {},
      delete: () => false,
      count: () => 0,
    },
    runtime: createDaemonRuntime(),
  }
}

describe('removeEventHandlers', () => {
  it('clears handlers and unregisters events', () => {
    const ctx = createContext()
    const client = createClientWithEvents()

    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+10000000000',
      name: null,
      status: 'connected',
      client,
      eventHandlers: {
        onNewMessage: () => {},
        onEditMessage: () => {},
        onDeleteMessage: () => {},
        onRawUpdate: () => {},
        onConnectionState: () => {},
      },
    }
    const raw = (
      client as unknown as { onRawUpdate: MockEmitter<RawUpdateInfo> }
    ).onRawUpdate
    raw.add(accountState.eventHandlers!.onRawUpdate)

    removeEventHandlers(ctx, accountState)

    expect(raw.handlers).toHaveLength(0)
    expect(accountState.eventHandlers).toBeUndefined()
    expect(accountState.updateHandlers).toBeUndefined()
  })
})

describe('reconnect scheduling', () => {
  it('schedules next reconnect when under max attempts', () => {
    const ctx = createContext()
    const accountState: AccountConnectionState = {
      accountId: 2,
      phone: '+12223334444',
      name: null,
      status: 'error',
      reconnectAttempts: 0,
    }

    scheduleReconnect(ctx, accountState)

    expect(accountState.reconnectAttempts).toBe(1)
    expect(accountState.nextReconnectAt).toBeDefined()
  })

  it('does not schedule reconnect after max attempts', () => {
    const ctx = createContext()
    const accountState: AccountConnectionState = {
      accountId: 3,
      phone: '+19990000000',
      name: null,
      status: 'error',
      reconnectAttempts: 2,
    }

    scheduleReconnect(ctx, accountState)

    expect(accountState.nextReconnectAt).toBeUndefined()
  })
})

describe('resolveRealtimeMessageType', () => {
  it('returns service type for service messages', () => {
    const result = resolveRealtimeMessageType({ isService: true })
    expect(result).toEqual({ messageType: 'service', hasMedia: false })
  })

  it('returns service type for service messages even with media present', () => {
    const result = resolveRealtimeMessageType({
      isService: true,
      media: { type: 'photo' },
    })
    expect(result).toEqual({ messageType: 'service', hasMedia: false })
  })

  it('returns text type for messages without media', () => {
    const result = resolveRealtimeMessageType({})
    expect(result).toEqual({ messageType: 'text', hasMedia: false })
  })

  it('returns text type for messages with null media', () => {
    const result = resolveRealtimeMessageType({ media: null })
    expect(result).toEqual({ messageType: 'text', hasMedia: false })
  })

  it('returns unknown type for media without type property', () => {
    const result = resolveRealtimeMessageType({ media: {} })
    expect(result).toEqual({ messageType: 'unknown', hasMedia: true })
  })

  it('returns unknown type for unrecognized media types', () => {
    const result = resolveRealtimeMessageType({
      media: { type: 'bizarre_new_type' },
    })
    expect(result).toEqual({ messageType: 'unknown', hasMedia: true })
  })

  it('maps known media types correctly', () => {
    const knownTypes = [
      { input: 'photo', expected: 'photo' },
      { input: 'video', expected: 'video' },
      { input: 'document', expected: 'document' },
      { input: 'sticker', expected: 'sticker' },
      { input: 'voice', expected: 'voice' },
      { input: 'audio', expected: 'audio' },
      { input: 'poll', expected: 'poll' },
      { input: 'contact', expected: 'contact' },
      { input: 'location', expected: 'location' },
      { input: 'live_location', expected: 'location' },
      { input: 'venue', expected: 'venue' },
      { input: 'game', expected: 'game' },
      { input: 'invoice', expected: 'invoice' },
      { input: 'webpage', expected: 'webpage' },
      { input: 'dice', expected: 'dice' },
    ]

    for (const { input, expected } of knownTypes) {
      const result = resolveRealtimeMessageType({ media: { type: input } })
      expect(result).toEqual({ messageType: expected, hasMedia: true })
    }
  })
})

describe('resolveSyncChatType', () => {
  it('returns undefined for null chat', () => {
    const result = resolveSyncChatType(null)
    expect(result).toBeUndefined()
  })

  it('returns undefined for undefined chat', () => {
    const result = resolveSyncChatType(undefined)
    expect(result).toBeUndefined()
  })

  it('returns private for user type', () => {
    const result = resolveSyncChatType({ type: 'user' })
    expect(result).toBe('private')
  })

  it('returns group for basic group chatType', () => {
    const result = resolveSyncChatType({ type: 'chat', chatType: 'group' })
    expect(result).toBe('group')
  })

  it('returns supergroup for supergroup chatType', () => {
    const result = resolveSyncChatType({ type: 'chat', chatType: 'supergroup' })
    expect(result).toBe('supergroup')
  })

  it('returns supergroup for gigagroup chatType', () => {
    const result = resolveSyncChatType({ type: 'chat', chatType: 'gigagroup' })
    expect(result).toBe('supergroup')
  })

  it('returns supergroup for monoforum chatType', () => {
    const result = resolveSyncChatType({ type: 'chat', chatType: 'monoforum' })
    expect(result).toBe('supergroup')
  })

  it('returns channel for channel chatType', () => {
    const result = resolveSyncChatType({ type: 'chat', chatType: 'channel' })
    expect(result).toBe('channel')
  })

  it('returns community for community chatType', () => {
    const result = resolveSyncChatType({ type: 'chat', chatType: 'community' })
    expect(result).toBe('community')
  })

  it('returns group for unknown chatType (default case)', () => {
    const result = resolveSyncChatType({
      type: 'chat',
      chatType: 'some_future_type',
    })
    expect(result).toBe('group')
  })

  it('returns group for chat type without chatType property', () => {
    const result = resolveSyncChatType({ type: 'chat' })
    expect(result).toBe('group')
  })

  it('returns undefined for unknown type (neither user nor chat)', () => {
    const result = resolveSyncChatType({ type: 'bot' })
    expect(result).toBeUndefined()
  })

  it('returns undefined for empty object', () => {
    const result = resolveSyncChatType({})
    expect(result).toBeUndefined()
  })
})

describe('signal/cleanup helpers', () => {
  it('setupSignalHandlers marks runtime and installs handlers once', () => {
    const ctx = createContext()
    const calls: string[] = []
    const originalOn = process.on

    process.on = ((signal: string, handler: (...args: unknown[]) => void) => {
      calls.push(signal)
      return Reflect.apply(originalOn, process, [signal, handler])
    }) as typeof process.on

    try {
      setupSignalHandlers(ctx)
      setupSignalHandlers(ctx)
    } finally {
      process.on = originalOn
    }

    expect(ctx.runtime.signalHandlersSetup).toBe(true)
    expect(calls.filter((signal) => signal === 'SIGTERM').length).toBe(1)
  })

  it('SIGTERM sets the stop flag and aborts the stop signal', () => {
    const ctx = createContext()
    const handlers = new Map<string, () => void>()
    const originalOn = process.on
    // Capture the handlers without installing a real listener
    process.on = ((signal: string, handler: () => void) => {
      handlers.set(signal, handler)
      return process
    }) as typeof process.on

    try {
      setupSignalHandlers(ctx)
    } finally {
      process.on = originalOn
    }
    handlers.get('SIGTERM')?.()

    expect(ctx.logger.info).toHaveBeenCalledWith(
      'Received SIGTERM, initiating graceful shutdown...',
    )
    expect(ctx.state.shutdownRequested).toBe(true)
    expect(ctx.runtime.shutdown.signal.aborted).toBe(true)
    expect(isDaemonStopError(ctx.runtime.shutdown.signal.reason)).toBe(true)
  })

  it('closeClientSafe destroys the client', async () => {
    const ctx = createContext()
    const client = { destroy: mock(async () => {}) }

    await closeClientSafe(ctx, asTelegramClient(client), 'test')

    expect(client.destroy).toHaveBeenCalledTimes(1)
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('closeClientSafe logs errors instead of throwing', async () => {
    const ctx = createContext()
    const errorClient = {
      destroy: () => {
        throw new Error('boom')
      },
    }

    await closeClientSafe(ctx, asTelegramClient(errorClient), 'error')
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})

describe('daemonNetworkMiddlewares', () => {
  /** Run the middlewares over a final step, as mtcute's network manager does */
  function compose(
    middlewares: RpcCallMiddleware[],
    final: (ctx: RpcCallMiddlewareContext) => Promise<unknown>,
  ) {
    return middlewares.reduceRight<
      (ctx: RpcCallMiddlewareContext) => Promise<unknown>
    >((next, middleware) => (ctx) => middleware(ctx, next), final)
  }

  it("ends a FLOOD_WAIT the daemon's flood waiter sleeps out when the daemon stops", async () => {
    const ctx = createContext()
    const sent: string[] = []
    const call = compose(daemonNetworkMiddlewares(ctx, 1), async (rpc) => {
      sent.push(rpc.request._)
      return {
        _: 'mt_rpc_error',
        errorCode: 420,
        errorMessage: 'FLOOD_WAIT_300',
      }
    })
    const manager = {
      teardownSignal: new AbortController().signal,
      _log: { warn: () => {} },
    } as unknown as RpcCallMiddlewareContext['manager']
    setTimeout(() => requestShutdown(ctx), 20)

    const started = performance.now()
    const error = await call({
      request: { _: 'messages.getHistory' } as unknown as tl.RpcMethod,
      manager,
      params: { abortSignal: ctx.runtime.shutdown.signal },
    }).catch((err: unknown) => err)

    expect(performance.now() - started).toBeLessThan(200)
    expect(isDaemonStopError(error)).toBe(true)
    expect(ctx.logger.info).toHaveBeenCalledWith(
      '[Account 1] messages.getHistory: FLOOD_WAIT, waiting 300s',
    )
    // The wait ended without a retry
    expect(sent).toEqual(['messages.getHistory'])
  })

  describe('API activity', () => {
    const manager = {
      teardownSignal: new AbortController().signal,
      _log: { warn: () => {} },
    } as unknown as RpcCallMiddlewareContext['manager']
    const rpc = (method: string): RpcCallMiddlewareContext => ({
      request: { _: method } as unknown as tl.RpcMethod,
      manager,
    })

    /** A context whose account 1 has a cache */
    function withCache() {
      const ctx = createContext()
      const { db } = createTestCacheDatabase()
      ctx.runtime.accounts.set(1, { accountId: 1, db } as AccountRuntime)
      return { ctx, db }
    }

    it('logs every request the daemon sends to the account, in ms: a dialog pass, the communities check, getMe', async () => {
      const { ctx, db } = withCache()
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async () => ({
        _: 'ok',
      }))
      const before = Date.now()

      // iterDialogs pages, getJoinedCommunities, getMe (start, reconnect, health check)
      for (const method of [
        'messages.getDialogs',
        'messages.getDialogs',
        'communities.getJoinedCommunities',
        'users.getUsers',
      ]) {
        await call(rpc(method))
      }

      const rateLimits = createRateLimitsService(db)
      const rows = rateLimits.getActivity()
      expect(rows).toHaveLength(4)
      for (const row of rows) {
        expect(row).toMatchObject({ success: 1, error_code: null })
        expect(row.timestamp).toBeGreaterThanOrEqual(before)
        expect(row.timestamp).toBeLessThanOrEqual(Date.now())
      }
      const status = rateLimits.getStatus()
      expect(status.totalCalls).toBe(4)
      expect(status.callsByMethod).toEqual({
        'messages.getDialogs': 2,
        'communities.getJoinedCommunities': 1,
        'users.getUsers': 1,
      })
      expect(rateLimits.getCallCount('messages.getDialogs', 1)).toBe(2)
      db.close()
    })

    it("logs Telegram's error code, and an error that isn't Telegram's without one", async () => {
      const { ctx, db } = withCache()
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async (req) => {
        if (req.request._ === 'channels.getMessages') {
          return {
            _: 'mt_rpc_error',
            errorCode: 400,
            errorMessage: 'CHANNEL_PRIVATE',
          }
        }
        throw new Error('connection reset')
      })

      await call(rpc('channels.getMessages'))
      const thrown = await call(rpc('users.getUsers')).catch(
        (err: unknown) => err,
      )

      expect(thrown).toBeInstanceOf(Error)
      expect(
        createRateLimitsService(db)
          .getActivity()
          .sort((a, b) => a.id - b.id),
      ).toMatchObject([
        {
          method: 'channels.getMessages',
          success: 0,
          error_code: 400,
          error_message: 'CHANNEL_PRIVATE',
        },
        {
          method: 'users.getUsers',
          success: 0,
          error_code: null,
          error_message: 'connection reset',
        },
      ])
      db.close()
    })

    it("halves the account's sync pace on a FLOOD_WAIT, short or long (#133)", async () => {
      const { ctx, db } = withCache()
      const rt = ctx.runtime.accounts.get(1)!
      rt.pacer = createSyncPacer()
      rt.pacer.setHistoryDue(true)
      // Longer than the daemon's 5 minutes: returned, not slept through
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async () => ({
        _: 'mt_rpc_error',
        errorCode: 420,
        errorMessage: 'FLOOD_WAIT_400',
      }))
      const before = Date.now()

      await call(rpc('messages.getHistory'))

      expect(rt.pacer.snapshot()).toMatchObject({
        mode: 'history',
        floodWaits: 1,
      })
      expect(rt.pacer.snapshot().targetCallsPerSecond).toBeCloseTo(0.35, 2)
      expect(rt.pacer.nextStartAt()).toBeGreaterThanOrEqual(before + 400_000)
      expect(ctx.logger.info).toHaveBeenCalledWith(
        '[Account 1] messages.getHistory: FLOOD_WAIT of 400s, history pace down to 0.35 calls/s',
      )
      db.close()
    })

    it("leaves the sync pace alone on another method's FLOOD_WAIT", async () => {
      const { ctx, db } = withCache()
      const rt = ctx.runtime.accounts.get(1)!
      rt.pacer = createSyncPacer()
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async () => ({
        _: 'mt_rpc_error',
        errorCode: 420,
        errorMessage: 'FLOOD_WAIT_400',
      }))

      await call(rpc('messages.getDialogs'))

      expect(rt.pacer.snapshot().floodWaits).toBe(0)
      db.close()
    })

    it('reads the seconds of FLOOD_WAIT and FLOOD_PREMIUM_WAIT only', () => {
      expect(floodWaitSecondsOf('FLOOD_WAIT_12')).toBe(12)
      expect(floodWaitSecondsOf('FLOOD_PREMIUM_WAIT_5')).toBe(5)
      expect(floodWaitSecondsOf('SLOWMODE_WAIT_5')).toBeNull()
      expect(floodWaitSecondsOf('CHANNEL_PRIVATE')).toBeNull()
    })

    it('sends the request without a log for an account without a cache, or a cache that fails', async () => {
      const ctx = createContext()
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async () => ({
        _: 'ok',
      }))
      expect(await call(rpc('users.getUsers'))).toEqual({ _: 'ok' })

      const { ctx: closed, db } = withCache()
      db.close()
      const closedCall = compose(
        daemonNetworkMiddlewares(closed, 1),
        async () => ({ _: 'ok' }),
      )
      expect(await closedCall(rpc('users.getUsers'))).toEqual({ _: 'ok' })
    })
  })
})
