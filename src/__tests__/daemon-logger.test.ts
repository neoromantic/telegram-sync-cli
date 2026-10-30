/**
 * Tests for daemon logger verbosity
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'
import {
  accountLabel,
  createLogger,
  formatClientLog,
  maskPhone,
  routeClientLogs,
} from '../daemon/daemon-logger'

const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
}

function stubConsole() {
  const log = mock(() => {})
  const warn = mock(() => {})
  const error = mock(() => {})

  console.log = log as unknown as typeof console.log
  console.warn = warn as unknown as typeof console.warn
  console.error = error as unknown as typeof console.error

  return { log, warn, error }
}

afterEach(() => {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
})

describe('createLogger', () => {
  it('suppresses info/debug in quiet mode', () => {
    const { log, warn, error } = stubConsole()

    const logger = createLogger('quiet')
    logger.info('info')
    logger.debug('debug')
    logger.warn('warn')
    logger.error('error')

    expect(log).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('logs info but not debug in normal mode', () => {
    const { log } = stubConsole()

    const logger = createLogger('normal')
    logger.info('info')
    logger.debug('debug')

    expect(log).toHaveBeenCalledTimes(1)
  })

  it('logs debug in verbose mode', () => {
    const { log } = stubConsole()

    const logger = createLogger('verbose')
    logger.debug('debug')

    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('account labels (#128)', () => {
  it('masks all but the first two and last two digits of a phone', () => {
    expect(maskPhone('+15550000001')).toBe('+15*******01')
    expect(maskPhone('123')).toBe('***')
  })

  it('names an account by its username, else a masked phone', () => {
    expect(
      accountLabel({ accountId: 2, phone: '+15550000002', username: 'demo' }),
    ).toBe('#2 (@demo)')
    expect(accountLabel({ accountId: 2, phone: '+15550000002' })).toBe(
      '#2 (+15*******02)',
    )
    expect(accountLabel({ accountId: 3, phone: 'user:42' })).toBe('#3')
  })
})

describe('routeClientLogs (#128)', () => {
  function fakeClient() {
    const errorHandlers: Array<(err: Error) => void> = []
    const mgr = {
      level: 5,
      handler: (
        _color: number,
        _level: number,
        _tag: string,
        _fmt: string,
        _args: unknown[],
      ) => {},
    }
    const client = {
      log: { mgr },
      onError: { add: (fn: (err: Error) => void) => errorHandlers.push(fn) },
    } as unknown as TelegramClient
    return { client, mgr, errorHandlers }
  }

  function logger() {
    return {
      info: mock((_: string) => {}),
      debug: mock((_: string) => {}),
      warn: mock((_: string) => {}),
      error: mock((_: string) => {}),
    }
  }

  it("keeps mtcute's warnings for --verbose and its update gap chatter at debug", () => {
    const quiet = fakeClient()
    routeClientLogs(quiet.client, logger(), 'normal', '[Account 1]')
    expect(quiet.mgr.level).toBe(1)

    const { client, mgr } = fakeClient()
    const log = logger()
    routeClientLogs(client, log, 'verbose', '[Account 1]')
    expect(mgr.level).toBe(2)

    mgr.handler(
      0,
      2,
      'updates',
      '[USER 42] pts_before does not match local_pts for %s (cid = %d)',
      ['updateNewChannelMessage', Number.NaN],
    )
    mgr.handler(0, 2, 'mtproto', 'ping timed out', [])
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at source dump'
    mgr.handler(0, 1, 'client', 'unhandled error:', [err])

    expect(log.debug.mock.calls).toEqual([
      [
        '[Account 1] [mtcute updates] pts_before does not match local_pts for updateNewChannelMessage (cid = NaN)',
      ],
    ])
    expect(log.warn.mock.calls).toEqual([
      ['[Account 1] [mtcute mtproto] ping timed out'],
    ])
    expect(log.error.mock.calls).toEqual([
      ['[Account 1] [mtcute client] unhandled error: boom'],
    ])
  })

  it('logs a client error in one line, and the same error again only at debug for 5 minutes', () => {
    const { client, errorHandlers } = fakeClient()
    const log = logger()
    let now = 0
    routeClientLogs(client, log, 'normal', '[Account 1]', () => now)
    const err = new Error('Could not connect to DC 2\nusing any address')
    err.stack = `${err.message}\n    at minified source`

    errorHandlers[0]!(err)
    now = 60_000
    errorHandlers[0]!(err)
    now = 6 * 60_000
    errorHandlers[0]!(err)

    const line =
      '[Account 1] Telegram client error: Could not connect to DC 2 using any address'
    expect(log.warn.mock.calls).toEqual([[line], [line]])
    expect(log.debug.mock.calls).toEqual([[line]])
  })
})

describe('formatClientLog', () => {
  it('fills in the format and appends extra arguments', () => {
    expect(formatClientLog('%s took %d ms', ['ping', 12, { a: 1 }])).toBe(
      'ping took 12 ms {"a":1}',
    )
  })
})
