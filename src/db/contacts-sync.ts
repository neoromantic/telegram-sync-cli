/**
 * The account's contact list in its cache: users_cache.is_contact marks the
 * contacts, and the `contacts` row of sync_state says when the list was
 * last checked against Telegram (#8).
 *
 * A full list from contacts.getContacts is the truth: a user it lists is a
 * contact, a cached contact it leaves out no longer is. Rows are never
 * deleted; a former contact keeps its user row with is_contact = 0.
 */
import type { Database } from 'bun:sqlite'
import type { tl } from '@mtcute/bun'
import { toLong } from '../utils/long'
import { telegramHash } from '../utils/telegram-hash'
import { apiUserToCacheInput } from '../utils/telegram-mappers'
import { createUsersCache } from './users-cache'

/** sync_state.entity_type of the contact list */
export const CONTACTS_ENTITY = 'contacts'

function isRawUser(user: tl.TypeUser): user is tl.RawUser {
  return user._ === 'user'
}

interface ContactsStateRow {
  forward_cursor: string | null
  last_sync_at: number | null
}

function getContactsState(db: Database): ContactsStateRow | null {
  return db
    .query(
      'SELECT forward_cursor, last_sync_at FROM sync_state WHERE entity_type = $entity',
    )
    .get({ $entity: CONTACTS_ENTITY }) as ContactsStateRow | null
}

/**
 * The hash contacts.getContacts takes: Telegram's hash of the saved_count
 * of the last full list and the cached contacts' IDs, in ascending order.
 * It comes from the cache, so when the cache drifts from Telegram (an edit
 * through `tg api`, a missed update), the hash differs and Telegram sends
 * the full list. Without a recorded list it is 0, which always gets one.
 */
export function contactsHash(db: Database): tl.Long {
  const state = getContactsState(db)
  if (!state) return toLong(0)

  const ids = (
    db.query('SELECT user_id FROM users_cache WHERE is_contact = 1').all() as {
      user_id: string
    }[]
  )
    .map((row) => BigInt(row.user_id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  return toLong(telegramHash([BigInt(state.forward_cursor ?? 0), ...ids]))
}

const UNMARK_SQL = `
  UPDATE users_cache
  SET is_contact = 0,
      raw_json = CASE WHEN json_valid(raw_json)
        THEN json_set(raw_json, '$.contact', json('false'), '$.mutualContact', json('false'))
        ELSE raw_json END,
      updated_at = $now
  WHERE is_contact = 1`

/**
 * Write a full contact list to the cache, in one transaction: upsert the
 * listed users as contacts, unmark every cached contact the list leaves out
 * (fetched_at stays, the row stays), and record the list in sync_state.
 */
export function applyContactsSnapshot(
  db: Database,
  result: tl.contacts.RawContacts,
  now: number,
): { contacts: number; unmarked: number } {
  const contactIds = new Set(result.contacts.map((c) => String(c.userId)))
  const usersCache = createUsersCache(db)

  return db
    .transaction(() => {
      for (const user of result.users.filter(isRawUser)) {
        const input = apiUserToCacheInput(user)
        input.fetched_at = now
        if (contactIds.has(input.user_id)) input.is_contact = 1
        usersCache.upsert(input)
      }

      const unmarked = db
        .query(
          `${UNMARK_SQL} AND user_id NOT IN (SELECT value FROM json_each($ids))`,
        )
        .run({ $now: now, $ids: JSON.stringify([...contactIds]) }).changes

      db.query(
        `INSERT INTO sync_state (entity_type, forward_cursor, last_sync_at, updated_at)
         VALUES ($entity, $saved, $now, $now)
         ON CONFLICT(entity_type) DO UPDATE SET
           forward_cursor = excluded.forward_cursor,
           last_sync_at = excluded.last_sync_at,
           updated_at = excluded.updated_at`,
      ).run({
        $entity: CONTACTS_ENTITY,
        $saved: String(result.savedCount),
        $now: now,
      })

      return { contacts: contactIds.size, unmarked }
    })
    .immediate()
}

/** Telegram said the list is unchanged: only the check time moves */
export function markContactsNotModified(db: Database, now: number): void {
  db.query(
    'UPDATE sync_state SET last_sync_at = $now, updated_at = $now WHERE entity_type = $entity',
  ).run({ $entity: CONTACTS_ENTITY, $now: now })
}

/** Unmark every cached contact (updateContactsReset); returns how many */
export function unmarkAllContacts(db: Database, now: number): number {
  return db.query(UNMARK_SQL).run({ $now: now }).changes
}

/** When the contact list was last checked against Telegram, or null */
export function getContactsSyncedAt(db: Database): number | null {
  return getContactsState(db)?.last_sync_at ?? null
}
