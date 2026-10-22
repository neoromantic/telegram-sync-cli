/**
 * The contact list in the account's cache (#8): Telegram's hash, the full
 * list that unmarks former contacts, and the sync_state row
 */
import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import type { tl } from '@mtcute/bun'
import {
  applyContactsSnapshot,
  contactsHash,
  getContactsSyncedAt,
  markContactsNotModified,
  unmarkAllContacts,
} from '../db/contacts-sync'
import { createTestCacheDatabase } from '../db/schema'
import { createUsersCache } from '../db/users-cache'
import { telegramHash } from '../utils/telegram-hash'

const NOW = 1_800_000_000_000

function rawUser(id: number, contact = true): tl.RawUser {
  return {
    _: 'user',
    id,
    firstName: `User ${id}`,
    contact,
  } as tl.RawUser
}

function contactsResult(
  ids: number[],
  savedCount = 0,
): tl.contacts.RawContacts {
  return {
    _: 'contacts.contacts',
    contacts: ids.map((userId) => ({
      _: 'contact',
      userId,
      mutual: false,
    })),
    savedCount,
    users: ids.map((id) => rawUser(id)),
  }
}

function seedUser(db: Database, id: number, isContact: boolean, at = 1000) {
  createUsersCache(db).upsert({
    user_id: String(id),
    first_name: `Cached ${id}`,
    is_contact: isContact ? 1 : 0,
    fetched_at: at,
    raw_json: JSON.stringify({
      _: 'user',
      id,
      contact: isContact,
      mutualContact: isContact,
    }),
  })
}

function row(db: Database, id: number) {
  return db
    .query(
      `SELECT is_contact, fetched_at, updated_at,
              json_extract(raw_json, '$.contact') AS raw_contact,
              json_extract(raw_json, '$.mutualContact') AS raw_mutual
       FROM users_cache WHERE user_id = ?`,
    )
    .get(String(id)) as {
    is_contact: number
    fetched_at: number
    updated_at: number
    raw_contact: number
    raw_mutual: number
  } | null
}

function userCount(db: Database): number {
  return (
    db.query('SELECT COUNT(*) AS n FROM users_cache').get() as { n: number }
  ).n
}

function syncState(db: Database) {
  return db
    .query(
      "SELECT forward_cursor, last_sync_at, updated_at FROM sync_state WHERE entity_type = 'contacts'",
    )
    .get() as {
    forward_cursor: string
    last_sync_at: number
    updated_at: number
  } | null
}

describe('telegramHash', () => {
  it("matches Telegram's 64-bit hash", () => {
    expect(telegramHash([0n, 1n])).toBe(1n)
    expect(telegramHash([0n, 1n, 2n])).toBe(36507222019n)
    expect(telegramHash([2n, 1001n, 1002n])).toBe(1155301373937471n)
    expect(telegramHash([3n, 1001n, 1002n, 1003n])).toBe(4774259776744390986n)
    expect(telegramHash([0n])).toBe(0n)
  })

  it('returns a signed 64-bit value', () => {
    const ids = [1001n, 1002n, 1003n, 1004n, 1005n, 1006n, 1007n]
    const h = telegramHash([3n, ...ids])
    expect(h).toBe(-1816367931557360781n)
    expect(h).toBe(BigInt.asIntN(64, h))
  })
})

describe('contactsHash', () => {
  let db: Database
  beforeEach(() => {
    db = createTestCacheDatabase().db
  })

  it('is 0 without a recorded list', () => {
    seedUser(db, 1001, true)
    expect(contactsHash(db).toString()).toBe('0')
  })

  it('hashes saved_count and the contact IDs in numeric order', () => {
    seedUser(db, 10, true)
    seedUser(db, 9, true)
    seedUser(db, 11, false)
    applyContactsSnapshot(db, contactsResult([10, 9], 2), NOW)
    expect(contactsHash(db).toString()).toBe(
      telegramHash([2n, 9n, 10n]).toString(),
    )
  })

  it('changes when a cached contact is unmarked', () => {
    applyContactsSnapshot(db, contactsResult([1001, 1002], 2), NOW)
    const before = contactsHash(db).toString()
    db.run("UPDATE users_cache SET is_contact = 0 WHERE user_id = '1002'")
    expect(contactsHash(db).toString()).not.toBe(before)
  })
})

