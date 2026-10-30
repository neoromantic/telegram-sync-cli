/**
 * Background migrations (#89) and the first ones: raw_json re-encode (#108,
 * #95), attachment backfill (#22) and message_type. Made-up data only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type BackgroundMigration,
  readMigrationStatus,
  registerBackgroundMigrations,
  restartUnfinishedMigrations,
  runMigrationBatch,
  runPendingMigrations,
} from '../db/background-migrations'
import { createMessagesCache } from '../db/messages-cache'
import { BACKGROUND_MIGRATIONS } from '../db/raw-json-migrations'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { extractAttachment } from '../utils/attachment'
import { resolveRawMessageType } from '../utils/message-type'
import { toRawJson } from '../utils/raw-json'
import {
  OLD_FORM_CHAT_ID,
  oldFormChats,
  oldFormMessages,
  oldFormUsers,
  seedOldFormCache,
} from './helpers/old-form-cache'

const MESSAGES = 21
const SMALL = { maxRows: 4, maxMs: 1_000 }

function oldCache(): Database {
  const db = new Database(':memory:')
  seedOldFormCache(db, { messages: MESSAGES })
  return db
}

/** Every row the migrations touch, to compare end states */
function snapshot(db: Database) {
  return {
    messages: db
      .query(
        'SELECT chat_id, message_id, message_type, has_media, raw_json, updated_at FROM messages_cache ORDER BY message_id',
      )
      .all(),
    attachments: db
      .query('SELECT * FROM message_attachments ORDER BY message_id')
      .all(),
    users: db
      .query('SELECT user_id, raw_json FROM users_cache ORDER BY user_id')
      .all(),
    chats: db
      .query('SELECT chat_id, raw_json FROM chats_cache ORDER BY chat_id')
      .all(),
  }
}

/** The search index's own pages: equal when nothing re-indexed */
function searchIndexPages(db: Database) {
  return db.query('SELECT id, block FROM message_search_data ORDER BY id').all()
}

function statusByName(db: Database) {
  return Object.fromEntries(
    readMigrationStatus(db).map((status) => [status.name, status]),
  )
}

async function migrateAll(db: Database) {
  return runPendingMigrations(db, { limits: SMALL })
}

describe('background migrations of a 0.5.0 cache', () => {
  it('registers every migration as pending', () => {
    const db = oldCache()
    const status = statusByName(db)
    expect(Object.keys(status)).toEqual(
      BACKGROUND_MIGRATIONS.map((migration) => migration.name),
    )
    for (const migration of Object.values(status)) {
      expect(migration).toMatchObject({
        state: 'pending',
        done: 0,
        total: null,
      })
    }
  })

  it('rewrites raw_json, attachments and message_type as a new write would', async () => {
    const db = oldCache()
    const originals = oldFormMessages(MESSAGES)
    const indexBefore = searchIndexPages(db)
    const updatedBefore = db
      .query('SELECT updated_at FROM messages_cache ORDER BY message_id')
      .all()
      .map((row) => (row as { updated_at: number }).updated_at)
    const attachmentsBefore = (
      db
        .query('SELECT raw_json FROM messages_cache ORDER BY message_id')
        .all() as { raw_json: string }[]
    ).map((row) => extractAttachment(row.raw_json))

    const rows = await migrateAll(db)

    // The messages twice: the re-encode, then the refetch check (#130)
    expect(rows).toBe(
      2 * MESSAGES + oldFormUsers().length + oldFormChats().length,
    )
    const after = snapshot(db)
    for (const [i, message] of originals.entries()) {
      const row = after.messages[i] as {
        message_type: string
        raw_json: string
        updated_at: number
      }
      // The same text toRawJson writes for the message today (#108, #95)
      expect(row.raw_json).toBe(toRawJson(message))
      expect(row.raw_json).not.toContain('fileReference')
      expect(row.raw_json).not.toContain('"unsigned"')
      expect(row.message_type).toBe(resolveRawMessageType(message).messageType)
      expect(extractAttachment(row.raw_json)).toEqual(attachmentsBefore[i]!)
    }
    // A video stored as document by 0.5.0 is a video now
    expect(after.messages[1]).toMatchObject({ message_type: 'video' })
    expect(
      JSON.parse((after.messages[1] as { raw_json: string }).raw_json),
    ).toMatchObject({ groupedId: '-8000000000000000001' })

    // Every media message got its attachment row
    const withFile = originals.filter((m) => extractAttachment(m) !== null)
    expect(after.attachments).toHaveLength(withFile.length)
    expect(after.attachments[0]).toMatchObject({
      chat_id: OLD_FORM_CHAT_ID,
      message_id: 1,
      kind: 'photo',
    })

    for (const [i, user] of oldFormUsers().entries()) {
      expect((after.users[i] as { raw_json: string }).raw_json).toBe(
        toRawJson(user),
      )
    }
    for (const [i, chat] of oldFormChats().entries()) {
      // chat_id sorts as text: -1000000003002 after -1000000003001
      expect((after.chats[i] as { raw_json: string }).raw_json).toBe(
        toRawJson(chat),
      )
    }

    // raw_json and message_type aren't columns the search index reads
    expect(searchIndexPages(db)).toEqual(indexBefore)
    // The rewrite isn't a change of the message
    expect(
      after.messages.map((m) => (m as { updated_at: number }).updated_at),
    ).toEqual(updatedBefore)

    for (const status of Object.values(statusByName(db))) {
      expect(status.state).toBe('done')
      expect(status.done).toBe(status.total!)
      expect(status.finished_at).not.toBeNull()
    }
  })

  it('lets json_extract read an access hash as a decimal string (#108)', async () => {
    const db = oldCache()
    await migrateAll(db)
    const row = db
      .query(
        "SELECT json_extract(raw_json, '$.accessHash') AS hash FROM users_cache WHERE user_id = '2001'",
      )
      .get() as { hash: string }
    expect(row.hash).toBe('-700000000000000001')
  })

  it('changes nothing when run again', async () => {
    const db = oldCache()
    await migrateAll(db)
    const before = snapshot(db)
    const status = readMigrationStatus(db)

    expect(await migrateAll(db)).toBe(0)
    expect(snapshot(db)).toEqual(before)
    expect(readMigrationStatus(db)).toEqual(status)
  })

  it('leaves rows written by the new version alone', async () => {
    const db = oldCache()
    const fresh = toRawJson(oldFormMessages(1)[0])
    db.run('UPDATE messages_cache SET raw_json = ? WHERE message_id = 1', [
      fresh,
    ])
    await migrateAll(db)
    const row = db
      .query('SELECT raw_json FROM messages_cache WHERE message_id = 1')
      .get() as { raw_json: string }
    expect(row.raw_json).toBe(fresh)
  })
})

