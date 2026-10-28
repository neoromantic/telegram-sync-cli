/**
 * E2E tests for the sql command
 *
 * Runs read-only queries through the real CLI argument parser, which unit
 * tests of the run() function bypass.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { seedInChild } from '../__tests__/helpers/seed-in-child'
import { createMessagesCache } from '../db/messages-cache'
import { runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

/** "Messages per chat, with titles" in docs/sql.md */
const MESSAGES_PER_CHAT =
  'SELECT m.chat_id, c.title, c.type, COUNT(*) AS messages FROM messages_cache m LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT) GROUP BY m.chat_id ORDER BY messages DESC, m.chat_id LIMIT 10'

describe('E2E: SQL Command', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('sql')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000001', is_active: true }])
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

  it('runs the docs example that lists messages per chat with titles on a cache from 0.2.0', async () => {
    // The shared cache of 0.3 and older moves to the only account first
    const legacyPath = join(env.dataDir, 'cache.db')
    seedInChild(legacyPath, 'legacySharedCache')

    const result = await runCliSuccess(
      ['sql', '--query', MESSAGES_PER_CHAT],
      env.getCliOptions(),
    )
    expect(existsSync(legacyPath)).toBe(false)
    expect(existsSync(env.cachePath(1))).toBe(true)

    expect(result.json).toEqual({
      success: true,
      data: {
        columns: ['chat_id', 'title', 'type', 'messages'],
        rows: [
          {
            chat_id: -1001234567890,
            title: 'Team Chat',
            type: 'supergroup',
            messages: 2,
          },
          {
            chat_id: -1002222222222,
            title: 'Example News',
            type: 'channel',
            messages: 1,
          },
          { chat_id: -4242, title: 'Book Club', type: 'group', messages: 1 },
          { chat_id: 10, title: 'Alice Able', type: 'private', messages: 1 },
        ],
        rowCount: 4,
      },
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

  it('reads search matches with their text from the message_search_text view', async () => {
    const db = env.openCacheDb(1)
    createMessagesCache(db).upsertBatch(
      [
        [1, 'the deploy failed'],
        [2, 'lunch at noon'],
        [3, 'deploy again, deploy now'],
      ].map(([message_id, text]) => ({
        chat_id: -1001234567890,
        message_id: message_id as number,
        from_id: 10,
        text: text as string,
        message_type: 'text',
        date: 1_760_000_000 + (message_id as number),
        raw_json: '{}',
      })),
    )

    const result = await runCliSuccess(
      [
        'sql',
        '--query',
        "SELECT message_id, text FROM message_search_text WHERE message_search_text MATCH 'deploy' ORDER BY rank",
      ],
      env.getCliOptions(),
    )

    expect(result.json).toMatchObject({
      success: true,
      data: {
        rows: [
          { message_id: 3, text: 'deploy again, deploy now' },
          { message_id: 1, text: 'the deploy failed' },
        ],
      },
    })
  })

  describe('on a read-only connection', () => {
    function userVersion(): number {
      const db = new Database(env.cachePath(1), { readonly: true })
      try {
        return (
          db.query('PRAGMA user_version').get() as { user_version: number }
        ).user_version
      } finally {
        db.close()
      }
    }

    beforeEach(async () => {
      // The first command creates and migrates the cache
      await runCliSuccess(['sql', 'SELECT 1'], env.getCliOptions())
    })

    it('refuses PRAGMA writes and leaves the file unchanged', async () => {
      const before = userVersion()
      expect(before).toBeGreaterThan(0)

      for (const query of [
        'PRAGMA user_version = 0',
        'PRAGMA user_version=0;',
        'PRAGMA user_version(0)',
        'PRAGMA wal_checkpoint(TRUNCATE)',
        'PRAGMA incremental_vacuum',
      ]) {
        const result = await runCliFailure(
          ['sql', '--query', query],
          1,
          env.getCliOptions(),
        )
        expect(result.json).toMatchObject({
          success: false,
          error: { code: 'SQL_WRITE_NOT_ALLOWED' },
        })
      }
      expect(userVersion()).toBe(before)
    })

    it('still reads pragmas', async () => {
      const version = await runCliSuccess(
        ['sql', 'PRAGMA user_version'],
        env.getCliOptions(),
      )
      expect(version.json).toMatchObject({
        success: true,
        data: { rows: [{ user_version: userVersion() }] },
      })

      const columns = await runCliSuccess(
        ['sql', 'PRAGMA table_info(messages_cache)'],
        env.getCliOptions(),
      )
      const rows = (columns.json as { data: { rows: Array<{ name: string }> } })
        .data.rows
      expect(rows.map((row) => row.name)).toContain('text')
    })
  })
})
