/**
 * E2E tests for the request that `tg api` builds from its arguments
 *
 * Each test records a replay fixture for an exact request with a stub client,
 * then runs the CLI in replay mode. The fixture name is a hash of the request,
 * so the CLI finds it only if it builds that request, with no extra keys.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import type { TelegramClient, tl } from '@mtcute/bun'

import { wrapClientCallWithRecordReplay } from '../utils/telegram-record-replay'
import { runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: tg api builds the request from its arguments', () => {
  let env: TestEnvironment
  let fixturesDir: string

  beforeEach(() => {
    env = createTestEnvironment('api-args')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000000', is_active: true }])
    fixturesDir = join(env.dataDir, 'fixtures')
  })

  afterEach(() => {
    env.cleanup()
  })

  /** Record the response for exactly this request, as account 1 */
  async function recordFixture(
    request: Record<string, unknown>,
    response: unknown,
  ): Promise<void> {
    const client = wrapClientCallWithRecordReplay(
      { call: async () => response } as unknown as TelegramClient,
      { accountId: 1, config: { mode: 'record', fixturesDir } },
    )
    await client.call(request as unknown as tl.RpcMethod)
  }

  function replayOptions() {
    return {
      env: {
        ...env.getCliOptions().env,
        TELEGRAM_API_REPLAY: '1',
        TELEGRAM_API_FIXTURES_DIR: fixturesDir,
      },
    }
  }

  it.each([
    ['--username=myuser', ['--username=myuser']],
    ['--json', ['--json', '{"username":"myuser"}']],
  ])(
    'account.checkUsername %s sends only the username',
    async (_form, args) => {
      await recordFixture(
        { _: 'account.checkUsername', username: 'myuser' },
        true,
      )

      const result = await runCliSuccess(
        ['api', 'account.checkUsername', ...args],
        replayOptions(),
      )

      expect(result.json).toEqual({
        success: true,
        data: { method: 'account.checkUsername', result: true },
      })
    },
  )
})
