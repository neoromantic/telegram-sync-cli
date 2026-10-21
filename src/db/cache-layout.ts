/**
 * Per-account cache layout, and the move of the shared cache that 0.3 and
 * older kept at `<dataDir>/cache.db`.
 *
 * Each account's cache, sync state, jobs and rate limits live in
 * `<dataDir>/accounts/<id>/cache.db`. The first command of this version
 * that needs a cache finds the old shared file and:
 *
 * - with exactly one account and no per-account cache yet, moves it to that
 *   account (adopt): every cursor, job and rate limit carries over;
 * - otherwise sets it aside: an empty file is deleted, any other one becomes
 *   `shared-cache.db` (or `shared-cache-2.db`, …), never merged into an
 *   account and never overwritten. Its rows can't be split by account.
 *
 * Before the move the file is switched to `journal_mode = DELETE`, which
 * folds the WAL into the file and only works while no other process has it
 * open: an older tg still running keeps it in place.
 */
import { Database } from 'bun:sqlite'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

export type CacheUnavailableReason =
  | 'shared_cache_in_use'
  | 'move_failed'
  | 'owner_mismatch'

const REASON_MESSAGES: Record<CacheUnavailableReason, string> = {
  shared_cache_in_use:
    'The shared cache of an older tg version is still open in another process, so it cannot be moved to its account yet',
  move_failed: 'The shared cache of an older tg version could not be moved',
  owner_mismatch: 'The cache file belongs to another account',
}

/** A cache that can't be opened safely right now */
export class CacheUnavailableError extends Error {
  readonly reason: CacheUnavailableReason
  readonly path: string

  constructor(
    reason: CacheUnavailableReason,
    path: string,
    options?: ErrorOptions,
  ) {
    super(`${REASON_MESSAGES[reason]}: ${path}`, options)
    this.name = 'CacheUnavailableError'
    this.reason = reason
    this.path = path
  }
}

export function isCacheUnavailableError(
  err: unknown,
): err is CacheUnavailableError {
  return err instanceof CacheUnavailableError
}

export type CacheLayoutState =
  /** No shared cache: nothing to do */
  | 'none'
  /** The shared cache became the only account's cache */
  | 'adopted'
  /** The shared cache was renamed to shared-cache*.db */
  | 'parked'
  /** The shared cache had no data and was deleted */
  | 'deleted'
  /** The shared cache stays for now; a later run moves it */
  | 'deferred'
  /** The only account's cache can't be opened until the shared one moves */
  | 'blocked'

export interface CacheLayoutResult {
  state: CacheLayoutState
  /** The shared cache's path now: where it moved, or where it still is */
  path?: string
  /** The account that adopted it, or would have */
  accountId?: number
  /** Why it is deferred or blocked */
  reason?: CacheUnavailableReason
}

export interface CacheLayoutDeps {
  dataDir: string
  /** The data.db connection: its write lock lets one process move the file */
  db: Database
  accounts: { getAll(): Array<{ id: number }> }
  /** Says where a set-aside cache went */
  notice?: (message: string) => void
}

export const ACCOUNTS_DIR = 'accounts'
export const CACHE_FILE = 'cache.db'
const SHARED_CACHE_BASENAME = 'shared-cache'
const SIDECARS = ['-wal', '-shm'] as const

/** Tables whose rows make a shared cache worth keeping */
const DATA_TABLES = [
  'messages_cache',
  'chats_cache',
  'users_cache',
  'chat_sync_state',
  'history_ranges',
  'sync_jobs',
] as const

/** How long a process waits for another one that is moving the file */
const MOVE_LOCK_TIMEOUT_MS = 60_000
/** How long the fold waits for a reader of the shared cache */
const FOLD_BUSY_TIMEOUT_MS = 2_000

export function accountDirPath(dataDir: string, accountId: number): string {
  return join(dataDir, ACCOUNTS_DIR, String(accountId))
}

export function accountCachePath(dataDir: string, accountId: number): string {
  return join(accountDirPath(dataDir, accountId), CACHE_FILE)
}

/** The shared cache of 0.3 and older */
export function legacyCachePath(dataDir: string): string {
  return join(dataDir, CACHE_FILE)
}

