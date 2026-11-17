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

  /**
   * Account 1's cache with made-up messages, a third of them deleted, and
   * one API activity row far past its retention
   */
  function seedCache() {
    const db = env.openCacheDb(1)
    db.run(
      "INSERT INTO api_activity (timestamp, method, success) VALUES (0, 'messages.getHistory', 1)",
    )
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
      ['db', 'vacuum', '--account', '1'],
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
      api_activity: 1,
      rate_limits: 0,
      completed_jobs: 0,
      failed_jobs: 0,
    })
  })

  describe('free disk before a full VACUUM', () => {
    const MARGIN = 64 * 1024 * 1024
    const withFreeDisk = (bytes: number) => ({
      env: {
        ...options().env,
        TELEGRAM_SYNC_CLI_TEST_FREE_DISK_BYTES: String(bytes),
      },
    })
    interface DiskFullOutput {
      error: {
        code: string
        message: string
        details: {
          account_id: number
          reason: string
          needed_bytes: number
          free_bytes: number
        }
        suggestion: string
      }
    }

    it('runs when the disk has room for about twice the cache', async () => {
      seedCache()

      const result = await runCliSuccess(
        ['db', 'vacuum', '--account', '1'],
        withFreeDisk(MARGIN + 100 * 1024 * 1024),
      )

      expect((result.json as VacuumOutput).data).toMatchObject({
        mode: 'full',
        auto_vacuum: 'incremental',
        free_pages_after: 0,
      })
    })

    it('fails at once and changes nothing when the disk is short', async () => {
      const db = seedCache()
      const fileBytes = Bun.file(env.cachePath(1)).size

      const result = await runCli(
        ['db', 'vacuum', '--account', '1'],
        withFreeDisk(MARGIN),
      )
      const output = result.json as DiskFullOutput

      expect(result.exitCode).toBe(1)
      expect(output.error.code).toBe('GENERAL_ERROR')
      expect(output.error.details).toEqual({
        account_id: 1,
        reason: 'disk_full',
        needed_bytes: Math.ceil(fileBytes * 2.2 + MARGIN),
        free_bytes: MARGIN,
      })
      expect(output.error.suggestion).toBe(
        'Free some disk space, or start the daemon (tg daemon start) and run tg db vacuum --account 1 again: then it releases the free pages in place, without a copy',
      )
      const activity = db
        .query('SELECT COUNT(*) AS n FROM api_activity')
        .get() as { n: number }
      expect(activity.n).toBe(1)
      const free = db.query('PRAGMA freelist_count').get() as {
        freelist_count: number
      }
      expect(free.freelist_count).toBeGreaterThan(0)
    })

    it('suggests only freeing space for a cache without auto_vacuum', async () => {
      const db = seedCache()
      db.run('PRAGMA auto_vacuum = NONE')
      db.run('VACUUM')

      const result = await runCli(
        ['db', 'vacuum', '--account', '1'],
        withFreeDisk(MARGIN),
      )
      const output = result.json as DiskFullOutput

      expect(result.exitCode).toBe(1)
      expect(output.error.details.reason).toBe('disk_full')
      expect(output.error.suggestion).toBe(
        'Free some disk space, then run tg db vacuum --account 1 again',
      )
    })

    it("doesn't check the disk for the incremental mode", async () => {
      seedCache()
      writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))

      const result = await runCliSuccess(
        ['db', 'vacuum', '--account', '1'],
        withFreeDisk(1),
      )

      expect((result.json as VacuumOutput).data.mode).toBe('incremental')
    })
  })

  it('refuses a cache without auto_vacuum while the daemon runs', async () => {
    const db = seedCache()
    db.run('PRAGMA auto_vacuum = NONE')
    db.run('VACUUM')
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))

    const result = await runCli(['db', 'vacuum', '--account', '1'], options())
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
    expect(output.error.suggestion).toBe(
      'tg daemon stop && tg db vacuum --account 1 && tg daemon start',
    )
    const autoVacuum = db.query('PRAGMA auto_vacuum').get() as {
      auto_vacuum: number
    }
    expect(autoVacuum.auto_vacuum).toBe(0)
    const activity = db
      .query('SELECT COUNT(*) AS n FROM api_activity')
      .get() as { n: number }
    expect(activity.n).toBe(1)
  })

  it('releases free pages in steps while the daemon runs', async () => {
    seedCache()
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))

    const result = await runCliSuccess(
      ['db', 'vacuum', '--account', '1'],
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
      ['db', 'vacuum', '--account', '2'],
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
