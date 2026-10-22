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

import { ErrorCodes } from '../types'
import { wrapClientCallWithRecordReplay } from '../utils/telegram-record-replay'
import { runCliFailure, runCliSuccess } from './helpers/cli'
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
    ['--username myuser', ['--username', 'myuser']],
    ['--username=myuser', ['--username=myuser']],
    ['--json', ['--json', '{"username":"myuser"}']],
    // tg's global options reach this command undeclared
    ['--username myuser -v', ['--username', 'myuser', '-v']],
    ['--verbose --username myuser', ['--verbose', '--username', 'myuser']],
    ['-f json --username myuser', ['-f', 'json', '--username', 'myuser']],
    [
      '--username myuser --format json',
      ['--username', 'myuser', '--format', 'json'],
    ],
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

  it.each(['-q', '--quiet'])(
    'account.checkUsername with %s sends only the username',
    async (flag) => {
      await recordFixture(
        { _: 'account.checkUsername', username: 'myuser' },
        true,
      )

      // Quiet prints nothing on success; a missed fixture fails with exit code 5
      const result = await runCliSuccess(
        ['api', 'account.checkUsername', '--username', 'myuser', flag],
        replayOptions(),
      )

      expect(result.stdout).toBe('')
    },
  )

  it('misses the fixture for another username', async () => {
    await recordFixture(
      { _: 'account.checkUsername', username: 'myuser' },
      true,
    )

    const result = await runCliFailure(
      ['api', 'account.checkUsername', '--username', 'otheruser'],
      5,
      replayOptions(),
    )

    const { error } = result.json as {
      error: { code: string; message: string }
    }
    expect(error.code).toBe(ErrorCodes.TELEGRAM_ERROR)
    expect(error.message).toContain('Replay fixture not found')
  })

  it.each([
    'contacts.getTopPeers --correspondents --offset 0 --limit 5 --hash 0',
    'contacts.getTopPeers --offset 0 --limit 5 --hash 0 --correspondents',
    '--account 1 contacts.getTopPeers --offset 0 --limit 5 --hash 0 --correspondents',
    'contacts.getTopPeers -a 1 --correspondents --offset 0 --limit 5 --hash 0',
  ])('a flag with no value is true: %s', async (command) => {
    const response = { _: 'contacts.topPeersNotModified' }
    await recordFixture(
      {
        _: 'contacts.getTopPeers',
        correspondents: true,
        offset: 0,
        limit: 5,
        hash: 0,
      },
      response,
    )

    const result = await runCliSuccess(
      ['api', ...command.split(' ')],
      replayOptions(),
    )

    expect(result.json).toEqual({
      success: true,
      data: { method: 'contacts.getTopPeers', result: response },
    })
  })

  it.each([
    [
      '--name value',
      ['--peer._', 'inputPeerSelf', '--addOffset', '-10', '--limit', '10'],
    ],
    [
      '--name=value',
      ['--peer._=inputPeerSelf', '--addOffset=-10', '--limit=10'],
    ],
  ])(
    'messages.getHistory reads a dotted name, a negative number and --json with %s',
    async (_form, args) => {
      const response = {
        _: 'messages.messages',
        messages: [],
        chats: [],
        users: [],
      }
      await recordFixture(
        {
          _: 'messages.getHistory',
          peer: { _: 'inputPeerSelf' },
          offsetId: 0,
          offsetDate: 0,
          addOffset: -10,
          limit: 10,
          maxId: 0,
          minId: 0,
          hash: 0,
        },
        response,
      )

      const result = await runCliSuccess(
        [
          'api',
          'messages.getHistory',
          ...args,
          '--json',
          '{"offsetId":0,"offsetDate":0,"maxId":0,"minId":0,"hash":0}',
        ],
        replayOptions(),
      )

      expect(result.json).toEqual({
        success: true,
        data: { method: 'messages.getHistory', result: response },
      })
    },
  )

  // citty reads `-1.5` as the short options 1, . and 5; none may reach the request
  it.each([
    [
      '--name value',
      [
        '--geoPoint._',
        'inputGeoPoint',
        '--geoPoint.lat',
        '-1.5',
        '--geoPoint.long',
        '2.5',
      ],
    ],
    [
      '--name=value',
      [
        '--geoPoint._=inputGeoPoint',
        '--geoPoint.lat=-1.5',
        '--geoPoint.long=2.5',
      ],
    ],
  ])(
    'contacts.getLocated reads a negative decimal with %s',
    async (_form, args) => {
      const response = { _: 'updates', updates: [], users: [], chats: [] }
      await recordFixture(
        {
          _: 'contacts.getLocated',
          geoPoint: { _: 'inputGeoPoint', lat: -1.5, long: 2.5 },
        },
        response,
      )

      const result = await runCliSuccess(
        ['api', 'contacts.getLocated', ...args],
        replayOptions(),
      )

      expect(result.json).toEqual({
        success: true,
        data: { method: 'contacts.getLocated', result: response },
      })
    },
  )
})
