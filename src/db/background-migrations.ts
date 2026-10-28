/**
 * Background migrations: one-time rewrites of every row of a big table,
 * done in small batches instead of one transaction on open (#89).
 *
 * cache_migrations has a row per registered migration with its progress.
 * Each batch is its own short write transaction: it reads the cursor (the
 * last rowid done), rewrites the next rows up to a row and a time limit and
 * moves the cursor, all at once. So a stop at any point resumes where the
 * last batch ended, two runners (the daemon and `tg db migrate`) take turns
 * without doing a row twice, and another process's write waits at most one
 * batch. A migration's rewrite is idempotent, so a row done twice (after a
 * VACUUM moved rowids) ends the same.
 *
 * A migration covers the rows up to the table's largest rowid when it
 * starts: later rows are written by this version, in the new form. Readers
 * take rows in the old and the new form alike, so a migration half done
 * changes no answer.
 */
import type { Database } from 'bun:sqlite'

import { BACKGROUND_MIGRATIONS } from './raw-json-migrations'

export type MigrationTable = 'messages_cache' | 'users_cache' | 'chats_cache'

export interface BackgroundMigration {
  /** Stable key in cache_migrations */
  name: string
  /** One line for `tg status` and `tg db migrate` */
  description: string
  table: MigrationTable
  /** The columns each row needs, besides rowid */
  columns: readonly string[]
  /**
   * Prepare the statements of one batch. The returned function rewrites
   * one row; it runs inside the batch's transaction and must be idempotent.
   */
  prepare(db: Database): (row: MigrationRow) => void
}

export type MigrationRow = { rowid: number } & Record<string, unknown>

export type MigrationState = 'pending' | 'running' | 'done'

export interface MigrationStatus {
  name: string
  description: string
  state: MigrationState
  /** Rows done so far */
  done: number
  /** Rows to do; null until the migration starts */
  total: number | null
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
  /** The last batch's error; cleared by the next batch that commits */
  last_error: string | null
}

interface MigrationRecord {
  name: string
  state: MigrationState
  cursor: number
  end_rowid: number | null
  done: number
  total: number | null
  started_at: number | null
  updated_at: number | null
  finished_at: number | null
  last_error: string | null
}

export interface BatchLimits {
  /** Most rows per batch */
  maxRows: number
  /** A batch stops after the row that passes this many ms */
  maxMs: number
  /** Milliseconds, for timing batches; injectable for tests */
  now?: () => number
}

/** About 50 ms of the daemon's write lock per batch */
export const DEFAULT_BATCH_LIMITS: BatchLimits = { maxRows: 500, maxMs: 50 }

function createMigrationsTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS cache_migrations (
      name        TEXT PRIMARY KEY,
      state       TEXT NOT NULL DEFAULT 'pending',
      cursor      INTEGER NOT NULL DEFAULT 0,
      end_rowid   INTEGER,
      done        INTEGER NOT NULL DEFAULT 0,
      total       INTEGER,
      started_at  INTEGER,
      updated_at  INTEGER,
      finished_at INTEGER,
      last_error  TEXT
    )
  `)
}

function hasMigrationsTable(db: Database): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cache_migrations'`,
      )
      .get() !== null
  )
}

function registeredNames(db: Database): Set<string> {
  if (!hasMigrationsTable(db)) return new Set()
  const rows = db.query('SELECT name FROM cache_migrations').all() as {
    name: string
  }[]
  return new Set(rows.map((row) => row.name))
}

/** Whether the table has no rows; a database without the table has none */
function tableIsEmpty(db: Database, table: MigrationTable): boolean {
  const exists = db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table)
  return !exists || db.query(`SELECT 1 FROM ${table} LIMIT 1`).get() === null
}

/**
 * Record each migration a cache hasn't seen. One that finds its table
 * empty (a new cache) is done at once: every row it will get is written in
 * the new form. Called on every open: a cache that knows every migration
 * is only read.
 */
export function registerBackgroundMigrations(
  db: Database,
  migrations: readonly BackgroundMigration[] = BACKGROUND_MIGRATIONS,
): void {
  const known = registeredNames(db)
  if (migrations.every((migration) => known.has(migration.name))) return

  db.transaction(() => {
    createMigrationsTable(db)
    const now = Date.now()
    const insert = db.query(`
      INSERT OR IGNORE INTO cache_migrations (
        name, state, done, total, started_at, updated_at, finished_at
      ) VALUES ($name, $state, 0, $total, $at, $at, $at)
    `)
    for (const migration of migrations) {
      const empty = tableIsEmpty(db, migration.table)
      insert.run({
        $name: migration.name,
        $state: empty ? 'done' : 'pending',
        $total: empty ? 0 : null,
        $at: empty ? now : null,
      })
    }
  }).immediate()
}