function anyAccountCacheExists(dataDir: string): boolean {
  const dir = join(dataDir, ACCOUNTS_DIR)
  if (!existsSync(dir)) return false
  return readdirSync(dir).some((name) =>
    existsSync(join(dir, name, CACHE_FILE)),
  )
}

function sharedCacheName(index: number): string {
  return index === 1
    ? `${SHARED_CACHE_BASENAME}.db`
    : `${SHARED_CACHE_BASENAME}-${index}.db`
}

function isTaken(path: string): boolean {
  return (
    existsSync(path) || SIDECARS.some((suffix) => existsSync(path + suffix))
  )
}

/** The first shared-cache*.db name that no file uses; rename overwrites */
function nextSharedCachePath(dataDir: string): string {
  for (let index = 1; ; index++) {
    const path = join(dataDir, sharedCacheName(index))
    if (!isTaken(path)) return path
  }
}

/** Set-aside shared caches, oldest name first */
export function listSharedCaches(
  dataDir: string,
): Array<{ path: string; size_bytes: number }> {
  if (!existsSync(dataDir)) return []
  const pattern = new RegExp(`^${SHARED_CACHE_BASENAME}(-(\\d+))?\\.db$`)
  return readdirSync(dataDir)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((entry) => entry.match !== null)
    .sort(
      (a, b) =>
        Number(a.match?.[2] ?? 1) - Number(b.match?.[2] ?? 1) ||
        a.name.localeCompare(b.name),
    )
    .map(({ name }) => {
      const path = join(dataDir, name)
      return { path, size_bytes: statSync(path).size }
    })
}

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) return true
  if (typeof code === 'string' && code.startsWith('SQLITE_LOCKED')) return true
  return /database is locked|database table is locked/i.test(err.message)
}

function hasRows(db: Database, table: string): boolean {
  try {
    return db.query(`SELECT 1 FROM ${table} LIMIT 1`).get() !== null
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) {
      return false
    }
    throw err
  }
}

export type FoldResult =
  /** Folded: the file holds every row and has no sidecars */
  | { state: 'folded'; hasData: boolean }
  /** Another process has it open */
  | { state: 'in_use' }
  /** Not a database SQLite can read: kept as it is */
  | { state: 'unreadable' }

/**
 * Fold the WAL into the file. `journal_mode = DELETE` needs the only
 * connection to the file, so it also proves no other process has it open,
 * even an idle one. The presence of a -wal file proves nothing: macOS
 * leaves an empty one after a normal close.
 */
export function foldSharedCache(path: string): FoldResult {
  let db: Database
  try {
    db = new Database(path, { readwrite: true, create: false })
  } catch (err) {
    return isBusyError(err) ? { state: 'in_use' } : { state: 'unreadable' }
  }

  let hasData = true
  try {
    db.run(`PRAGMA busy_timeout = ${FOLD_BUSY_TIMEOUT_MS}`)
    const row = db.query('PRAGMA journal_mode = DELETE').get() as {
      journal_mode?: string
    } | null
    if (row?.journal_mode?.toLowerCase() !== 'delete') {
      return { state: 'in_use' }
    }
    hasData = DATA_TABLES.some((table) => hasRows(db, table))
  } catch (err) {
    return isBusyError(err) ? { state: 'in_use' } : { state: 'unreadable' }
  } finally {
    db.close()
  }

  const wal = `${path}-wal`
  if (existsSync(wal)) {
    // Rows another process wrote after the fold
    if (statSync(wal).size > 0) return { state: 'in_use' }
    unlinkSync(wal)
  }
  const shm = `${path}-shm`
  if (existsSync(shm)) unlinkSync(shm)

  return { state: 'folded', hasData }
}

/** Move a file and whichever sidecars it still has */
function moveWithSidecars(from: string, to: string): void {
  renameSync(from, to)
  for (const suffix of SIDECARS) {
    if (existsSync(from + suffix)) renameSync(from + suffix, to + suffix)
  }
}

/**
 * Move the shared cache, if there is one. Processes of this version take
 * turns through the data.db write lock, so the account count can't change
 * and two of them can't move the same file. Never copies: a rename keeps
 * every row and costs nothing.
 */
