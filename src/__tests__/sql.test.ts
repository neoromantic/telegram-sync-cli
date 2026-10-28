/**
 * SQL command tests
 */
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { CHAT_TYPE_VALUES } from '../commands/chats/helpers'
import {
  applyQueryLimit,
  hasSeveralStatements,
  isReadOnlyQuery,
} from '../commands/sql/helpers'
import { formatSchemaAsSql } from '../commands/sql/schema-text'
import { initCacheSchema } from '../db/schema'
import {
  getColumnAnnotation,
  getColumnNames,
  getTableAnnotation,
  getTableNames,
  SCHEMA_REGISTRY,
} from '../db/schema-annotations'
import { initSyncSchema } from '../db/sync-schema'
import { stringify as stringifyCsv } from '../utils/csv'

describe('SQL Command', () => {
  describe('isReadOnlyQuery', () => {
    it('allows SELECT statements', () => {
      expect(isReadOnlyQuery('SELECT * FROM users_cache')).toBe(true)
    })

    it('allows SELECT with lowercase', () => {
      expect(isReadOnlyQuery('select * from users_cache')).toBe(true)
    })

    it('allows SELECT with mixed case', () => {
      expect(isReadOnlyQuery('Select * From users_cache')).toBe(true)
    })

    it('allows SELECT with JOIN', () => {
      expect(
        isReadOnlyQuery(
          'SELECT u.*, c.title FROM users_cache u JOIN chats_cache c ON u.user_id = c.chat_id',
        ),
      ).toBe(true)
    })

    it('allows SELECT with subquery', () => {
      expect(
        isReadOnlyQuery(
          'SELECT * FROM users_cache WHERE user_id IN (SELECT from_id FROM messages_cache)',
        ),
      ).toBe(true)
    })

    it('allows SELECT with CTE', () => {
      expect(
        isReadOnlyQuery(
          'WITH recent AS (SELECT * FROM messages_cache LIMIT 10) SELECT * FROM recent',
        ),
      ).toBe(true)
    })

    it('refuses setting a pragma', () => {
      expect(isReadOnlyQuery('PRAGMA user_version = 0')).toBe(false)
      expect(isReadOnlyQuery('pragma main.journal_mode=DELETE')).toBe(false)
      expect(isReadOnlyQuery('PRAGMA query_only = OFF')).toBe(false)
      expect(isReadOnlyQuery('PRAGMA user_version')).toBe(true)
    })

    it('refuses a pragma that sets a value with an argument', () => {
      expect(isReadOnlyQuery('PRAGMA writable_schema(1)')).toBe(false)
      expect(isReadOnlyQuery('PRAGMA journal_mode(OFF)')).toBe(false)
      expect(isReadOnlyQuery('PRAGMA main.user_version (0)')).toBe(false)
      expect(isReadOnlyQuery('PRAGMA table_info(messages_cache)')).toBe(true)
      expect(isReadOnlyQuery('pragma main.index_list(messages_cache)')).toBe(
        true,
      )
      expect(isReadOnlyQuery('PRAGMA integrity_check(10)')).toBe(true)
    })

    it('finds a second statement outside strings and comments', () => {
      expect(hasSeveralStatements('SELECT 1; PRAGMA user_version = 0')).toBe(
        true,
      )
      expect(hasSeveralStatements('SELECT 1;SELECT 2')).toBe(true)
      expect(hasSeveralStatements('SELECT 1;')).toBe(false)
      expect(hasSeveralStatements('SELECT 1; -- done')).toBe(false)
      expect(hasSeveralStatements('SELECT \'a; b\', "c;d" FROM t')).toBe(false)
      expect(hasSeveralStatements("SELECT 'it''s; ok' /* ; */")).toBe(false)
    })

    it('allows PRAGMA statements', () => {
      expect(isReadOnlyQuery('PRAGMA table_info(users_cache)')).toBe(true)
    })

    it('blocks INSERT statements', () => {
      expect(
        isReadOnlyQuery("INSERT INTO users_cache VALUES ('1', 'test')"),
      ).toBe(false)
    })

    it('blocks UPDATE statements', () => {
      expect(
        isReadOnlyQuery(
          "UPDATE users_cache SET username = 'new' WHERE user_id = '1'",
        ),
      ).toBe(false)
    })

    it('blocks DELETE statements', () => {
      expect(
        isReadOnlyQuery("DELETE FROM users_cache WHERE user_id = '1'"),
      ).toBe(false)
    })

    it('blocks DROP statements', () => {
      expect(isReadOnlyQuery('DROP TABLE users_cache')).toBe(false)
    })

    it('blocks ALTER statements', () => {
      expect(
        isReadOnlyQuery('ALTER TABLE users_cache ADD COLUMN test TEXT'),
      ).toBe(false)
    })

    it('blocks CREATE statements', () => {
      expect(isReadOnlyQuery('CREATE TABLE test (id INTEGER)')).toBe(false)
    })

    it('blocks ATTACH statements', () => {
      expect(isReadOnlyQuery("ATTACH 'other.db' AS other")).toBe(false)
    })

    it('blocks DETACH statements', () => {
      expect(isReadOnlyQuery('DETACH other')).toBe(false)
    })

    it('blocks TRUNCATE statements', () => {
      expect(isReadOnlyQuery('TRUNCATE TABLE users_cache')).toBe(false)
    })

    it('blocks VACUUM statements', () => {
      expect(isReadOnlyQuery('VACUUM')).toBe(false)
    })

    it('blocks REINDEX statements', () => {
      expect(isReadOnlyQuery('REINDEX users_cache')).toBe(false)
    })

    it('blocks REPLACE statements', () => {
      expect(
        isReadOnlyQuery("REPLACE INTO users_cache VALUES ('1', 'test')"),
      ).toBe(false)
    })

    it('blocks INSERT even after SELECT', () => {
      // Someone might try to bypass by putting SELECT first
      expect(
        isReadOnlyQuery('SELECT 1; INSERT INTO users_cache VALUES (1)'),
      ).toBe(false)
    })

    it('blocks DELETE in CTE', () => {
      expect(
        isReadOnlyQuery(
          'WITH deleted AS (DELETE FROM users_cache RETURNING *) SELECT * FROM deleted',
        ),
      ).toBe(false)
    })
  })

  describe('applyQueryLimit', () => {
    it('appends a limit when none is present', () => {
      expect(applyQueryLimit('SELECT * FROM users_cache', 100)).toBe(
        'SELECT * FROM users_cache LIMIT 100',
      )
    })

    it('does not append when a LIMIT already exists', () => {
      expect(applyQueryLimit('SELECT * FROM users_cache LIMIT 5', 100)).toBe(
        'SELECT * FROM users_cache LIMIT 5',
      )
    })

    it('detects LIMIT across newlines', () => {
      expect(applyQueryLimit('SELECT * FROM users_cache\nLIMIT 5', 100)).toBe(
        'SELECT * FROM users_cache\nLIMIT 5',
      )
    })

    it('strips trailing semicolons before appending', () => {
      expect(applyQueryLimit('SELECT * FROM users_cache;', 10)).toBe(
        'SELECT * FROM users_cache LIMIT 10',
      )
    })

    it('strips trailing semicolons when no limit is applied', () => {
      expect(applyQueryLimit('SELECT * FROM users_cache;', 0)).toBe(
        'SELECT * FROM users_cache',
      )
    })
  })

  describe('Schema Annotations', () => {
    it('has users_cache table', () => {
      const annotation = getTableAnnotation('users_cache')
      expect(annotation).toBeDefined()
      expect(annotation?.description).toContain('user')
    })

    it('has chats_cache table', () => {
      const annotation = getTableAnnotation('chats_cache')
      expect(annotation).toBeDefined()
      expect(annotation?.primaryKey).toBe('chat_id')
    })

    it('has messages_cache table', () => {
      const annotation = getTableAnnotation('messages_cache')
      expect(annotation).toBeDefined()
      expect(annotation?.primaryKey).toEqual(['chat_id', 'message_id'])
    })

    it('returns undefined for non-existent table', () => {
      const annotation = getTableAnnotation('nonexistent_table')
      expect(annotation).toBeUndefined()
    })

    it('has column annotations', () => {
      const col = getColumnAnnotation('users_cache', 'username')
      expect(col).toBeDefined()
      expect(col?.description).toBeDefined()
      expect(col?.semanticType).toBe('username')
    })

    it('returns all table names', () => {
      const tables = getTableNames()
      expect(tables).toContain('users_cache')
      expect(tables).toContain('chats_cache')
      expect(tables).toContain('messages_cache')
      expect(tables).toContain('sync_state')
    })

    it('describes every column of history_ranges', () => {
      const db = new Database(':memory:')
      initCacheSchema(db)
      initSyncSchema(db)
      const columns = (
        db.query('PRAGMA table_info(history_ranges)').all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
      db.close()

      expect(getColumnNames('history_ranges').sort()).toEqual(columns.sort())
    })

    it('describes every column of message_attachments, with its index', () => {
      const db = new Database(':memory:')
      initCacheSchema(db)
      initSyncSchema(db)
      const columns = (
        db.query('PRAGMA table_info(message_attachments)').all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
      const indexes = (
        db.query('PRAGMA index_list(message_attachments)').all() as Array<{
          name: string
        }>
      )
        .map((index) => index.name)
        .filter((name) => !name.startsWith('sqlite_'))
      const sql = formatSchemaAsSql(
        'message_attachments',
        getTableAnnotation('message_attachments')!,
        db,
      )
      db.close()

      expect(sql).toContain('CREATE TABLE message_attachments')
      expect(sql).toContain('idx_message_attachments_unique_file_id')
      expect(getTableNames()).toContain('message_attachments')
      expect(getColumnNames('message_attachments')).toEqual(columns)
      expect(
        Object.keys(getTableAnnotation('message_attachments')?.indexes ?? {}),
      ).toEqual(indexes)
      expect(
        getColumnAnnotation('message_attachments', 'kind')?.enumValues,
      ).toContain('round')
    })

    it('describes every column of the message_search_text view, in order', () => {
      const db = new Database(':memory:')
      initCacheSchema(db)
      initSyncSchema(db)
      const columns = (
        db.query('PRAGMA table_info(message_search_text)').all() as Array<{
          name: string
        }>
      ).map((column) => column.name)
      const sql = formatSchemaAsSql(
        'message_search_text',
        getTableAnnotation('message_search_text')!,
        db,
      )
      db.close()

      expect(getColumnNames('message_search_text')).toEqual(columns)
      expect(sql).toContain('CREATE VIEW message_search_text (')
    })

    it('returns column names for table', () => {
      const columns = getColumnNames('users_cache')
      expect(columns).toContain('user_id')
      expect(columns).toContain('username')
      expect(columns).toContain('first_name')
    })

    it('returns empty array for non-existent table', () => {
      const columns = getColumnNames('nonexistent_table')
      expect(columns).toEqual([])
    })

    it('has TTL on cache tables', () => {
      const usersCache = getTableAnnotation('users_cache')
      expect(usersCache?.ttl).toBe('1 week')
      expect(usersCache?.ttlMs).toBe(7 * 24 * 60 * 60 * 1000)
    })

    it('has enum values for type columns', () => {
      const chatType = getColumnAnnotation('chats_cache', 'type')
      expect(chatType?.enumValues).toContain('private')
      expect(chatType?.enumValues).toContain('group')
      expect(chatType?.enumValues).toContain('channel')
    })

    it('lists every chat type in the schema annotations', () => {
      expect(getColumnAnnotation('chats_cache', 'type')?.enumValues).toEqual([
        ...CHAT_TYPE_VALUES,
      ])
      expect(
        getColumnAnnotation('chat_sync_state', 'chat_type')?.enumValues,
      ).toEqual([...CHAT_TYPE_VALUES])
    })

    it('has schema version', () => {
      expect(SCHEMA_REGISTRY.version).toBeGreaterThanOrEqual(1)
    })
  })

  describe('CSV Formatting', () => {
    it('formats simple data', () => {
      const data = [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]
      const csv = stringifyCsv(data)
      expect(csv).toBe('id,name\n1,Alice\n2,Bob')
    })

    it('escapes quotes in values', () => {
      const data = [{ text: 'Hello "world"' }]
      const csv = stringifyCsv(data)
      expect(csv).toContain('"Hello ""world"""')
    })

    it('quotes values with commas', () => {
      const data = [{ text: 'hello, world' }]
      const csv = stringifyCsv(data)
      expect(csv).toContain('"hello, world"')
    })

    it('quotes values with newlines', () => {
      const data = [{ text: 'line1\nline2' }]
      const csv = stringifyCsv(data)
      expect(csv).toContain('"line1\nline2"')
    })

    it('handles NULL values as empty', () => {
      const data = [{ name: null }]
      const csv = stringifyCsv(data)
      expect(csv).toBe('name\n')
    })

    it('handles undefined values as empty', () => {
      const data = [{ name: undefined }]
      const csv = stringifyCsv(data)
      expect(csv).toBe('name\n')
    })

    it('respects column order', () => {
      const data = [{ b: 2, a: 1 }]
      const csv = stringifyCsv(data, ['a', 'b'])
      expect(csv).toBe('a,b\n1,2')
    })

    it('can skip header row', () => {
      const data = [{ id: 1 }]
      const csv = stringifyCsv(data, undefined, { includeHeader: false })
      expect(csv).toBe('1')
    })

    it('can use custom delimiter', () => {
      const data = [{ a: 1, b: 2 }]
      const csv = stringifyCsv(data, undefined, { delimiter: '\t' })
      expect(csv).toBe('a\tb\n1\t2')
    })

    it('returns empty string for empty data', () => {
      const csv = stringifyCsv([])
      expect(csv).toBe('')
    })

    it('returns just headers for empty data with columns', () => {
      const csv = stringifyCsv([], ['id', 'name'])
      expect(csv).toBe('id,name')
    })
  })
})
