/**
 * E2E tests for the sql command
 *
 * Runs read-only queries through the real CLI argument parser, which unit
 * tests of the run() function bypass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: SQL Command', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('sql')
    env.initDatabase()
  })

  afterEach(() => {
    env.cleanup()
  })

  it.each([
    ['--query', ['sql', '--query', 'SELECT 1 AS one']],
    ['--query=', ['sql', '--query=SELECT 1 AS one']],
    ['a positional query', ['sql', 'SELECT 1 AS one']],
  ])('runs a query passed as %s', async (_label, args) => {
    const result = await runCliSuccess(args, env.getCliOptions())

    expect(result.json).toEqual({
      success: true,
      data: { columns: ['one'], rows: [{ one: 1 }], rowCount: 1 },
    })
  })

  it('queries the cache schema', async () => {
    const result = await runCliSuccess(
      ['sql', '--query', 'SELECT COUNT(*) AS n FROM messages_cache'],
      env.getCliOptions(),
    )

    expect(result.json).toMatchObject({
      success: true,
      data: { rows: [{ n: 0 }] },
    })
  })

  it('rejects write queries', async () => {
    const result = await runCliFailure(
      ['sql', '--query', 'DELETE FROM messages_cache'],
      1,
      env.getCliOptions(),
    )

    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'SQL_WRITE_NOT_ALLOWED' },
    })
  })
})
