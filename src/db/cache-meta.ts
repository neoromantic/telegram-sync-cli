/**
 * The owner stamp of an account's cache file, in `cache_meta`. A file that
 * another account (or another Telegram user) stamped is never opened for
 * this one, so a directory moved by hand or a data.db that was recreated
 * and reused an ID can't mix two accounts' data.
 */
import type { Database } from 'bun:sqlite'
import { CacheUnavailableError } from './cache-layout'

export interface CacheOwner {
  /** `accounts.id` in data.db */
  id: number
  /** The Telegram user ID, once the account knows it */
  user_id: number | null
}

export interface CacheMeta {
  account_id: string | null
  user_id: string | null
}

export function readCacheMeta(db: Database): CacheMeta {
  const rows = db
    .query(
      "SELECT key, value FROM cache_meta WHERE key IN ('account_id', 'user_id')",
    )
    .all() as Array<{ key: string; value: string }>
  const meta: CacheMeta = { account_id: null, user_id: null }
  for (const row of rows) {
    if (row.key === 'account_id' || row.key === 'user_id') {
      meta[row.key] = row.value
    }
  }
  return meta
}

export interface CacheOwnerOptions {
  /**
   * The Telegram user of an account in data.db: null while it doesn't know
   * it, undefined if there is no such account. A file stamped for the same
   * Telegram user and for an account ID that is gone (logged out, removed)
   * or now belongs to another user (a recreated data.db) is handed to this
   * account, so a re-login can take its old cache back. Without it, any
   * other account ID is a mismatch.
   */
  accountUserId?: (accountId: number) => number | null | undefined
}

type Ownership = 'own' | 'reclaim' | 'foreign'

function ownership(
  meta: CacheMeta,
  owner: CacheOwner,
  options: CacheOwnerOptions,
): Ownership {
  if (
    meta.user_id !== null &&
    owner.user_id !== null &&
    meta.user_id !== String(owner.user_id)
  ) {
    return 'foreign'
  }
  if (meta.account_id === null || meta.account_id === String(owner.id)) {
    return 'own'
  }
  // Another account ID: only one that no longer is this Telegram user's
  const stampedId = Number(meta.account_id)
  const sameUser =
    meta.user_id !== null &&
    owner.user_id !== null &&
    meta.user_id === String(owner.user_id)
  if (!sameUser || !Number.isSafeInteger(stampedId) || !options.accountUserId) {
    return 'foreign'
  }
  const stampedUser = options.accountUserId(stampedId)
  const stampedAccountGone =
    stampedUser === undefined ||
    (stampedUser !== null && String(stampedUser) !== meta.user_id)
  return stampedAccountGone ? 'reclaim' : 'foreign'
}

function missingStamps(
  meta: CacheMeta,
  owner: CacheOwner,
): Array<[string, string]> {
  const stamps: Array<[string, string]> = []
  if (meta.account_id === null) stamps.push(['account_id', String(owner.id)])
  if (meta.user_id === null && owner.user_id !== null) {
    stamps.push(['user_id', String(owner.user_id)])
  }
  return stamps
}

/**
 * Throw CacheUnavailableError('owner_mismatch') if the file belongs to
 * another account; stamp what is missing otherwise. A file of an account
 * that data.db no longer has, stamped for the same Telegram user, is
 * stamped for this account instead (see CacheOwnerOptions). A stamped file
 * is only read, so opening it never waits for the write lock.
 */
export function checkCacheOwner(
  db: Database,
  owner: CacheOwner,
  path: string,
  options: CacheOwnerOptions = {},
): void {
  const meta = readCacheMeta(db)
  const found = ownership(meta, owner, options)
  if (found === 'foreign') {
    throw new CacheUnavailableError('owner_mismatch', path)
  }
  if (found === 'own' && missingStamps(meta, owner).length === 0) return

  const stamp = db.transaction(() => {
    // Read again under the write lock: another process may have stamped it
    const current = readCacheMeta(db)
    const now = ownership(current, owner, options)
    if (now === 'foreign') {
      throw new CacheUnavailableError('owner_mismatch', path)
    }
    if (now === 'reclaim') {
      db.prepare(
        "INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('account_id', $value)",
      ).run({ $value: String(owner.id) })
    }
    const insert = db.prepare(
      'INSERT OR IGNORE INTO cache_meta (key, value) VALUES ($key, $value)',
    )
    for (const [key, value] of missingStamps(current, owner)) {
      insert.run({ $key: key, $value: value })
    }
  })
  stamp.immediate()
}