describe('message_type of older rows', () => {
  /** A message 0.5.0 cached with this media, message_type and raw_json */
  function rowsAfterMigration(
    rows: Array<{ id: number; type: string; raw: string }>,
  ) {
    const db = new Database(':memory:')
    seedOldFormCache(db, { messages: 0 })
    const insert = db.query(`
      INSERT INTO messages_cache (chat_id, message_id, message_type, has_media, date, fetched_at, raw_json)
      VALUES (${OLD_FORM_CHAT_ID}, $id, $type, 1, 1760000000, 0, $raw)
    `)
    for (const row of rows) {
      insert.run({ $id: row.id, $type: row.type, $raw: row.raw })
    }
    db.run('DELETE FROM cache_migrations')
    registerBackgroundMigrations(db)
    return db
  }

  const message = (id: number, media: unknown) =>
    JSON.stringify({
      _: 'message',
      id,
      peerId: { _: 'peerUser', userId: OLD_FORM_CHAT_ID },
      date: 1_760_000_000,
      message: '',
      media,
    })

  it('gives media a Telegram client shows no file the type a new write gives', async () => {
    const db = rowsAfterMigration([
      {
        id: 1,
        type: 'media',
        raw: message(1, {
          _: 'messageMediaWebPage',
          webpage: { _: 'webPagePending', id: '9', date: 1 },
        }),
      },
      {
        id: 2,
        type: 'photo',
        raw: message(2, { _: 'messageMediaPhoto', ttlSeconds: 10 }),
      },
      {
        id: 3,
        type: 'media',
        raw: message(3, { _: 'messageMediaUnsupported' }),
      },
      { id: 4, type: 'photo', raw: '{}' },
      { id: 5, type: 'photo', raw: '{broken' },
      { id: 6, type: 'document', raw: JSON.stringify({ id: 6, date: 1 }) },
    ])

    await migrateAll(db)

    const rows = db
      .query(
        'SELECT message_id, message_type, raw_json FROM messages_cache ORDER BY message_id',
      )
      .all() as { message_id: number; message_type: string; raw_json: string }[]
    for (const row of rows.slice(0, 3)) {
      expect(row.message_type).toBe(
        resolveRawMessageType(JSON.parse(row.raw_json)).messageType,
      )
      expect(row.message_type).toBe('text')
    }
    // Rows that hold no TL message keep their type and their raw_json
    expect(rows.slice(3)).toEqual([
      { message_id: 4, message_type: 'photo', raw_json: '{}' },
      { message_id: 5, message_type: 'photo', raw_json: '{broken' },
      {
        message_id: 6,
        message_type: 'document',
        raw_json: JSON.stringify({ id: 6, date: 1 }),
      },
    ])
  })
})

