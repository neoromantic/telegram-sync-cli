/**
 * Tests for Telegram client factory wiring
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import * as mtcute from '@mtcute/bun'

process.env.NODE_ENV = 'test'

let lastClientOptions: Record<string, unknown> | null
let floodWaiterImpl = mock((_opts: unknown) => ({ kind: 'floodWaiter' }))

mock.module('@mtcute/core', () => ({
  networkMiddlewares: {
    floodWaiter: (...args: unknown[]) =>
      (floodWaiterImpl as (...inner: unknown[]) => unknown)(...args),
  },
}))

class MockTelegramClient {
  options: Record<string, unknown>
  constructor(options: Record<string, unknown>) {
    this.options = options
    lastClientOptions = options
  }
}

mock.module('@mtcute/bun', () => ({
  ...mtcute,
  TelegramClient: MockTelegramClient,
}))

describe('createDefaultClientFactory', () => {
  beforeEach(() => {
    lastClientOptions = null
    floodWaiterImpl = mock((_opts: unknown) => ({ kind: 'floodWaiter' }))
  })

  it('passes custom flood waiter options and session path', async () => {
    const { createDefaultClientFactory, getSessionPath } = await import(
      '../services/telegram'
    )

    const floodWaiter = {
      maxRetries: 1,
      maxWait: 1000,
      store: false,
      onBeforeWait: () => {},
    }

    const factory = createDefaultClientFactory(
      { apiId: 123, apiHash: 'hash', logLevel: 3, floodWaiter },
      '/tmp/data',
    )

    factory.create(7)

    expect(floodWaiterImpl).toHaveBeenCalledWith(floodWaiter)
    const options = lastClientOptions as {
      apiId: number
      apiHash: string
      logLevel: number
      storage: string
      network: { middlewares: unknown[] }
    }
    expect(options.apiId).toBe(123)
    expect(options.apiHash).toBe('hash')
    expect(options.logLevel).toBe(3)
    expect(options.storage).toBe(getSessionPath(7, '/tmp/data'))
    expect(options.network.middlewares[0]).toEqual({ kind: 'floodWaiter' })
  })

  it('uses default flood waiter options when none provided', async () => {
    const { createDefaultClientFactory } = await import('../services/telegram')

    const factory = createDefaultClientFactory({
      apiId: 123,
      apiHash: 'hash',
      logLevel: 2,
    })

    factory.create(1)

    expect(floodWaiterImpl).toHaveBeenCalled()
    const options = lastClientOptions as { network: { middlewares: unknown[] } }
    expect(options.network.middlewares.length).toBe(1)
    expect(lastClientOptions).not.toHaveProperty('transport')
  })

  it('passes the configured proxy transport to the client', async () => {
    const { createDefaultClientFactory } = await import('../services/telegram')
    const transport = mtcute.proxyTransportFromUrl('socks5://127.0.0.1:1080')
    createDefaultClientFactory({
      apiId: 123,
      apiHash: 'hash',
      logLevel: 2,
      transport,
    }).create(1)
    expect(lastClientOptions?.transport).toBe(transport)
  })
})
