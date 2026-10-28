/**
 * Usage stats wiring: command paths, the channel, error types and the source
 * checkout rule. The client itself is devkit's and tested there.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CommandNode,
  cliErrorType,
  commandPath,
  commandPaths,
  createTgTelemetry,
  detectChannel,
  errorType,
  rpcErrorType,
  withoutAccountIds,
} from '../telemetry'

const run = () => {}
const tree: CommandNode = {
  args: {
    format: { type: 'enum', alias: 'f' },
    verbose: { type: 'boolean', alias: 'v' },
  },
  subCommands: {
    chats: {
      args: {},
      subCommands: {
        list: { args: { limit: { type: 'string' } }, run },
        get: { args: {}, run },
      },
    },
    send: { args: { to: { type: 'string' } }, run },
    daemon: { subCommands: { start: { run }, stop: { run } } },
    telemetry: { subCommands: { status: { run }, off: { run } } },
  },
}

describe('commandPaths', () => {
  it('lists every command the dispatcher runs, without tg telemetry', () => {
    expect(commandPaths(tree)).toEqual([
      'chats list',
      'chats get',
      'send',
      'daemon start',
      'daemon stop',
    ])
  })
})

describe('commandPath', () => {
  it('drops arguments and option values', () => {
    expect(
      commandPath(tree, ['chats', 'list', '--limit', '5', 'Jane Doe']),
    ).toEqual(['chats', 'list'])
    expect(
      commandPath(tree, ['send', '--to', '@someone', 'hello there']),
    ).toEqual(['send'])
  })

  it('skips global options and their values, as citty does', () => {
    expect(commandPath(tree, ['-f', 'pretty', '-v', 'chats', 'get'])).toEqual([
      'chats',
      'get',
    ])
    expect(commandPath(tree, ['--format=json', 'daemon', 'start'])).toEqual([
      'daemon',
      'start',
    ])
  })

  it('ends at a name the dispatcher does not know', () => {
    expect(commandPath(tree, ['chats', 'lst', 'secret'])).toEqual([
      'chats',
      'lst',
    ])
    expect(commandPath(tree, [])).toEqual([])
    expect(commandPath(tree, ['--', 'chats'])).toEqual([])
  })
})

describe('detectChannel', () => {
  it('tells a compiled binary from Homebrew by the executable', () => {
    expect(detectChannel('/$bunfs/root/tg', '/usr/local/bin/tg-x')).toBe(
      'binary',
    )
    expect(
      detectChannel('/$bunfs/root/tg', '/opt/homebrew/Cellar/tg/0.7.0/bin/tg'),
    ).toBe('homebrew')
    expect(
      detectChannel(
        'B:/~BUN/root/tg.exe',
        'C:\\Users\\user\\Downloads\\tg.exe',
      ),
    ).toBe('binary')
  })

  it('tells the npm package from a source checkout', () => {
    expect(
      detectChannel(
        '/home/user/.bun/install/global/node_modules/@goodit/telegram-sync-cli/src/telemetry/index.ts',
      ),
    ).toBe('npm')
    expect(
      detectChannel('/home/user/code/telegram-sync-cli/src/telemetry/index.ts'),
    ).toBe('source')
  })
})

describe('error types', () => {
  it("names Telegram's RPC error without its numbers", () => {
    expect(rpcErrorType('Telegram API error 420: FLOOD_WAIT_30')).toBe(
      'FLOOD_WAIT',
    )
    expect(
      rpcErrorType(
        'Failed to send message: Telegram API error 400: PEER_ID_INVALID',
      ),
    ).toBe('PEER_ID_INVALID')
    expect(
      rpcErrorType('Telegram API error 400: FILE_REFERENCE_0_EXPIRED'),
    ).toBe('FILE_REFERENCE_EXPIRED')
    expect(
      rpcErrorType(
        'Failed to list messages: Telegram API error 400: PEER_ID_INVALID (run tg chats list --fresh or pass the @username)',
      ),
    ).toBe('PEER_ID_INVALID')
    expect(rpcErrorType('Telegram API error 400: Peer_invalid')).toBeNull()
    expect(rpcErrorType('Chat "Weekend Crew" not found')).toBeNull()
  })

  it('reports an error() by its code, never its message', () => {
    expect(cliErrorType('INVALID_ARGS', 'Chat "Weekend Crew" not found')).toBe(
      'INVALID_ARGS',
    )
    expect(
      cliErrorType(
        'TELEGRAM_ERROR',
        'Failed to get chat: Telegram API error 400: USERNAME_NOT_OCCUPIED',
      ),
    ).toBe('USERNAME_NOT_OCCUPIED')
    expect(cliErrorType('TELEGRAM_ERROR', 'Cannot send to @someone')).toBe(
      'TELEGRAM_ERROR',
    )
    expect(cliErrorType('RATE_LIMITED', 'Wait 30 seconds')).toBe('FLOOD_WAIT')
  })

  it('types a thrown error by its RPC name, code or class', () => {
    class RpcError extends Error {
      code = 400
    }
    expect(
      errorType(new RpcError('Telegram API error 400: CHANNEL_PRIVATE')),
    ).toBe('CHANNEL_PRIVATE')
    expect(
      errorType(Object.assign(new Error('open /x'), { code: 'ENOENT' })),
    ).toBe('ENOENT')
    class PeerNotFoundError extends Error {}
    expect(errorType(new PeerNotFoundError('Peer @someone not found'))).toBe(
      'PeerNotFoundError',
    )
    expect(errorType(new TypeError('x is undefined'))).toBe('TypeError')
    expect(errorType('a string')).toBe('Error')
  })
})

describe('withoutAccountIds', () => {
  it("drops tg's account numbers from a local error's message", () => {
    expect(
      withoutAccountIds(
        'The cache file belongs to another account: ~/.telegram-sync-cli/accounts/12/cache.db',
      ),
    ).toBe(
      'The cache file belongs to another account: ~/.telegram-sync-cli/accounts/<id>/cache.db',
    )
    expect(withoutAccountIds('open C:\\tg\\accounts\\3\\cache.db')).toBe(
      'open C:\\tg\\accounts\\<id>\\cache.db',
    )
    expect(withoutAccountIds('Failed to open the cache of account 7')).toBe(
      'Failed to open the cache of account <id>',
    )
    expect(withoutAccountIds('session_4.db is locked')).toBe(
      'session_<id>.db is locked',
    )
  })
})

describe('createTgTelemetry', () => {
  let dir: string | undefined
  const dataDir = () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-telemetry-'))
    return dir
  }

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('sends nothing from a source checkout', () => {
    const env = { TELEGRAM_SYNC_CLI_DATA_DIR: dataDir() }
    const status = createTgTelemetry({ channel: 'source', env }).status()
    expect(status.enabled).toBe(false)
    expect(status.reason).toBe('no-endpoint')
    expect(status.endpoint).toBe('')
  })

  it('lets TELEGRAM_SYNC_CLI_TELEMETRY turn a source checkout on', () => {
    for (const value of ['1', 'debug']) {
      const env = {
        TELEGRAM_SYNC_CLI_DATA_DIR: dataDir(),
        TELEGRAM_SYNC_CLI_TELEMETRY: value,
      }
      const status = createTgTelemetry({ channel: 'source', env }).status()
      expect(status.enabled).toBe(true)
      expect(status.reason).toBe('env')
      expect(status.endpoint).toBe('https://usage.sergeybaus.com/i/v0/e/')
    }
  })

  it('is on by default for an install, with state in the data directory', () => {
    const env = { TELEGRAM_SYNC_CLI_DATA_DIR: dataDir() }
    const status = createTgTelemetry({ channel: 'npm', env }).status()
    expect(status.enabled).toBe(true)
    expect(status.reason).toBe('default')
    expect(status.stateFile).toBe(
      join(env.TELEGRAM_SYNC_CLI_DATA_DIR, 'telemetry.json'),
    )
  })

  it('honours DO_NOT_TRACK and TELEGRAM_SYNC_CLI_TELEMETRY=0', () => {
    const base = { TELEGRAM_SYNC_CLI_DATA_DIR: dataDir() }
    const dnt = createTgTelemetry({
      channel: 'homebrew',
      env: { ...base, DO_NOT_TRACK: '1', TELEGRAM_SYNC_CLI_TELEMETRY: '1' },
    }).status()
    expect(dnt).toMatchObject({ enabled: false, reason: 'do-not-track' })
    const off = createTgTelemetry({
      channel: 'homebrew',
      env: { ...base, TELEGRAM_SYNC_CLI_TELEMETRY: '0' },
    }).status()
    expect(off).toMatchObject({ enabled: false, reason: 'env' })
  })
})
