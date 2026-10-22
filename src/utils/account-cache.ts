import type { Database } from 'bun:sqlite'
import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
  ensureCacheLayout,
  getAccountCacheDb,
  isCacheUnavailableError,
} from '../db'
import type {
  CacheLayoutMode,
  CacheUnavailableReason,
} from '../db/cache-layout'
import { type Account, ErrorCodes } from '../types'
import { resolveAccount } from './account-selector'
import { error } from './output'

const CACHE_UNAVAILABLE_SUGGESTIONS: Record<CacheUnavailableReason, string> = {
  shared_cache_in_use: 'Stop older tg processes (tg daemon stop), then retry',
  move_failed:
    'Check that the data directory is writable, stop older tg processes, then retry',
  owner_mismatch:
    'Move the account directory away (tg starts a new cache) or put it back under the account it belongs to',
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
 * an account: the move decides by the account count, so with one account
 * the file is that account's cache, and a second account added first would
 * force it aside. `strict` (adding an account) fails the command while the
 * only account's cache can't move yet; `report` goes on.
 */
export function settleCacheLayoutBeforeAccountChange(
  mode: CacheLayoutMode,
): void {
  try {
    ensureCacheLayout({ mode })
  } catch (err) {
    reportCacheError(err)
  }
}
