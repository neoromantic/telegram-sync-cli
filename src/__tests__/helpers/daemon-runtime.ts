/**
 * Per-account daemon runtimes for unit tests: each account gets its own
 * in-memory cache, as accounts/<id>/cache.db is in production.
 */
import { Database } from 'bun:sqlite'
import type { AccountRuntime, DaemonContext } from '../../daemon/daemon-context'
import { createSyncPacer } from '../../daemon/sync-pacing'
import { createDaemonStatusService } from '../../db/daemon-status'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'

/** An in-memory database with the cache schema */
export function createAccountCacheDb(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}

/** Give the context a runtime for the account, on its own cache */
export function addAccountRuntime(
  ctx: DaemonContext,
  accountId: number,
  db: Database = createAccountCacheDb(),
  overrides: Partial<AccountRuntime> = {},
): AccountRuntime {
  const rt: AccountRuntime = {
    accountId,
    db,
    statusService: createDaemonStatusService(db),
    scheduler: null,
    worker: null,
    pacer: createSyncPacer(),
    messagesSynced: 0,
    ...overrides,
  }
  ctx.runtime.accounts.set(accountId, rt)
  return rt
}
