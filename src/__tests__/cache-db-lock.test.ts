/**
 * The CLI and the daemon write the same cache database. A write that
 * arrives while the other process holds the write lock must wait for it,
 * not fail with "database is locked".
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySyncMode } from '../commands/chats/sync'
import { checkCacheOwner } from '../db/cache-meta'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { PEER_ID_USER_VERSION } from '../db/peer-id-migration'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { seedLegacyCache } from './helpers/legacy-cache'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'
import { seedInChild } from './helpers/seed-in-child'

const SCHEMA_MODULE = join(import.meta.dir, '../db/schema.ts')
const SYNC_SCHEMA_MODULE = join(import.meta.dir, '../db/sync-schema.ts')
const DB_MODULE = join(import.meta.dir, '../db/index.ts')

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

/**
 * Another process: getAccountCacheDb on a cache whose migration fails once,
 * as when the disk is full. The failed open must not stick: the next call
 * opens the file again and migrates it.
 */
const RETRY_OPEN = `
  import { Database } from 'bun:sqlite'
  const { accountsDb, getAccountCacheDb } = await import(process.env.DB_MODULE)
  accountsDb.create({ phone: '+15550000001', is_active: true })
  try {
    getAccountCacheDb(1)
    console.log('first open: ok')
  } catch (err) {
    console.log('first open: ' + err.message)
  }
  const other = new Database(process.env.LOCK_DB_PATH)
  other.run('DROP TRIGGER fail_rekey')
  other.close()
  const db = getAccountCacheDb(1)
  console.log('second open: ' + db.query('PRAGMA user_version').get().user_version)
`

/** A tg command: opens the only account's cache, moving a shared one first */
const OPEN_ACCOUNT_CACHE = `
  const { getAccountCacheDb } = await import(process.env.DB_MODULE)
  try {
    const db = getAccountCacheDb(1)
    const row = db.query('SELECT COUNT(*) AS count FROM chats_cache').get()
    console.log('chats: ' + row.count)
  } catch (err) {
    console.log((err.reason ?? 'error') + ': ' + err.message)
  }
`

/** An older tg: keeps the shared cache open, idle, until told to stop */
const HOLD_OPEN = `
  import { Database } from 'bun:sqlite'
  const db = new Database(process.env.LOCK_DB_PATH)
  db.query('SELECT COUNT(*) FROM chats_cache').get()
  console.log('open')
  await Bun.sleep(Number(process.env.LOCK_HOLD_MS))
  db.close()
`

/** A cache.db as 0.3 left it at the root of the data dir */
function seedSharedCache(path: string): void {
  rmSync(path, { force: true })
  for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true })
  seedInChild(path, 'legacySharedCache')
}

