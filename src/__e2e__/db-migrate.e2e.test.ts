/**
 * E2E tests for background migrations (#89): `tg status` shows them,
 * `tg db migrate` finishes them, on a made-up cache as 0.5.0 left it,
 * without Telegram credentials
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { seedOldFormCache } from '../__tests__/helpers/old-form-cache'
import { NO_CREDENTIALS, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

interface Migration {
  name: string
  state: string
  done: number
  total: number | null
  account_id?: number
}

interface StatusOutput {
  data: {
    migrations: Migration[]
    accounts: { accounts: Array<{ id: number; migrations: Migration[] }> }
  }
}

interface MigrateOutput {
  data: { account_id: number; rows: number; migrations: Migration[] }
}

const MESSAGES = 14
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

describe('E2E: background migrations', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('db-migrate')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000001', is_active: true }])
    seedOldFormCache(env.openCacheDb(1), { messages: MESSAGES })
  })

  afterEach(() => {
    env.cleanup()
  })

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  })

  it('tg status shows pending migrations, tg db migrate finishes them', async () => {
    const before = (await runCliSuccess(['status'], options()))
      .json as StatusOutput
    expect(
      before.data.migrations.map((m) => [m.account_id, m.name, m.state]),
    ).toEqual([
      [1, 'messages_raw_json_v2', 'pending'],
      [1, 'users_raw_json_v2', 'pending'],
      [1, 'chats_raw_json_v2', 'pending'],
    ])
    expect(before.data.accounts.accounts[0]!.migrations).toHaveLength(3)

    const pretty = stripAnsi(
      (await runCliSuccess(['status', '--format', 'pretty'], options())).stdout,
    )
    expect(pretty).toContain('Migrations')
    expect(pretty).toContain('messages_raw_json_v2 not started')
    expect(pretty).toContain('tg db migrate --account 1')

    const migrated = (
      await runCliSuccess(['db', 'migrate', '--account', '1'], options())
    ).json as MigrateOutput
    expect(migrated.data.rows).toBe(MESSAGES + 3 + 2)
    expect(
      migrated.data.migrations.map((m) => [m.name, m.state, m.done, m.total]),
    ).toEqual([
      ['messages_raw_json_v2', 'done', MESSAGES, MESSAGES],
      ['users_raw_json_v2', 'done', 3, 3],
      ['chats_raw_json_v2', 'done', 2, 2],
    ])

    const after = (await runCliSuccess(['status'], options()))
      .json as StatusOutput
    expect(after.data.migrations).toEqual([])

    // Long values read as decimal strings in tg sql (#108)
    const sql = await runCliSuccess(
      [
        'sql',
        "SELECT json_extract(raw_json, '$.accessHash') AS hash FROM users_cache WHERE user_id = '2001'",
      ],
      options(),
    )
    expect(JSON.stringify(sql.json)).toContain('"-700000000000000001"')

    // Running it again finds nothing to do
    const again = (
      await runCliSuccess(['db', 'migrate', '--account', '1'], options())
    ).json as MigrateOutput
    expect(again.data.rows).toBe(0)
  })

  it('opens a migrated cache without the write lock', async () => {
    await runCliSuccess(['db', 'migrate', '--account', '1'], options())

    // Another process holds the write lock for the whole command
    const holder = env.openCacheDb(1)
    holder.run('BEGIN IMMEDIATE')
    try {
      const status = await runCliSuccess(['status'], {
        ...options(),
        timeout: 4_000,
      })
      expect((status.json as StatusOutput).data.migrations).toEqual([])
    } finally {
      holder.run('ROLLBACK')
    }
  })
})
