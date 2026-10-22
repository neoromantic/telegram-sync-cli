/**
 * E2E tests for config commands
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runCli, runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: Config Commands', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('config')
    env.initDatabase()
  })

  afterEach(() => {
    env.cleanup()
  })

  it('shows config path', async () => {
    const result = await runCliSuccess(['config', 'path'], env.getCliOptions())

    const response = result.json as {
      success: boolean
      data: { path: string }
    }
    expect(response.success).toBe(true)
    expect(response.data.path).toBe(join(env.dataDir, 'config.json'))
  })

  it('sets and gets config values', async () => {
    await runCliSuccess(
      ['config', 'set', 'cache.staleness.peers', '2d'],
      env.getCliOptions(),
    )

    const result = await runCliSuccess(
      ['config', 'get', 'cache.staleness.peers'],
      env.getCliOptions(),
    )

    const response = result.json as {
      success: boolean
      data: { key: string; value: string | null }
    }
    expect(response.success).toBe(true)
    expect(response.data.key).toBe('cache.staleness.peers')
    expect(response.data.value).toBe('2d')
  })

  it('rejects invalid values', async () => {
    const result = await runCliFailure(
      ['config', 'set', 'activeAccount', '0'],
      3,
      env.getCliOptions(),
    )

    const response = result.json as {
      success: boolean
      error: { code: string; message: string }
    }
    expect(response.success).toBe(false)
    expect(response.error.code).toBe('INVALID_ARGS')
  })

  // Every other command checks config.json at start; tg config has to be
  // able to repair it, whatever the output flags before it
  it('repairs an invalid config.json with any output format', async () => {
    const path = join(env.dataDir, 'config.json')
    const formats = [[], ['-q'], ['-f', 'pretty'], ['--format', 'quiet']]
    for (const format of formats) {
      writeFileSync(path, '{"activeAccount":"one"}')

      await runCliSuccess(
        [...format, 'config', 'set', 'activeAccount', '1'],
        env.getCliOptions(),
      )

      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        activeAccount: 1,
      })
    }
  })

  it.skipIf(process.getuid?.() === 0)(
    'fails at start with GENERAL_ERROR when config.json is unreadable',
    async () => {
      const path = join(env.dataDir, 'config.json')
      writeFileSync(path, '{"activeAccount":1}')
      chmodSync(path, 0o000)
      try {
        const result = await runCliFailure(
          ['accounts', 'list'],
          1,
          env.getCliOptions(),
        )
        expect(JSON.parse(result.stderr).error).toEqual(
          expect.objectContaining({
            code: 'GENERAL_ERROR',
            details: { path },
          }),
        )

        // -q prints nothing, not a stack trace
        const quiet = await runCli(
          ['-q', 'accounts', 'list'],
          env.getCliOptions(),
        )
        expect(quiet.exitCode).toBe(1)
        expect(quiet.stderr).toBe('')
      } finally {
        chmodSync(path, 0o644)
      }
    },
  )

  // The daemon's own -q also sets the root one, so a startup check would
  // stop a supervised daemon over a key it never reads, with no output
  it('starts tg daemon with an invalid config.json, -q included', async () => {
    writeFileSync(
      join(env.dataDir, 'config.json'),
      '{"cache":{"staleness":{"peers":"3 days"}}}',
    )

    for (const args of [
      ['daemon', 'start', '--quiet'],
      ['daemon', 'start', '-q'],
      ['daemon', 'start'],
    ]) {
      // With no account the daemon stops right after the check would have
      // run, and logs why even under -q
      const result = await runCli(args, env.getCliOptions())
      expect(result.stderr).toContain('No accounts configured')
      expect(result.stderr).not.toContain('INVALID_ARGS')
      expect(result.exitCode).toBe(3)
    }

    const status = await runCliSuccess(
      ['daemon', 'status'],
      env.getCliOptions(),
    )
    expect(status.json).toMatchObject({ data: { status: 'stopped' } })
  })

  it('starts tg daemon with a bad retention, warning once', async () => {
    writeFileSync(
      join(env.dataDir, 'config.json'),
      '{"cache":{"retention":{"apiActivity":"0s"}}}',
    )

    const result = await runCli(['daemon', 'start'], env.getCliOptions())

    expect(result.stderr).toContain('cache.retention.apiActivity')
    expect(result.stderr.match(/\[WARN\]/g)).toHaveLength(1)
    expect(result.stderr).toContain('No accounts configured')
    expect(result.exitCode).toBe(3)
  })

  it('runs tg skill with an invalid config.json under -f json', async () => {
    writeFileSync(join(env.dataDir, 'config.json'), '{"activeAccount":"one"}')

    const result = await runCliSuccess(
      ['-f', 'json', 'skill', 'manifest'],
      env.getCliOptions(),
    )

    expect((result.json as { success: boolean }).success).toBe(true)
  })
})
