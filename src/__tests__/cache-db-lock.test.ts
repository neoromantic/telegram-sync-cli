/**
 * The CLI and the daemon write the same cache database. A write that
 * arrives while the other process holds the write lock must wait for it,
 * not fail with "database is locked".
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySyncMode } from '../commands/chats/sync'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { PEER_ID_USER_VERSION } from '../db/peer-id-migration'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { seedLegacyCache } from './helpers/legacy-cache'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

const SCHEMA_MODULE = join(import.meta.dir, '../db/schema.ts')
const SYNC_SCHEMA_MODULE = join(import.meta.dir, '../db/sync-schema.ts')

/** Another process: takes the write lock, holds it for `holdMs`, commits */
const HOLD_LOCK = `
  import { Database } from 'bun:sqlite'
  const db = new Database(process.env.LOCK_DB_PATH)
  db.run('BEGIN IMMEDIATE')
  db.run("INSERT INTO daemon_status (key, value) VALUES ('holder', '1')")
  console.log('locked')
  await Bun.sleep(Number(process.env.LOCK_HOLD_MS))
  db.run('COMMIT')
`

/** Another process: opens the cache database the way the CLI does */
const INIT_SCHEMA = `
  import { Database } from 'bun:sqlite'
  const { initCacheSchema } = await import(process.env.SCHEMA_MODULE)
  const { initSyncSchema } = await import(process.env.SYNC_SCHEMA_MODULE)
  const db = new Database(process.env.LOCK_DB_PATH)
  initCacheSchema(db)
  initSyncSchema(db)
  db.close()
`

function spawnBun(script: string, env: Record<string, string>) {
  return Bun.spawn(['bun', '--no-env-file', '-e', script], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

async function waitForLine(stream: ReadableStream<Uint8Array>, line: string) {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
    if (text.includes(line)) return
  }
  throw new Error(`stream ended before "${line}"`)
}

describe('cache database lock', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-cache-lock-'))
    path = join(dir, 'cache.db')
    const db = new Database(path)
    initCacheSchema(db)
    initSyncSchema(db)
    db.close()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('waits for a write lock another process holds', async () => {
    const holder = spawnBun(HOLD_LOCK, {
      LOCK_DB_PATH: path,
      LOCK_HOLD_MS: '1000',
    })
    await waitForLine(holder.stdout, 'locked')

    const write = "INSERT INTO daemon_status (key, value) VALUES ('cli', '1')"

    // SQLite's default is not to wait at all
    const raw = new Database(path)
    raw.run('PRAGMA busy_timeout = 0')
    expect(() => raw.run(write)).toThrow('database is locked')
    raw.close()

    const db = new Database(path)
    initCacheSchema(db)
    const started = Date.now()
    expect(() => db.run(write)).not.toThrow()
    expect(Date.now() - started).toBeGreaterThan(100)
    db.close()

    expect(await holder.exited).toBe(0)
  }, 20_000)

  it('lets tg chats sync wait for a write lock another process holds', async () => {
    const holder = spawnBun(HOLD_LOCK, {
      LOCK_DB_PATH: path,
      LOCK_HOLD_MS: '1000',
    })
    await waitForLine(holder.stdout, 'locked')

    // The holder commits while the command waits. A transaction that read
    // before it asked for the write lock would now fail with
    // SQLITE_BUSY_SNAPSHOT, which busy_timeout doesn't cover.
    const db = new Database(path)
    initCacheSchema(db)
    const chat = {
      id: -1001234567890,
      peerId: -1001234567890,
      type: 'channel' as const,
      title: 'Example News',
      username: 'examplenews',
      memberCount: 5000,
    }
    const started = Date.now()
    const { state, changed } = applySyncMode(db, chat, 'on')
    expect(Date.now() - started).toBeGreaterThan(100)

    expect(changed).toBe(true)
    expect(state).toMatchObject({ sync_mode: 'on', sync_enabled: 1 })
    expect(createChatSyncStateService(db).get(chat.peerId)?.sync_mode).toBe(
      'on',
    )
    db.close()

    expect(await holder.exited).toBe(0)
  }, 20_000)

  it('lets several processes move a 0.2.0 cache to marked IDs at once', async () => {
    const legacy = new Database(path)
    seedLegacyCache(legacy)
    legacy.close()

    const env = {
      LOCK_DB_PATH: path,
      SCHEMA_MODULE,
      SYNC_SCHEMA_MODULE,
    }
    const children = Array.from({ length: 4 }, () => spawnBun(INIT_SCHEMA, env))
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    )

    expect(results).toEqual(results.map(() => ({ code: 0, stderr: '' })))

    const migrated = new Database(path)
    expect(migrated.query('PRAGMA user_version').get()).toEqual({
      user_version: PEER_ID_USER_VERSION,
    })
    expect(
      migrated
        .query('SELECT chat_id FROM chats_cache ORDER BY chat_id')
        .all()
        .map((row) => (row as { chat_id: string }).chat_id)
        .sort(),
    ).toEqual(['-1001234567890', '-1002222222222', '-4242', '10'])
    assertPeerIdInvariants(migrated)
    migrated.close()
  }, 30_000)

  it('lets several processes migrate a 0.1.4 database at once', async () => {
    // Turn the database back into what 0.1.4 left
    const db = new Database(path)
    db.run('DROP INDEX idx_sync_jobs_lane')
    db.run('ALTER TABLE chat_sync_state DROP COLUMN top_message_id')
    db.run('ALTER TABLE chat_sync_state DROP COLUMN sync_mode')
    db.run('ALTER TABLE sync_jobs DROP COLUMN attempts')
    db.run('ALTER TABLE sync_jobs DROP COLUMN next_run_at')
    db.close()

    const env = {
      LOCK_DB_PATH: path,
      SCHEMA_MODULE,
      SYNC_SCHEMA_MODULE,
    }
    const children = Array.from({ length: 4 }, () => spawnBun(INIT_SCHEMA, env))
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    )

    expect(results).toEqual(
      results.map(() => ({ code: 0, stderr: expect.any(String) })),
    )
    for (const { stderr } of results) {
      expect(stderr).not.toContain('error')
    }

    const migrated = new Database(path)
    const columnsOf = (table: string) =>
      (
        migrated.query(`PRAGMA table_info(${table})`).all() as Array<{
          name: string
        }>
      ).map((col) => col.name)
    expect(columnsOf('chat_sync_state')).toContain('top_message_id')
    expect(columnsOf('chat_sync_state')).toContain('sync_mode')
    expect(columnsOf('sync_jobs')).toContain('attempts')
    expect(columnsOf('sync_jobs')).toContain('next_run_at')
    migrated.close()
  }, 30_000)
})