function readRecord(db: Database, name: string): MigrationRecord | null {
  return db
    .query('SELECT * FROM cache_migrations WHERE name = ?')
    .get(name) as MigrationRecord | null
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

/**
 * Every registered migration's progress, in registry order. Only reads; a
 * cache that has no cache_migrations table yet reports none.
 */
export function readMigrationStatus(
  db: Database,
  migrations: readonly BackgroundMigration[] = BACKGROUND_MIGRATIONS,
): MigrationStatus[] {
  if (!hasMigrationsTable(db)) return []
  const result: MigrationStatus[] = []
  for (const migration of migrations) {
    const record = readRecord(db, migration.name)
    if (!record) continue
    result.push({
      name: migration.name,
      description: migration.description,
      state: record.state,
      done: record.done,
      total: record.total,
      started_at: isoOrNull(record.started_at),
      updated_at: isoOrNull(record.updated_at),
      finished_at: isoOrNull(record.finished_at),
      last_error: record.last_error,
    })
  }
  return result
}

/** Whether a registered migration hasn't finished */
export function hasPendingMigrations(
  db: Database,
  migrations: readonly BackgroundMigration[] = BACKGROUND_MIGRATIONS,
): boolean {
  return readMigrationStatus(db, migrations).some(
    (status) => status.state !== 'done',
  )
}

/**
 * Fix the rows a migration covers: up to the largest rowid now. The count
 * reads the table outside the write lock; rows written meanwhile have a
 * larger rowid and the new form.
 */
function startMigration(
  db: Database,
  migration: BackgroundMigration,
  now: number,
): void {
  const { end, total } = db
    .query(
      `SELECT COALESCE(MAX(rowid), 0) AS end, COUNT(*) AS total FROM ${migration.table}`,
    )
    .get() as { end: number; total: number }
  db.transaction(() => {
    db.query(`
      UPDATE cache_migrations
      SET state = 'running', end_rowid = $end, total = $total,
          started_at = $now, updated_at = $now
      WHERE name = $name AND state = 'pending'
    `).run({ $name: migration.name, $end: end, $total: total, $now: now })
  }).immediate()
}

export interface BatchResult {
  /** Rows this batch did; 0 when another runner had finished it */
  rows: number
  /** Whether the migration is done now */
  finished: boolean
}

/**
 * Run one batch of a migration: at most `maxRows` rows, and no row started
 * after `maxMs`. The rows and the cursor commit together. A batch that
 * throws rolls back, records its error in a write of its own and rethrows.
 */
export function runMigrationBatch(
  db: Database,
  migration: BackgroundMigration,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): BatchResult {
  const now = limits.now ?? Date.now
  const initial = readRecord(db, migration.name)
  if (!initial || initial.state === 'done') return { rows: 0, finished: true }
  if (initial.state === 'pending') startMigration(db, migration, now())

  const select = db.query(`
    SELECT rowid, ${migration.columns.join(', ')} FROM ${migration.table}
    WHERE rowid > $cursor AND rowid <= $end
    ORDER BY rowid
    LIMIT $limit
  `)
  const advance = db.query(`
    UPDATE cache_migrations
    SET cursor = $cursor, done = done + $rows, updated_at = $now,
        state = $state, finished_at = $finished_at, last_error = NULL
    WHERE name = $name
  `)

  try {
    return db
      .transaction((): BatchResult => {
        // Read again under the lock: another runner may have moved on
        const record = readRecord(db, migration.name)
        if (!record || record.state === 'done') {
          return { rows: 0, finished: true }
        }
        const rewrite = migration.prepare(db)
        const started = now()
        const rows = select.all({
          $cursor: record.cursor,
          $end: record.end_rowid ?? 0,
          $limit: limits.maxRows,
        }) as MigrationRow[]

        let cursor = record.cursor
        let count = 0
        for (const row of rows) {
          rewrite(row)
          cursor = row.rowid
          count += 1
          if (now() - started >= limits.maxMs) break
        }
        // Fewer rows than asked for: nothing is left below end_rowid
        const finished =
          cursor >= (record.end_rowid ?? 0) ||
          (count === rows.length && rows.length < limits.maxRows)
        const at = now()
        advance.run({
          $name: migration.name,
          $cursor: cursor,
          $rows: count,
          $now: at,
          $state: finished ? 'done' : 'running',
          $finished_at: finished ? at : null,
        })
        return { rows: count, finished }
      })
      .immediate()
  } catch (err) {
    recordError(db, migration.name, err, now())
    throw err
  }
}

function recordError(
  db: Database,
  name: string,
  err: unknown,
  now: number,
): void {
  try {
    db.query(
      'UPDATE cache_migrations SET last_error = $error, updated_at = $now WHERE name = $name',
    ).run({
      $name: name,
      $error: err instanceof Error ? err.message : String(err),
      $now: now,
    })
  } catch {
    // The cache may be busy or read-only; the error is rethrown anyway
  }
}

/**
 * Start every migration over: after a VACUUM moved rowids, a cursor no
 * longer marks the rows done. Rewriting a row again changes nothing.
 */
export function restartUnfinishedMigrations(db: Database): void {
  if (!hasMigrationsTable(db)) return
  db.run(`
    UPDATE cache_migrations
    SET state = 'pending', cursor = 0, end_rowid = NULL, done = 0,
        total = NULL
    WHERE state != 'done'
  `)
}

export interface RunOptions {
  limits?: BatchLimits
  /** Stop starting batches once this returns true */
  shouldStop?: () => boolean
  /** Called after each batch that did rows */
  onBatch?: (migration: BackgroundMigration, status: MigrationStatus) => void
  /** Wait between batches, so other work of the process runs */
  yieldBetweenBatches?: () => Promise<void>
}

/**
 * Run pending migrations in registry order until each is done or
 * `shouldStop` says so. Returns the rows done.
 */
export async function runPendingMigrations(
  db: Database,
  options: RunOptions = {},
  migrations: readonly BackgroundMigration[] = BACKGROUND_MIGRATIONS,
): Promise<number> {
  let total = 0
  for (const migration of migrations) {
    for (;;) {
      if (options.shouldStop?.()) return total
      const batch = runMigrationBatch(db, migration, options.limits)
      total += batch.rows
      if (batch.rows > 0 && options.onBatch) {
        const status = readMigrationStatus(db, [migration])[0]
        if (status) options.onBatch(migration, status)
      }
      if (batch.finished) break
      await options.yieldBetweenBatches?.()
    }
  }
  return total
}