export function migrateSharedCache(deps: CacheLayoutDeps): CacheLayoutResult {
  const shared = legacyCachePath(deps.dataDir)
  // The common case: one stat, no lock, no write
  if (!existsSync(shared)) return { state: 'none' }

  const { db } = deps
  const { timeout } = db.query('PRAGMA busy_timeout').get() as {
    timeout: number
  }
  db.run(`PRAGMA busy_timeout = ${MOVE_LOCK_TIMEOUT_MS}`)

  let inTransaction = false
  try {
    try {
      db.run('BEGIN IMMEDIATE')
      inTransaction = true
    } catch (err) {
      if (!isBusyError(err)) throw err
      return { state: 'blocked', reason: 'shared_cache_in_use', path: shared }
    }

    // Another process may have moved it while this one waited
    if (!existsSync(shared)) return { state: 'none' }

    const accounts = deps.accounts.getAll()
    const adopter =
      accounts.length === 1 && !anyAccountCacheExists(deps.dataDir)
        ? accounts[0]!
        : null

    const fold = foldSharedCache(shared)
    if (fold.state === 'in_use') {
      // Adopting blocks: an empty per-account cache created now would force
      // the shared file aside later. Nothing waits for a set-aside file.
      return adopter
        ? {
            state: 'blocked',
            reason: 'shared_cache_in_use',
            path: shared,
            accountId: adopter.id,
          }
        : { state: 'deferred', reason: 'shared_cache_in_use', path: shared }
    }

    if (adopter && fold.state === 'folded') {
      const target = accountCachePath(deps.dataDir, adopter.id)
      try {
        mkdirSync(accountDirPath(deps.dataDir, adopter.id), {
          recursive: true,
          mode: 0o700,
        })
        // Sidecars without their database are left over; SQLite would
        // replay a stray -wal into the moved file
        for (const suffix of SIDECARS) {
          if (existsSync(target + suffix)) unlinkSync(target + suffix)
        }
        renameSync(shared, target)
      } catch {
        return {
          state: 'blocked',
          reason: 'move_failed',
          path: shared,
          accountId: adopter.id,
        }
      }
      db.run('COMMIT')
      inTransaction = false
      return { state: 'adopted', path: target, accountId: adopter.id }
    }

    if (fold.state === 'folded' && !fold.hasData) {
      try {
        unlinkSync(shared)
      } catch {
        return { state: 'deferred', reason: 'move_failed', path: shared }
      }
      db.run('COMMIT')
      inTransaction = false
      return { state: 'deleted', path: shared }
    }

    const parked = nextSharedCachePath(deps.dataDir)
    try {
      moveWithSidecars(shared, parked)
    } catch {
      return { state: 'deferred', reason: 'move_failed', path: shared }
    }
    db.run('COMMIT')
    inTransaction = false
    deps.notice?.(
      `tg: each account now has its own cache; the shared cache of an older version can't be split by account and was kept as ${parked} (see "Upgrading to per-account caches" in docs/configuration.md)`,
    )
    return { state: 'parked', path: parked }
  } finally {
    if (inTransaction) db.run('ROLLBACK')
    db.run(`PRAGMA busy_timeout = ${timeout}`)
  }
}

export type CacheLayoutMode = 'strict' | 'report'

export interface CacheLayoutGuard {
  /**
   * Move the shared cache once per process. `strict` throws
   * CacheUnavailableError when the only account's cache can't be opened yet;
   * `report` returns that outcome as `blocked`. Every outcome but `blocked`
   * is remembered.
   */
  ensure(
    mode: CacheLayoutMode,
    notice?: (message: string) => void,
  ): CacheLayoutResult
}

export function createCacheLayoutGuard(
  getDeps: () => CacheLayoutDeps,
): CacheLayoutGuard {
  let settled: CacheLayoutResult | null = null

  return {
    ensure(mode, notice) {
      if (settled) return settled
      const deps = getDeps()
      const result = migrateSharedCache(notice ? { ...deps, notice } : deps)
      if (result.state !== 'blocked') {
        settled = result
        return result
      }
      if (mode === 'strict') {
        throw new CacheUnavailableError(
          result.reason ?? 'shared_cache_in_use',
          result.path ?? legacyCachePath(deps.dataDir),
        )
      }
      return result
    },
  }
}
