/**
 * E2E tests for tg api with a fake Telegram client
 *
 * mtcute's open connection keeps the process alive until the client is
 * closed, and so does the fake one: every path of tg api has to close it,
 * or the command prints its output and never exits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { type CliOptions, runCli } from './helpers/cli'
import {
  FAKE_CLIENT_CLI,
  FAKE_CLIENT_DESTROYED,
  FAKE_CONFIG,
} from './helpers/fake-client-cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

// A run that hangs fails on this timeout, before the test's own
const HANG_TIMEOUT_MS = 8_000
const TEST_TIMEOUT_MS = 15_000

describe('E2E: tg api closes the client and exits', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('api')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000000', is_active: true }])
  })

  afterEach(() => {
    env.cleanup()
  })

  function runApi(args: string[]) {
    const options: CliOptions = {
      ...env.getCliOptions(),
      entry: FAKE_CLIENT_CLI,
      timeout: HANG_TIMEOUT_MS,
    }
    return runCli(['api', ...args], options)
  }

  it(
    '--raw prints the bare result, closes the client and exits 0',
    async () => {
      const result = await runApi(['help.getConfig', '--raw'])

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(FAKE_CONFIG)
      expect(result.stderr).toContain(FAKE_CLIENT_DESTROYED)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'without --raw prints the success wrapper, closes the client and exits 0',
    async () => {
      const result = await runApi(['help.getConfig'])

      expect(result.exitCode).toBe(0)
      expect(result.json).toEqual({
        success: true,
        data: { method: 'help.getConfig', result: FAKE_CONFIG },
      })
      expect(result.stderr).toContain(FAKE_CLIENT_DESTROYED)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'a failed call closes the client and exits with TELEGRAM_ERROR',
    async () => {
      const result = await runApi(['help.getNothing', '--raw'])

      expect(result.exitCode).toBe(5)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(FAKE_CLIENT_DESTROYED)
      expect(result.stderr).toContain('"code": "TELEGRAM_ERROR"')
      expect(result.stderr).toContain('"telegramErrorCode": 400')
    },
    TEST_TIMEOUT_MS,
  )
})
