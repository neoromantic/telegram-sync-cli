/**
 * The owner stamp of an account's cache (src/db/cache-meta.ts)
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { CacheUnavailableError } from '../db/cache-layout'
import { checkCacheOwner, readCacheMeta } from '../db/cache-meta'
import { createTestCacheDatabase } from '../db/schema'

const PATH = 'accounts/1/cache.db'

describe('checkCacheOwner', () => {
  let db: Database

  beforeEach(() => {
    db = createTestCacheDatabase().db
  })

  afterEach(() => {
    db.close()
  })

  function ownerError(owner: { id: number; user_id: number | null }) {
    try {
      checkCacheOwner(db, owner, PATH)
    } catch (err) {
      return err
    }
    throw new Error('Expected owner_mismatch')
  }

  it('stamps a new file with the account ID', () => {
    checkCacheOwner(db, { id: 1, user_id: null }, PATH)

    expect(readCacheMeta(db)).toEqual({ account_id: '1', user_id: null })
  })

  it('adds the user ID once the account knows it', () => {
    checkCacheOwner(db, { id: 1, user_id: null }, PATH)
    checkCacheOwner(db, { id: 1, user_id: 101 }, PATH)

    expect(readCacheMeta(db)).toEqual({ account_id: '1', user_id: '101' })
  })

  it('opens a file stamped for the same account and user', () => {
    checkCacheOwner(db, { id: 1, user_id: 101 }, PATH)

    expect(() =>
      checkCacheOwner(db, { id: 1, user_id: 101 }, PATH),
    ).not.toThrow()
    // An account that doesn't know its user yet opens it too
    expect(() =>
      checkCacheOwner(db, { id: 1, user_id: null }, PATH),
    ).not.toThrow()
  })

  it('refuses a file stamped for another Telegram user', () => {
    checkCacheOwner(db, { id: 1, user_id: 101 }, PATH)

    const err = ownerError({ id: 1, user_id: 202 })

    expect(err).toBeInstanceOf(CacheUnavailableError)
    expect(err).toMatchObject({ reason: 'owner_mismatch', path: PATH })
    expect(readCacheMeta(db)).toEqual({ account_id: '1', user_id: '101' })
  })

  it('refuses a file stamped for another account ID', () => {
    checkCacheOwner(db, { id: 2, user_id: null }, PATH)

    expect(ownerError({ id: 1, user_id: null })).toMatchObject({
      reason: 'owner_mismatch',
    })
    expect(readCacheMeta(db)).toEqual({ account_id: '2', user_id: null })
  })
})
