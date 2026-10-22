/**
 * E2E tests for tg db vacuum: pruning and compacting an account's cache,
 * without Telegram credentials. Made-up data only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createMessagesCache } from '../db/messages-cache'
import { NO_CREDENTIALS, runCli, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

interface VacuumOutput {
  success: boolean
  data: {
    account_id: number
    mode: string
    bytes_before: number
    bytes_after: number
    freed_bytes: number
    free_pages_after: number
    auto_vacuum: string | null
    pruned: Record<string, number>
    checkpointed: boolean
  }
}

describe('E2E: db vacuum', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('db-vacuum')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000001', is_active: true },
      { phone: '+15550000002' },
    ])
  })

  afterEach(() => {
    env.cleanup()
  })

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  })

  /** Account 1's cache with made-up messages, a third of them deleted */
  function seedCache() {
    const db = env.openCacheDb(1)
    createMessagesCache(db).upsertBatch(
      Array.from({ length: 600 }, (_, i) => ({
        chat_id: 101,
        message_id: i + 1,
        text: `made-up note ${i + 1} about the weekly plan`,
        message_type: 'text',
        date: 1_760_000_000 + i,
        raw_json: '{}',
      })),
    )
    db.run('DELETE FROM messages_cache WHERE message_id % 3 = 0')
    return db
  }

  it('compacts the cache with a full VACUUM while no daemon runs', async () => {
    seedCache()

    const result = await runCliSuccess(
      ['db', 'vacuum', '--account', '1', '--json'],
      options(),
    )
    const { data } = result.json as VacuumOutput

    expect(data).toMatchObject({
      account_id: 1,
      mode: 'full',
      auto_vacuum: 'incremental',
      free_pages_after: 0,
    })
    expect(typeof data.bytes_before).toBe('number')
    expect(typeof data.bytes_after).toBe('number')
    expect(data.pruned).toEqual({
      api_activity: 0,
      rate_limits: 0,
      completed_jobs: 0,
      failed_jobs: 0,
    })
  })

  it('refuses a cache without auto_vacuum while the daemon runs', async () => {
    const db = seedCache()
    db.run('PRAGMA auto_vacuum = NONE')
    db.run('VACUUM')
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))

    const result = await runCli(
      ['db', 'vacuum', '--account', '1', '--json'],
      options(),
    )
    const output = result.json as {
      error: {
        code: string
        details: Record<string, unknown>
        suggestion: string
      }
    }

    expect(result.exitCode).toBe(1)
    expect(output.error.code).toBe('DAEMON_ALREADY_RUNNING')
    expect(output.error.details).toEqual({ account_id: 1, auto_vacuum: 'none' })
    expect(output.error.suggestion).toContain('tg daemon stop')
    const autoVacuum = db.query('PRAGMA auto_vacuum').get() as {
      auto_vacuum: number
    }
    expect(autoVacuum.auto_vacuum).toBe(0)
  })

  it('releases free pages in steps while the daemon runs', async () => {
    seedCache()
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))

    const result = await runCliSuccess(
      ['db', 'vacuum', '--account', '1', '--json'],
      options(),
    )

    expect((result.json as VacuumOutput).data).toMatchObject({
      mode: 'incremental',
      auto_vacuum: 'incremental',
      free_pages_after: 0,
    })
  })

  it('skips an account without a cache file and creates none', async () => {
    const result = await runCliSuccess(
      ['db', 'vacuum', '--account', '2', '--json'],
      options(),
    )

    expect((result.json as VacuumOutput).data).toMatchObject({
      account_id: 2,
      mode: 'skipped',
    })
    expect(existsSync(env.cachePath(2))).toBe(false)
  })

  it('shows its help without Telegram credentials', async () => {
    const result = await runCliSuccess(['db', 'vacuum', '--help'], options())

    expect(result.stdout).toContain('vacuum')
    expect(result.stdout).toContain('--account')
  })
})