describe('stops and resumes', () => {
  let dir: string
  let reference: ReturnType<typeof snapshot>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tg-migrations-'))
    const db = oldCache()
    await migrateAll(db)
    reference = snapshot(db)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function fileCache(): string {
    const path = join(dir, 'cache.db')
    const db = new Database(path)
    db.run('PRAGMA journal_mode = WAL')
    seedOldFormCache(db, { messages: MESSAGES })
    db.close()
    return path
  }

  function open(path: string): Database {
    const db = new Database(path)
    db.run('PRAGMA busy_timeout = 5000')
    return db
  }

  it('resumes after a stop between batches', async () => {
    const path = fileCache()
    const first = open(path)
    let batches = 0
    await runPendingMigrations(first, {
      limits: SMALL,
      shouldStop: () => batches >= 2,
      onBatch: () => {
        batches += 1
      },
    })
    const messages = statusByName(first).messages_raw_json_v2!
    expect(messages).toMatchObject({ state: 'running', done: 8 })
    first.close()

    const second = open(path)
    await migrateAll(second)
    expect(snapshot(second)).toEqual(reference)
    expect(statusByName(second).messages_raw_json_v2).toMatchObject({
      state: 'done',
      done: MESSAGES,
      total: MESSAGES,
    })
  })

  it('rolls a failed batch back, records the error and resumes', async () => {
    const db = open(fileCache())
    const [messages] = BACKGROUND_MIGRATIONS as [BackgroundMigration]
    let seen = 0
    const failing: BackgroundMigration = {
      ...messages,
      prepare(conn) {
        const rewrite = messages.prepare(conn)
        return (row) => {
          seen += 1
          rewrite(row)
          if (seen === 7) throw new Error('disk on fire')
        }
      },
    }

    runMigrationBatch(db, failing, SMALL)
    const afterFirst = snapshot(db)
    expect(() => runMigrationBatch(db, failing, SMALL)).toThrow('disk on fire')

    // The second batch's three rewritten rows rolled back with its cursor
    expect(snapshot(db)).toEqual(afterFirst)
    expect(statusByName(db).messages_raw_json_v2).toMatchObject({
      state: 'running',
      done: 4,
      last_error: 'disk on fire',
    })

    await migrateAll(db)
    expect(snapshot(db)).toEqual(reference)
    expect(statusByName(db).messages_raw_json_v2).toMatchObject({
      done: MESSAGES,
      last_error: null,
    })
  })

  it('ends in the same state when two runners take turns', () => {
    const path = fileCache()
    const daemon = open(path)
    const cli = open(path)
    const runners = [daemon, cli]
    for (const migration of BACKGROUND_MIGRATIONS) {
      let turn = 0
      while (
        !runMigrationBatch(runners[turn % 2]!, migration, SMALL).finished
      ) {
        turn += 1
      }
    }
    expect(snapshot(cli)).toEqual(reference)
    expect(statusByName(daemon).messages_raw_json_v2).toMatchObject({
      done: MESSAGES,
      total: MESSAGES,
    })
  })

  it('starts unfinished migrations over after a VACUUM', async () => {
    const db = open(fileCache())
    runMigrationBatch(db, BACKGROUND_MIGRATIONS[0]!, SMALL)
    restartUnfinishedMigrations(db)
    expect(statusByName(db).messages_raw_json_v2).toMatchObject({
      state: 'pending',
      done: 0,
      total: null,
    })
    await migrateAll(db)
    expect(snapshot(db)).toEqual(reference)
  })
})

describe('batch limits', () => {
  it('stops a batch at its time limit, after the row that passed it', () => {
    const db = oldCache()
    let clock = 0
    const result = runMigrationBatch(db, BACKGROUND_MIGRATIONS[0]!, {
      maxRows: 500,
      maxMs: 30,
      // Each reading of the clock is 5 ms later: one per row
      now: () => {
        clock += 5
        return clock
      },
    })
    expect(result).toEqual({ rows: 6, finished: false })
  })
})

describe('a new cache', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-migrations-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers every migration as done', () => {
    const db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    for (const status of readMigrationStatus(db)) {
      expect(status).toMatchObject({ state: 'done', done: 0, total: 0 })
    }
  })

  it('opens again without the write lock, with migrations pending or not', () => {
    const path = join(dir, 'cache.db')
    const seed = new Database(path)
    seed.run('PRAGMA journal_mode = WAL')
    seedOldFormCache(seed, { messages: 3 })
    seed.close()

    // Another process holds the write lock; an open that wrote would fail
    const holder = new Database(path)
    holder.run('BEGIN IMMEDIATE')
    try {
      const reader = new Database(path)
      initCacheSchema(reader)
      reader.run('PRAGMA busy_timeout = 0')
      expect(() => {
        initSyncSchema(reader)
        registerBackgroundMigrations(reader)
      }).not.toThrow()
      expect(statusByName(reader).messages_raw_json_v2?.state).toBe('pending')
      reader.close()
    } finally {
      holder.run('ROLLBACK')
      holder.close()
    }
  })
})

