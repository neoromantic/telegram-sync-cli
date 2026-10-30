/**
 * Usage stats wiring: command paths, the channel, error types and the source
 * checkout rule. The client itself is devkit's and tested there.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  instrumentCommands,
  pendingHandoff,
  reportCliError,
  resetTelemetryForTests,
  rpcErrorType,
  startTelemetry,
  withoutAccountIds,
  withoutDataDir,
} from '../telemetry'
import { dailyKey, type Handoff, sentToday } from '../telemetry/background'

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

describe('withoutDataDir', () => {
  it('drops a data directory the user set, wherever its path appears', () => {
    const env = { TELEGRAM_SYNC_CLI_DATA_DIR: '/Volumes/Work/Acme Corp/tg/' }
    expect(
      withoutDataDir(
        "EACCES: permission denied, open '/Volumes/Work/Acme Corp/tg/config.json'",
        env,
      ),
    ).toBe("EACCES: permission denied, open '<data-dir>/config.json'")
    expect(
      withoutDataDir(
        'Could not read /Volumes/Work/Acme Corp/tg/config.json: EACCES',
        env,
      ),
    ).toBe('Could not read <data-dir>/config.json: EACCES')
  })

  it('matches a relative directory as join() writes it, not inside a word', () => {
    const env = { TELEGRAM_SYNC_CLI_DATA_DIR: './acme-tg' }
    expect(withoutDataDir('Could not read acme-tg/config.json', env)).toBe(
      'Could not read <data-dir>/config.json',
    )
    expect(withoutDataDir('open old-acme-tg/config.json', env)).toBe(
      'open old-acme-tg/config.json',
    )
  })

  it('leaves the message alone without TELEGRAM_SYNC_CLI_DATA_DIR', () => {
    const message = 'Could not read /home/user/.telegram-sync-cli/config.json'
    expect(withoutDataDir(message, {})).toBe(message)
    expect(withoutDataDir(message, { TELEGRAM_SYNC_CLI_DATA_DIR: '/' })).toBe(
      message,
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

describe('a test endpoint', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is used only by a source checkout with usage stats on', () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-telemetry-'))
    const env = {
      TELEGRAM_SYNC_CLI_DATA_DIR: dir,
      TELEGRAM_SYNC_CLI_TELEMETRY: '1',
      TELEGRAM_SYNC_CLI_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/e/',
    }
    const source = createTgTelemetry({ channel: 'source', env }).status()
    expect(source.endpoint).toBe('http://127.0.0.1:9/e/')
    const npm = createTgTelemetry({ channel: 'npm', env }).status()
    expect(npm.endpoint).toBe('https://usage.sergeybaus.com/i/v0/e/')
  })
})

describe('the events a command hands over at its exit', () => {
  const dirs: string[] = []
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-telemetry-'))
    dirs.push(dir)
    return dir
  }
  /** Usage stats on, the notice seen, no AI agent */
  const on = () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'telemetry.json'),
      '{"id":null,"enabled":null,"notice":1,"installed":false,"daily":{}}\n',
    )
    return { TELEGRAM_SYNC_CLI_DATA_DIR: dir }
  }
  const start = (
    args: string[],
    env: Record<string, string>,
    channel: 'npm' | 'source' = 'npm',
  ) => {
    instrumentCommands(tree)
    startTelemetry(args, { env, channel })
    return pendingHandoff()
  }

  afterEach(() => {
    resetTelemetryForTests()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('are app_started, the command and its error', () => {
    const handoff = start(['chats', 'list', 'Jane Doe'], on())
    reportCliError('AUTH_REQUIRED', 'Not logged in as Jane Doe')
    expect(handoff).toMatchObject({
      channel: 'npm',
      calls: [
        ['started'],
        ['feature', 'chats list'],
        ['error', 'AUTH_REQUIRED'],
      ],
    })
    expect(start(['chats', 'secret'], on())?.calls).toEqual([
      ['started'],
      ['feature', 'other'],
    ])
  })

  it('are none when usage stats are off, so no process starts', () => {
    expect(start(['chats', 'list'], { ...on(), DO_NOT_TRACK: '1' })).toBeNull()
    expect(
      start(['chats', 'list'], { ...on(), TELEGRAM_SYNC_CLI_TELEMETRY: '0' }),
    ).toBeNull()
    expect(start(['chats', 'list'], { ...on(), CI: 'true' })).toBeNull()
    expect(start(['chats', 'list'], { ...on(), NODE_ENV: 'test' })).toBeNull()
    expect(start(['chats', 'list'], on(), 'source')).toBeNull()
  })

  it('are none before the notice was shown', () => {
    instrumentCommands(tree)
    startTelemetry(['chats', 'list'], {
      quiet: true,
      env: { TELEGRAM_SYNC_CLI_DATA_DIR: tempDir() },
      channel: 'npm',
    })
    expect(pendingHandoff()).toBeNull()
  })

  it('stay in the daemon, which sends them itself', () => {
    // Its requests go to a closed local port
    const env = {
      ...on(),
      TELEGRAM_SYNC_CLI_TELEMETRY: '1',
      TELEGRAM_SYNC_CLI_TELEMETRY_ENDPOINT: 'http://127.0.0.1:9/e/',
    }
    expect(start(['daemon', 'start'], env, 'source')).toBeNull()
    expect(start(['chats', 'list'], env, 'source')).not.toBeNull()
  })
})

describe('sentToday', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const now = new Date('2026-03-04T10:00:00Z')
  const script: Handoff = {
    channel: 'npm',
    tty: false,
    calls: [['started'], ['feature', 'chats list'], ['error', 'FLOOD_WAIT']],
  }
  const state = (installed: boolean, daily: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), 'tg-telemetry-'))
    const file = join(dir, 'telemetry.json')
    writeFileSync(file, JSON.stringify({ notice: 1, installed, daily }))
    return file
  }
  const today = Object.fromEntries(
    script.calls.map((call) => [dailyKey(call), '2026-03-04']),
  )

  it('names the keys the client counts once a day', () => {
    expect(script.calls.map(dailyKey)).toEqual([
      'app_started',
      'feature_used:chats list',
      'error_occurred:FLOOD_WAIT',
    ])
    expect(dailyKey(['error', { code: 'ConfigError', message: 'x' }])).toBe(
      'error_occurred:ConfigError',
    )
  })

  it('is true for a script run whose events all went out today', () => {
    expect(sentToday(state(true, today), script, {}, now)).toBe(true)
  })

  it('is false when anything may still be sent', () => {
    const file = state(true, today)
    expect(sentToday(file, { ...script, tty: true }, {}, now)).toBe(false)
    expect(sentToday(file, script, { AI_AGENT: 'e2e' }, now)).toBe(false)
    expect(sentToday(file, script, {}, new Date('2026-03-05T00:00:00Z'))).toBe(
      false,
    )
    expect(sentToday(state(false, today), script, {}, now)).toBe(false)
    const { 'feature_used:chats list': _, ...rest } = today
    expect(sentToday(state(true, rest), script, {}, now)).toBe(false)
    expect(sentToday(join(dir, 'missing.json'), script, {}, now)).toBe(false)
  })
})
