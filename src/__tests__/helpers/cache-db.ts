import { Database } from 'bun:sqlite'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'

/** An in-memory account cache with the cache and sync schemas */
export function createAccountCacheDb(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}
