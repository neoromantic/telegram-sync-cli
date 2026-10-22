/**
 * E2E tests for config commands
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runCliFailure, runCliSuccess } from './helpers/cli'
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

  it('runs tg skill with an invalid config.json under -f json', async () => {
    writeFileSync(join(env.dataDir, 'config.json'), '{"activeAccount":"one"}')

    const result = await runCliSuccess(
      ['-f', 'json', 'skill', 'manifest'],
      env.getCliOptions(),
    )

    expect((result.json as { success: boolean }).success).toBe(true)
  })
})