/** Each batch of the migration in the child holds the write lock this long */
const SLOW_BATCH_MS = 100

/**
 * Runs every pending migration of MIGRATE_PATH as `tg db migrate` does with
 * the daemon running, in batches of 10 rows. A messages batch sleeps
 * SLOW_BATCH_MS inside its transaction, so the migration holds the lock for
 * 700 ms or more in all, longer than the writer's busy_timeout. Without the
 * pause between batches the writer is refused with the SQLite Bun bundles on
 * Linux; macOS's system SQLite lets it in between batches anyway. Prints the
 * longest batch, from its start to its commit.
 */
const MIGRATE_SCRIPT = `
  import { Database } from 'bun:sqlite'
  const { foregroundPacing, runPendingMigrations } = await import(process.env.MIGRATE_MODULE)
  const { BACKGROUND_MIGRATIONS } = await import(process.env.MIGRATIONS_MODULE)
  const [messages, ...others] = BACKGROUND_MIGRATIONS
  let batchStarted = 0
  let longestBatchMs = 0
  const slowMessages = {
    ...messages,
    prepare(db) {
      batchStarted = performance.now()
      Bun.sleepSync(${SLOW_BATCH_MS})
      return messages.prepare(db)
    },
  }
  const db = new Database(process.env.MIGRATE_PATH)
  db.run('PRAGMA busy_timeout = 5000')
  await runPendingMigrations(
    db,
    {
      ...foregroundPacing(true),
      limits: { maxRows: 10, maxMs: 1_000 },
      onBatch: (migration) => {
        if (migration.name !== messages.name) return
        longestBatchMs = Math.max(longestBatchMs, performance.now() - batchStarted)
      },
    },
    [slowMessages, ...others],
  )
  db.close()
  console.log(JSON.stringify({ longestBatchMs }))
`

describe('a writer in another process next to tg db migrate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-migrations-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is never refused: it gets in after the batch it ran into', async () => {
    const path = join(dir, 'cache.db')
    const seed = new Database(path)
    seed.run('PRAGMA journal_mode = WAL')
    // 7 batches or more: 700 ms of the write lock
    seedOldFormCache(seed, { messages: 70 })
    seed.close()

    const child = Bun.spawn(['bun', '--no-env-file', '-e', MIGRATE_SCRIPT], {
      env: {
        ...process.env,
        MIGRATE_PATH: path,
        MIGRATE_MODULE: join(import.meta.dir, '../db/background-migrations.ts'),
        MIGRATIONS_MODULE: join(
          import.meta.dir,
          '../db/raw-json-migrations.ts',
        ),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let exited = false
    void child.exited.then(() => {
      exited = true
    })

    // A daemon's write waits 5 s; this one gives up after 500 ms
    const writer = new Database(path)
    writer.run('PRAGMA busy_timeout = 500')
    const messages = createMessagesCache(writer)
    let writes = 0
    let refused = 0
    let duringMigration = 0
    while (!exited) {
      try {
        messages.upsert({
          chat_id: OLD_FORM_CHAT_ID,
          message_id: 100_000,
          text: `Example live message ${writes}`,
          message_type: 'text',
          has_media: false,
          date: 1_760_000_000,
          raw_json: '{}',
        })
        writes += 1
      } catch {
        refused += 1
      }
      const state = statusByName(writer).messages_raw_json_v2?.state
      if (state === 'running') duringMigration += 1
      await Bun.sleep(1)
    }

    expect(await child.exited).toBe(0)
    const { longestBatchMs } = JSON.parse(
      await new Response(child.stdout).text(),
    ) as { longestBatchMs: number }
    expect(longestBatchMs).toBeGreaterThanOrEqual(SLOW_BATCH_MS)
    // The migration held the lock for 700 ms or more, and no write gave up
    // after 500 ms: each got in during a pause. Its wait is the rest of the
    // batch it ran into and the busy handler's sleep over the batch's end,
    // 50 to 100 ms by then; the margin covers a writer a busy machine keeps
    // off the CPU for a whole pause.
    expect(refused).toBe(0)
    expect(duringMigration).toBeGreaterThan(0)
    // The live message counts too when it came before the start
    const status = statusByName(writer).messages_raw_json_v2!
    expect(status.state).toBe('done')
    expect(status.done).toBe(status.total!)
    expect(status.done).toBeGreaterThanOrEqual(70)
    writer.close()
  })
})