describe('applyContactsSnapshot', () => {
  let db: Database
  beforeEach(() => {
    db = createTestCacheDatabase().db
  })

  it('marks the listed users and unmarks the cached contacts it leaves out', () => {
    seedUser(db, 1001, true)
    seedUser(db, 1002, true, 500)
    seedUser(db, 1003, false, 700)
    const before = userCount(db)

    const applied = applyContactsSnapshot(
      db,
      contactsResult([1001, 1004], 2),
      NOW,
    )

    expect(applied).toEqual({ contacts: 2, unmarked: 1 })
    expect(row(db, 1001)?.is_contact).toBe(1)
    expect(row(db, 1004)?.is_contact).toBe(1)
    expect(row(db, 1004)?.fetched_at).toBe(NOW)

    // The former contact keeps its row, and its fetched_at
    const removed = row(db, 1002)
    expect(removed?.is_contact).toBe(0)
    expect(removed?.raw_contact).toBe(0)
    expect(removed?.raw_mutual).toBe(0)
    expect(removed?.fetched_at).toBe(500)
    expect(removed?.updated_at).toBe(NOW)

    // A cached non-contact is untouched
    const other = row(db, 1003)
    expect(other?.is_contact).toBe(0)
    expect(other?.fetched_at).toBe(700)
    expect(other?.updated_at).not.toBe(NOW)

    expect(syncState(db)).toMatchObject({
      forward_cursor: '2',
      last_sync_at: NOW,
    })
    expect(getContactsSyncedAt(db)).toBe(NOW)
    expect(userCount(db)).toBe(before + 1)
  })

  it('forces is_contact for a listed user Telegram sent without the flag', () => {
    const result = contactsResult([1001])
    result.users = [rawUser(1001, false)]
    applyContactsSnapshot(db, result, NOW)
    expect(row(db, 1001)?.is_contact).toBe(1)
  })

  it('unmarks every contact on an empty list, deleting no row', () => {
    seedUser(db, 1001, true)
    seedUser(db, 1002, true)
    const applied = applyContactsSnapshot(db, contactsResult([], 0), NOW)
    expect(applied.unmarked).toBe(2)
    expect(createUsersCache(db).getContacts()).toHaveLength(0)
    expect(userCount(db)).toBe(2)
    expect(syncState(db)?.forward_cursor).toBe('0')
  })

  it('updates the sync_state row of an earlier list', () => {
    applyContactsSnapshot(db, contactsResult([1001], 1), NOW)
    applyContactsSnapshot(db, contactsResult([1001, 1002], 2), NOW + 5)
    expect(syncState(db)).toMatchObject({
      forward_cursor: '2',
      last_sync_at: NOW + 5,
    })
    expect(
      (db.query('SELECT COUNT(*) AS n FROM sync_state').get() as { n: number })
        .n,
    ).toBe(1)
  })
})

describe('markContactsNotModified', () => {
  it('moves only the check time', () => {
    const { db } = createTestCacheDatabase()
    applyContactsSnapshot(db, contactsResult([1001], 1), NOW)
    const user = row(db, 1001)

    markContactsNotModified(db, NOW + 60_000)

    expect(syncState(db)).toMatchObject({
      forward_cursor: '1',
      last_sync_at: NOW + 60_000,
      updated_at: NOW + 60_000,
    })
    expect(row(db, 1001)).toEqual(user)
  })

  it('writes nothing without a recorded list', () => {
    const { db } = createTestCacheDatabase()
    markContactsNotModified(db, NOW)
    expect(getContactsSyncedAt(db)).toBeNull()
  })
})

describe('unmarkAllContacts', () => {
  it('unmarks every contact', () => {
    const { db } = createTestCacheDatabase()
    seedUser(db, 1001, true)
    seedUser(db, 1002, true)
    seedUser(db, 1003, false)
    expect(unmarkAllContacts(db, NOW)).toBe(2)
    expect(
      (
        db
          .query('SELECT COUNT(*) AS n FROM users_cache WHERE is_contact = 1')
          .get() as { n: number }
      ).n,
    ).toBe(0)
    expect(userCount(db)).toBe(3)
  })
})
