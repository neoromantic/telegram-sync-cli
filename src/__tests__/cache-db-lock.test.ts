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
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

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

  it('lets several processes migrate a 0.1.4 database at once', async () => {
    // Turn the database back into what 0.1.4 left
    const db = new Database(path)
    db.run('DROP INDEX idx_sync_jobs_lane')
    db.run('ALTER TABLE chat_sync_state DROP COLUMN top_message_id')
    db.run('ALTER TABLE chat_sync_state DROP COLUMN sync_mode')
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
    const columns = (
      migrated.query('PRAGMA table_info(chat_sync_state)').all() as Array<{
        name: string
      }>
    ).map((col) => col.name)
    expect(columns).toContain('top_message_id')
    expect(columns).toContain('sync_mode')
    migrated.close()
  }, 30_000)
})
