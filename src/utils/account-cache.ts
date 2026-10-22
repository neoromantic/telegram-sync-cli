import type { Database } from 'bun:sqlite'
import {
  type AccountsDbInterface,
  type CacheLayoutResult,
  CacheUnavailableError,
  accountsDb as defaultAccountsDb,
  ensureCacheLayout,
  getAccountCacheDb,
  getLegacyCachePath,
  isCacheUnavailableError,
} from '../db'
import type { CacheUnavailableReason } from '../db/cache-layout'
import { type Account, ErrorCodes } from '../types'
import { resolveAccount } from './account-selector'
import { error } from './output'

const CACHE_UNAVAILABLE_SUGGESTIONS: Record<CacheUnavailableReason, string> = {
  shared_cache_in_use: 'Stop older tg processes (tg daemon stop), then retry',
  move_failed:
    'Check that the data directory is writable, stop older tg processes, then retry',
  owner_mismatch:
    'Move the account directory away (tg starts a new cache), or put it under an account of the Telegram user it belongs to',
}

/** What to do about a cache that can't be opened */
export function cacheUnavailableSuggestion(reason: string): string {
  return (
    CACHE_UNAVAILABLE_SUGGESTIONS[reason as CacheUnavailableReason] ??
    CACHE_UNAVAILABLE_SUGGESTIONS.move_failed
  )
}

/** Report a cache that can't be opened, or rethrow another error */
export function reportCacheError(err: unknown, accountId?: number): never {
  if (isCacheUnavailableError(err)) {
    error(
      ErrorCodes.CACHE_UNAVAILABLE,
      err.message,
      {
        reason: err.reason,
        path: err.path,
        ...(accountId !== undefined && { account_id: accountId }),
      },
      cacheUnavailableSuggestion(err.reason),
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  error(
    ErrorCodes.GENERAL_ERROR,
    `Failed to open the cache${accountId !== undefined ? ` of account ${accountId}` : ''}: ${message}`,
  )
}

/**
 * The account a command works on (`--account`, the active account or the
 * only one) and its cache database. Fails with the command's error codes,
 * so call it before the command's own try block.
 */
export function openAccountCache(
  selector: string | undefined,
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): { account: Account; db: Database } {
  const account = resolveAccount(selector, accountsDb)
  try {
    return { account, db: getAccountCacheDb(account.id) }
  } catch (err) {
    reportCacheError(err, account.id)
  }
}

/**
 * Move the shared cache of 0.3 and older before a command adds or removes
 * an account, and fail with CACHE_UNAVAILABLE while it can't move yet. The
 * move decides by the account count when it runs, so an account change
 * while the file waits would decide for it later: a second account added
 * to one would force the first one's cache aside, and removing one of two
 * (or adding the first account to none) would hand the one that is left a
 * file that other accounts wrote. So no account changes while an older tg
 * holds the file or the move fails, whatever the count.
 */
export function settleCacheLayoutBeforeAccountChange(): void {
  let result: CacheLayoutResult
  try {
    result = ensureCacheLayout({ mode: 'report' })
  } catch (err) {
    reportCacheError(err)
  }
  if (result.state === 'deferred' || result.state === 'blocked') {
    reportCacheError(
      new CacheUnavailableError(
        result.reason ?? 'shared_cache_in_use',
        result.path ?? getLegacyCachePath(),
      ),
    )
  }
}
