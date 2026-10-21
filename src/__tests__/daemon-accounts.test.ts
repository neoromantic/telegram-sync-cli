/**
 * Unit tests for daemon account helpers (no getCacheDb dependency)
 */
import { describe, expect, it, mock } from 'bun:test'
import type { DeleteMessageUpdate, Message, TelegramClient } from '@mtcute/bun'
import {
  closeClientSafe,
  removeEventHandlers,
  resolveRealtimeMessageType,
  resolveSyncChatType,
  scheduleReconnect,
  setupSignalHandlers,
} from '../daemon/daemon-accounts'
import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import type { AccountConnectionState } from '../daemon/types'

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
      },
    }

    removeEventHandlers(ctx, accountState)

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
