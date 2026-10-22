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

  describe('a file of an account that is gone', () => {
    /** data.db's accounts: ID → Telegram user (null: not known yet) */
    const accountsWith =
      (users: Record<number, number | null>) => (accountId: number) =>
        accountId in users ? users[accountId] : undefined

    beforeEach(() => {
      // Account 1 of user 101 wrote the file, then logged out
      checkCacheOwner(db, { id: 1, user_id: 101 }, PATH)
    })

    it("goes to the same Telegram user's new account", () => {
      checkCacheOwner(db, { id: 2, user_id: 101 }, PATH, {
        accountUserId: accountsWith({ 2: 101 }),
      })

      expect(readCacheMeta(db)).toEqual({ account_id: '2', user_id: '101' })
    })

    it("goes to the user's account when a recreated data.db gave its ID to another user", () => {
      checkCacheOwner(db, { id: 2, user_id: 101 }, PATH, {
        accountUserId: accountsWith({ 1: 303, 2: 101 }),
      })

      expect(readCacheMeta(db).account_id).toBe('2')
    })

    it('stays with an account that still exists', () => {
      for (const users of [
        { 1: 101, 2: 101 },
        { 1: null, 2: 101 },
      ]) {
        expect(() =>
          checkCacheOwner(db, { id: 2, user_id: 101 }, PATH, {
            accountUserId: accountsWith(users),
          }),
        ).toThrow(expect.objectContaining({ reason: 'owner_mismatch' }))
      }
      expect(readCacheMeta(db)).toEqual({ account_id: '1', user_id: '101' })
    })

    it('never goes to another Telegram user, or to an account that does not know its user', () => {
      for (const owner of [
        { id: 2, user_id: 202 },
        { id: 2, user_id: null },
      ]) {
        expect(() =>
          checkCacheOwner(db, owner, PATH, {
            accountUserId: accountsWith({ 2: owner.user_id }),
          }),
        ).toThrow(expect.objectContaining({ reason: 'owner_mismatch' }))
      }
      expect(readCacheMeta(db)).toEqual({ account_id: '1', user_id: '101' })
    })

    it('never goes anywhere without the stamped user', () => {
      const other = createTestCacheDatabase().db
      try {
        checkCacheOwner(other, { id: 1, user_id: null }, PATH)

        expect(() =>
          checkCacheOwner(other, { id: 2, user_id: 101 }, PATH, {
            accountUserId: accountsWith({ 2: 101 }),
          }),
        ).toThrow(expect.objectContaining({ reason: 'owner_mismatch' }))
      } finally {
        other.close()
      }
    })
  })
})