/** data.db with `count` made-up accounts, the first one active */
function seedAccounts(dir: string, count: number): void {
  const data = new Database(join(dir, 'data.db'))
  data.run('PRAGMA journal_mode = WAL')
  data.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      user_id INTEGER,
      name TEXT,
      username TEXT,
      label TEXT,
      session_data TEXT NOT NULL DEFAULT '',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `)
  for (let i = 1; i <= count; i++) {
    data.run('INSERT INTO accounts (phone, is_active) VALUES (?, ?)', [
      `+1555000000${i}`,
      i === 1 ? 1 : 0,
    ])
  }
  data.close()
}

/** Every cache database under the data dir (no sidecars), relative to it */
function listCacheFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => /cache[^/]*\.db$/.test(name))
    .sort()
}

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

  it('opens a migrated, stamped cache without waiting for the write lock', async () => {
    const owner = { id: 1, user_id: 101 }
    const cache = new Database(path)
    seedLegacyCache(cache)
    initCacheSchema(cache)
    initSyncSchema(cache)
    checkCacheOwner(cache, owner, path)
    cache.close()

    const holder = spawnBun(HOLD_LOCK, {
      LOCK_DB_PATH: path,
      LOCK_HOLD_MS: '1500',
    })
    await waitForLine(holder.stdout, 'locked')

    // Every tg command opens the cache this way (getAccountCacheDb); with
    // nothing to migrate or stamp it must not queue behind a daemon write
    // batch
    const db = new Database(path)
    const started = performance.now()
    initCacheSchema(db)
    initSyncSchema(db)
    checkCacheOwner(db, owner, path)
    expect(performance.now() - started).toBeLessThan(500)
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 })
    db.close()

    expect(await holder.exited).toBe(0)
  }, 20_000)

  it('lets several processes switch a new or folded cache to WAL at once', async () => {
    // A new file, and one in DELETE mode as the shared-cache move leaves
    // it. SQLite fails all but one switch to WAL at once, without waiting
    // for busy_timeout, so the others must try again
    for (const kind of ['new', 'folded'] as const) {
      for (let round = 0; round < 3; round++) {
        const file = join(dir, `${kind}-${round}.db`)
        if (kind === 'folded') {
          const db = new Database(file)
          db.run('PRAGMA journal_mode = DELETE')
          db.run('CREATE TABLE filler (n INTEGER)')
          db.transaction(() => {
            for (let n = 0; n < 100; n++) {
              db.run('INSERT INTO filler (n) VALUES (?)', [n])
            }
          })()
          db.close()
        }

        const env = { LOCK_DB_PATH: file, SCHEMA_MODULE, SYNC_SCHEMA_MODULE }
        const children = Array.from({ length: 6 }, () =>
          spawnBun(INIT_SCHEMA, env),
        )
        const results = await Promise.all(
          children.map(async (child) => ({
            code: await child.exited,
            stderr: await new Response(child.stderr).text(),
          })),
        )

        expect(results).toEqual(results.map(() => ({ code: 0, stderr: '' })))
        const db = new Database(file)
        expect(db.query('PRAGMA journal_mode').get()).toEqual({
          journal_mode: 'wal',
        })
        db.close()
      }
    }
  }, 60_000)

  it('lets several processes rebuild an outdated search index at once', async () => {
    // An index from before the files column: every opener must drop it,
    // create it again and fill it from messages_cache
    const outdated = new Database(path)
    for (let id = 1; id <= 50; id++) {
      outdated.run(
        `INSERT INTO messages_cache (chat_id, message_id, text, date, fetched_at, raw_json)
         VALUES (101, ?, ?, 1700000000, 1700000000000, '{}')`,
        [id, `made-up message ${id}`],
      )
    }
    for (const trigger of ['ai', 'ad', 'au']) {
      outdated.run(`DROP TRIGGER messages_cache_${trigger}`)
    }
    outdated.run('DROP TABLE message_search')
    outdated.run(
      "CREATE VIRTUAL TABLE message_search USING fts5(text, sender, chat, tokenize='unicode61')",
    )
    outdated.close()

    // They all find it outdated and queue for the lock: one rebuilds it
    // while the others wait, then find nothing left. Before, each one
    // dropped and created the table and its triggers statement by
    // statement, so one could drop the table another one was filling
    const holder = spawnBun(HOLD_LOCK, {
      LOCK_DB_PATH: path,
      LOCK_HOLD_MS: '1500',
    })
    await waitForLine(holder.stdout, 'locked')

    const env = { LOCK_DB_PATH: path, SCHEMA_MODULE, SYNC_SCHEMA_MODULE }
    const children = Array.from({ length: 4 }, () => spawnBun(INIT_SCHEMA, env))
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    )

    expect(results).toEqual(results.map(() => ({ code: 0, stderr: '' })))
    expect(await holder.exited).toBe(0)

    const rebuilt = new Database(path)
    rebuilt.run('PRAGMA busy_timeout = 5000')
    expect(
      rebuilt
        .query('PRAGMA table_info(message_search)')
        .all()
        .map((column) => (column as { name: string }).name),
    ).toEqual(['text', 'sender', 'chat', 'files'])
    expect(
      rebuilt
        .query(
          "SELECT COUNT(*) AS count FROM message_search WHERE message_search MATCH 'made'",
        )
        .get(),
    ).toEqual({ count: 50 })
    expect(
      rebuilt
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'messages_cache_a_'",
        )
        .get(),
    ).toEqual({ count: 3 })
    rebuilt.close()
  }, 30_000)

  it('lets several processes move a 0.2.0 cache to marked IDs at once', async () => {
    const legacy = new Database(path)
    seedLegacyCache(legacy)
    legacy.close()

    // Another writer holds the lock while they start, so they all find
    // work to do and queue for the lock: one migrates while the others wait
    // for it, then find nothing left
    const holder = spawnBun(HOLD_LOCK, {
      LOCK_DB_PATH: path,
      LOCK_HOLD_MS: '2000',
    })
    await waitForLine(holder.stdout, 'locked')

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
    // A process that exits closes its connection, which may checkpoint the
    // WAL under an exclusive lock: read once every other process is gone
    expect(await holder.exited).toBe(0)

    const migrated = new Database(path)
    migrated.run('PRAGMA busy_timeout = 5000')
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

  it('opens the cache again after a migration that failed', async () => {
    const accountCache = join(dir, 'accounts', '1', 'cache.db')
    mkdirSync(join(dir, 'accounts', '1'), { recursive: true })
    const legacy = new Database(accountCache)
    initCacheSchema(legacy)
    initSyncSchema(legacy)
    seedLegacyCache(legacy)
    legacy.run(`
      CREATE TRIGGER fail_rekey BEFORE UPDATE OF chat_id ON chats_cache
      BEGIN SELECT RAISE(ABORT, 'disk full'); END
    `)
    legacy.close()

    const child = spawnBun(RETRY_OPEN, {
      DB_MODULE,
      LOCK_DB_PATH: accountCache,
      TELEGRAM_SYNC_CLI_DATA_DIR: dir,
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(stdout.trim().split('\n')).toEqual([
      'first open: disk full',
      `second open: ${PEER_ID_USER_VERSION}`,
    ])
  }, 20_000)

  it('lets several processes move a shared cache to its only account at once', async () => {
    seedSharedCache(path)
    seedAccounts(dir, 1)

    const env = { DB_MODULE, TELEGRAM_SYNC_CLI_DATA_DIR: dir }
    const children = Array.from({ length: 4 }, () =>
      spawnBun(OPEN_ACCOUNT_CACHE, env),
    )
    const results = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
      })),
    )

    expect(results).toEqual(
      results.map(() => ({ code: 0, stdout: 'chats: 4', stderr: '' })),
    )
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(join(dir, 'accounts', '1', 'cache.db'))).toBe(true)
    expect(listCacheFiles(dir)).toEqual(['accounts/1/cache.db'])
  }, 30_000)

  it('moves a shared cache only after the older process that holds it exits', async () => {
    seedSharedCache(path)
    seedAccounts(dir, 1)

    const holder = spawnBun(HOLD_OPEN, {
      LOCK_DB_PATH: path,
      LOCK_HOLD_MS: '4000',
    })
    await waitForLine(holder.stdout, 'open')

    const env = { DB_MODULE, TELEGRAM_SYNC_CLI_DATA_DIR: dir }
    const blocked = spawnBun(OPEN_ACCOUNT_CACHE, env)
    expect(await blocked.exited).toBe(0)
    expect((await new Response(blocked.stdout).text()).trim()).toStartWith(
      'shared_cache_in_use: ',
    )
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(dir, 'accounts', '1'))).toBe(false)

    expect(await holder.exited).toBe(0)

    const opened = spawnBun(OPEN_ACCOUNT_CACHE, env)
    expect(await opened.exited).toBe(0)
    expect((await new Response(opened.stdout).text()).trim()).toBe('chats: 4')
    expect(existsSync(path)).toBe(false)
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
