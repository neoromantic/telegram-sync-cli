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
 * open: an older tg still running keeps it in place. Only a file that is
 * not a database (or a malformed one) is set aside without a fold; any
 * other error, such as a read-only file or a full disk, keeps it in place
 * too, so a single account never loses its cache to a transient error.
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

function sqliteCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = sqliteCode(err)
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
    return true
  }
  return /database is locked|database table is locked/i.test(err.message)
}

/**
 * The file itself is broken: not a database, or a malformed one. Any other
 * error (a read-only file, a full disk, an I/O error) says nothing about
 * the rows, so the file stays where it is.
 */
function isCorruptError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = sqliteCode(err)
  if (code.startsWith('SQLITE_NOTADB') || code.startsWith('SQLITE_CORRUPT')) {
    return true
  }
  return /file is not a database|database disk image is malformed/i.test(
    err.message,
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What a failed open or fold means for the file */
function foldFailure(err: unknown): FoldResult {
  if (isBusyError(err)) return { state: 'in_use' }
  if (isCorruptError(err)) return { state: 'unreadable' }
  return { state: 'error', error: errorMessage(err) }
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
  /**
   * Folded: the file holds every row and has no sidecars. `hasData` is
   * known only when the fold was asked to check it.
   */
  | { state: 'folded'; hasData?: boolean }
  /** Another process has it open */
  | { state: 'in_use' }
  /** Not a database, or a malformed one: kept as it is */
  | { state: 'unreadable' }
  /**
   * Any other error (a read-only file, a full disk, an I/O error): the file
   * stays in place, and a later run tries again
   */
  | { state: 'error'; error: string }

/**
 * Delete what a fold leaves next to the file: an empty -wal and the -shm.
 * A non-empty -wal holds rows another process wrote after the fold, so the
 * file is in use and nothing is deleted.
 */
export function removeFoldSidecars(path: string): 'removed' | 'in_use' {
  const wal = `${path}-wal`
  if (existsSync(wal)) {
    if (statSync(wal).size > 0) return 'in_use'
    unlinkSync(wal)
  }
  const shm = `${path}-shm`
  if (existsSync(shm)) unlinkSync(shm)
  return 'removed'
}

/**
 * Fold the WAL into the file. `journal_mode = DELETE` needs the only
 * connection to the file, so it also proves no other process has it open,
 * even an idle one. The presence of a -wal file proves nothing: macOS
 * leaves an empty one after a normal close. With `checkData`, it also says
 * whether any table that makes the file worth keeping has rows.
 */
export function foldSharedCache(
  path: string,
  options: { checkData?: boolean } = {},
): FoldResult {
  let db: Database
  try {
    db = new Database(path, { readwrite: true, create: false })
  } catch (err) {
    return foldFailure(err)
  }

  let hasData: boolean | undefined
  try {
    db.run(`PRAGMA busy_timeout = ${FOLD_BUSY_TIMEOUT_MS}`)
    const row = db.query('PRAGMA journal_mode = DELETE').get() as {
      journal_mode?: string
    } | null
    if (row?.journal_mode?.toLowerCase() !== 'delete') {
      return { state: 'in_use' }
    }
    if (options.checkData) {
      hasData = DATA_TABLES.some((table) => hasRows(db, table))
    }
  } catch (err) {
    return foldFailure(err)
  } finally {
    db.close()
  }

  try {
    if (removeFoldSidecars(path) === 'in_use') return { state: 'in_use' }
  } catch (err) {
    return { state: 'error', error: errorMessage(err) }
  }

  return hasData === undefined
    ? { state: 'folded' }
    : { state: 'folded', hasData }
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

    // An adopter takes the file whatever it holds, so only a file set
    // aside or deleted needs its rows checked
    const fold = foldSharedCache(shared, { checkData: adopter === null })
    if (fold.state === 'in_use' || fold.state === 'error') {
      // Adopting blocks: an empty per-account cache created now would force
      // the shared file aside later. Nothing waits for a set-aside file.
      const reason =
        fold.state === 'in_use' ? 'shared_cache_in_use' : 'move_failed'
      return adopter
        ? { state: 'blocked', reason, path: shared, accountId: adopter.id }
        : { state: 'deferred', reason, path: shared }
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

    if (fold.state === 'folded' && fold.hasData === false) {
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
