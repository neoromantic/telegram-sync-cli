/**
 * SQL command integration tests
 */
import type { Database } from 'bun:sqlite'
import type { Mock } from 'bun:test'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'

import { createTestCacheDatabase } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import type { ErrorCode } from '../types'
import { ErrorCodes } from '../types'
import { setOutputFormat } from '../utils/output'

let testCacheDb: Database

type CommandRun = (input: { args: Record<string, unknown> }) => Promise<void>

mock.module('../db', () => ({
  getCacheDb: () => testCacheDb,
}))

async function expectCommandError(
  run: Promise<unknown>,
  code: ErrorCode,
): Promise<void> {
  try {
    await run
  } catch (err) {
    expect((err as { code?: ErrorCode }).code).toBe(code)
    return
  }
  throw new Error('Expected command to throw')
}

describe('SQL Commands', () => {
  let logSpy: Mock<typeof console.log>
  let errorSpy: Mock<typeof console.error>

  beforeEach(() => {
    const { db } = createTestCacheDatabase()
    testCacheDb = db
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
    setOutputFormat('json')

    const usersCache = createUsersCache(testCacheDb)
    usersCache.upsert({
      user_id: '1',
      username: 'alice',
      first_name: 'Alice',
      last_name: 'Doe',
      phone: null,
      access_hash: null,
      is_contact: 1,
      is_bot: 0,
      is_premium: 0,
      fetched_at: Date.now(),
      raw_json: JSON.stringify({ id: 1, username: 'alice' }),
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    setOutputFormat('json')
    testCacheDb.close()
  })

  describe('sqlQueryCommand', () => {
    it('returns JSON output for valid query', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun

      await run({
        args: {
          query: 'SELECT user_id, username FROM users_cache',
          output: 'json',
          limit: '1000',
          _: [],
        },
      })

      expect(logSpy).toHaveBeenCalled()
      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(parsed.success).toBe(true)
      expect(parsed.data.rowCount).toBe(1)
      expect(parsed.data.columns).toEqual(['user_id', 'username'])
    })

    it('prints CSV output when output=csv', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun

      await run({
        args: {
          query: 'SELECT user_id FROM users_cache',
          output: 'csv',
          limit: '1000',
          _: [],
        },
      })

      expect(logSpy).toHaveBeenCalled()
      const firstCall = logSpy.mock.calls[0]?.[0] as string
      expect(firstCall).toContain('user_id')
    })

    it('rejects missing query', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun
      await expectCommandError(
        run({ args: { _: [] } }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects invalid output', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun
      await expectCommandError(
        run({
          args: { query: 'SELECT 1', output: 'xml', limit: '10', _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects invalid limit', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun
      await expectCommandError(
        run({
          args: { query: 'SELECT 1', output: 'json', limit: '-1', _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects write queries', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun
      await expectCommandError(
        run({
          args: { query: 'DELETE FROM users_cache', output: 'json', _: [] },
        }),
        ErrorCodes.SQL_WRITE_NOT_ALLOWED,
      )
    })

    it('reports syntax errors', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun
      await expectCommandError(
        run({
          args: {
            query: 'SELECT * FORM users_cache',
            output: 'json',
            _: [],
          },
        }),
        ErrorCodes.SQL_SYNTAX_ERROR,
      )
    })

    it('reports missing tables', async () => {
      const { sqlQueryCommand } = await import('../commands/sql/query')
      const run = sqlQueryCommand.run as CommandRun
      await expectCommandError(
        run({
          args: {
            query: 'SELECT * FROM missing_table',
            output: 'json',
            _: [],
          },
        }),
        ErrorCodes.SQL_TABLE_NOT_FOUND,
      )
    })
  })

  describe('printSchemaCommand', () => {
    it('prints JSON schema for a table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { table: 'users_cache', format: 'json', _: [] },
      })

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(parsed.success).toBe(true)
      expect(parsed.data.table).toBe('users_cache')
      expect(parsed.data.columns.length).toBeGreaterThan(0)
    })

    it('describes the retry columns of sync_jobs', async () => {
      initSyncSchema(testCacheDb)
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { table: 'sync_jobs', format: 'json', _: [] },
      })

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      const columns = Object.fromEntries(
        (parsed.data.columns as Array<{ name: string }>).map((col) => [
          col.name,
          col,
        ]),
      )
      expect(columns.attempts).toMatchObject({
        type: 'INTEGER',
        nullable: false,
        defaultValue: '0',
        description: expect.stringContaining('FLOOD_WAIT does not count'),
      })
      expect(columns.next_run_at).toMatchObject({
        type: 'INTEGER',
        defaultValue: '0',
        semanticType: 'timestamp',
        description: expect.stringContaining('0 means now'),
      })
    })

    it('describes every chat and sender ID column as a marked peer ID', async () => {
      initSyncSchema(testCacheDb)
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun
      const tables = [
        'chats_cache',
        'messages_cache',
        'chat_sync_state',
        'sync_jobs',
        'history_ranges',
      ]

      const descriptions: Record<string, string> = {}
      for (const [index, table] of tables.entries()) {
        await run({ args: { table, format: 'json', _: [] } })
        const parsed = JSON.parse(logSpy.mock.calls[index]?.[0] as string)
        for (const col of parsed.data.columns as Array<{
          name: string
          description: string
        }>) {
          if (['chat_id', 'from_id', 'forward_from_id'].includes(col.name)) {
            const key = col.name === 'chat_id' ? table : `${table}.${col.name}`
            descriptions[key] = col.description
          }
        }
      }

      expect(descriptions).toEqual({
        'messages_cache.from_id':
          'Marked peer ID of the sender: a user ID, or -N / -100… for a group or channel that posts as itself. Null when the message names no sender, such as a channel post fetched from history',
        'messages_cache.forward_from_id':
          'Marked peer ID of the original sender of a forwarded message: a user ID, or -N / -100… for a group or channel',
        chats_cache:
          'Marked peer ID, as messages_cache.chat_id holds it: the user ID for a private chat, -N for basic group N, -100… for a supergroup, channel or community',
        messages_cache:
          'Marked peer ID of the chat: the user ID for a private chat, -N for basic group N, -100… for a supergroup or channel. Joins chats_cache on chats_cache.chat_id = CAST(chat_id AS TEXT)',
        chat_sync_state:
          'Marked peer ID of the chat being synchronized, as in messages_cache',
        sync_jobs: 'Marked peer ID of the chat to sync, as in messages_cache',
        history_ranges:
          'Marked peer ID of the chat the range belongs to, as in messages_cache',
      })
    })

    it('prints text schema for a table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { table: 'users_cache', output: 'text', _: [] },
      })

      expect(logSpy).toHaveBeenCalled()
      const firstCall = logSpy.mock.calls[0]?.[0] as string
      expect(firstCall).toContain('users_cache')
    })

    it('prints sql schema for a table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { table: 'users_cache', output: 'sql', _: [] },
      })

      expect(logSpy).toHaveBeenCalled()
      const firstCall = logSpy.mock.calls[0]?.[0] as string
      expect(firstCall).toContain('CREATE TABLE users_cache')
      expect(firstCall).toContain('-- ')
    })

    it('rejects invalid output format', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun
      await expectCommandError(
        run({
          args: { table: 'users_cache', output: 'yaml', _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      )
    })

    it('rejects unknown table', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun
      await expectCommandError(
        run({
          args: { table: 'unknown_table', output: 'json', _: [] },
        }),
        ErrorCodes.SQL_TABLE_NOT_FOUND,
      )
    })

    it('prints JSON schema for all tables when no table specified', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { output: 'json', _: [] },
      })

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string)
      expect(parsed.success).toBe(true)
      expect(parsed.data.version).toBeGreaterThan(0)
      expect(Array.isArray(parsed.data.tables)).toBe(true)
      expect(parsed.data.tables.length).toBeGreaterThan(0)
      // Verify table structure
      const firstTable = parsed.data.tables[0]
      expect(firstTable).toHaveProperty('name')
      expect(firstTable).toHaveProperty('description')
      expect(firstTable).toHaveProperty('primaryKey')
      expect(firstTable).toHaveProperty('columnCount')
    })

    it('prints text schema for all tables with separators', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { output: 'text', _: [] },
      })

      // Should be called multiple times (once per table + separator lines)
      expect(logSpy.mock.calls.length).toBeGreaterThan(2)

      // Check that separator lines are present (=.repeat(80))
      const calls = logSpy.mock.calls.map((c) => c[0] as string)
      const separatorCalls = calls.filter(
        (c) => typeof c === 'string' && c.includes('='.repeat(80)),
      )
      expect(separatorCalls.length).toBeGreaterThan(0)

      // Check that table names are present
      const hasUsersCache = calls.some(
        (c) => typeof c === 'string' && c.includes('users_cache'),
      )
      expect(hasUsersCache).toBe(true)
    })

    it('prints SQL schema for all tables with separators', async () => {
      const { printSchemaCommand } = await import(
        '../commands/sql/print-schema'
      )
      const run = printSchemaCommand.run as CommandRun

      await run({
        args: { output: 'sql', _: [] },
      })

      // Should be called multiple times (once per table + separator lines)
      expect(logSpy.mock.calls.length).toBeGreaterThan(2)

      // Check that SQL separator lines are present (-- .repeat(27))
      const calls = logSpy.mock.calls.map((c) => c[0] as string)
      const separatorCalls = calls.filter(
        (c) => typeof c === 'string' && c.includes('-- '.repeat(27)),
      )
      expect(separatorCalls.length).toBeGreaterThan(0)

      // Check that CREATE TABLE statements are present
      const createTableCalls = calls.filter(
        (c) => typeof c === 'string' && c.includes('CREATE TABLE'),
      )
      expect(createTableCalls.length).toBeGreaterThan(0)
    })
  })
})
