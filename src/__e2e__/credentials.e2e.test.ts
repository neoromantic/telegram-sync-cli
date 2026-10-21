/**
 * E2E tests for lazy Telegram API credentials
 *
 * Only commands that actually talk to Telegram may require TELEGRAM_API_ID /
 * TELEGRAM_API_HASH. Help, version and offline commands must work without them.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import packageJson from '../../package.json' with { type: 'json' }
import { NO_CREDENTIALS, runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: Credentials are only required for Telegram calls', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('credentials')
    env.initDatabase()
  })

  afterEach(() => {
    env.cleanup()
  })

  function options() {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
  }

  it('--help works without credentials', async () => {
    const result = await runCliSuccess(['--help'], options())
    expect(result.stdout).toContain('Telegram Sync CLI')
  })

  it('--version works without credentials', async () => {
    const result = await runCliSuccess(['--version'], options())
    expect(result.stdout.trim()).toBe(packageJson.version)
  })

  it('subcommand --help works without credentials', async () => {
    const result = await runCliSuccess(['auth', '--help'], options())
    expect(result.stdout).toContain('login')
  })

  it('offline commands work without credentials', async () => {
    const result = await runCliSuccess(['accounts', 'list'], options())
    expect((result.json as { success: boolean }).success).toBe(true)
  })

  it('Telegram commands fail with INVALID_ARGS when credentials are missing', async () => {
    env.seedAccounts([{ phone: '+10000000000', is_active: true }])

    const result = await runCliFailure(['api', 'help.getConfig'], 3, options())

    const response = result.json as {
      success: boolean
      error: { code: string; message: string }
    }
    expect(response.success).toBe(false)
    expect(response.error.code).toBe('INVALID_ARGS')
    expect(response.error.message).toContain('TELEGRAM_API_ID')
  })

  it('invalid proxy URLs fail without exposing credentials', async () => {
    env.seedAccounts([{ phone: '+10000000000', is_active: true }])
    const cliOptions = {
      env: {
        ...env.getCliOptions().env,
        TELEGRAM_PROXY: 'socks5h://user:secret@127.0.0.1:1080',
      },
    }
    const result = await runCliFailure(['api', 'help.getConfig'], 3, cliOptions)
    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS', message: 'Invalid TELEGRAM_PROXY URL' },
    })
    expect(result.stdout + result.stderr).not.toContain('secret')

    const daemon = await runCliFailure(['daemon', 'start'], 1, cliOptions)
    expect(daemon.stdout + daemon.stderr).toContain('Configuration error:')
    expect(daemon.stdout + daemon.stderr).toContain(
      'Invalid TELEGRAM_PROXY URL',
    )
    expect(daemon.stdout + daemon.stderr).not.toContain('secret')

    await runCliSuccess(['--help'], cliOptions)
    await runCliSuccess(['--version'], cliOptions)
    await runCliSuccess(['accounts', 'list'], cliOptions)
  })
})
