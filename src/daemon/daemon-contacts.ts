/**
 * The daemon keeps each account's contact list current (#8). It only reads
 * from Telegram: contacts.getContacts with the hash of the cached list, so
 * an unchanged list costs one tiny contactsNotModified reply.
 *
 * A check is due when the cached list is older than the peer TTL, after
 * each start and reconnect, or when an update hinted at a change
 * (`checkAt`). The main loop looks once at the
 * start and then every 30 ticks; a check runs in the background and never
 * holds the job loop.
 */
import type { Database } from 'bun:sqlite'
import type { RawUpdateInfo, TelegramClient } from '@mtcute/bun'
import { tl } from '@mtcute/bun'
import { ConfigError, getResolvedCacheConfig } from '../config'
import {
  applyContactsSnapshot,
  contactsHash,
  getContactsSyncedAt,
  markContactsNotModified,
  unmarkAllContacts,
} from '../db/contacts-sync'
import { createRateLimitsService } from '../db/rate-limits'
import { createUsersCache } from '../db/users-cache'
import { apiUserToCacheInput } from '../utils/telegram-mappers'
import type { DaemonContext } from './daemon-context'
import { formatError, isDaemonStopError } from './daemon-utils'

export const CONTACTS_METHOD = 'contacts.getContacts'

/** How long a check that failed (not a FLOOD_WAIT) waits before the next */
export const CONTACTS_RETRY_MS = 15 * 60 * 1000

/**
 * How soon an update that hints at a contact change, without the user's
 * full record, gets a hash check. Hints in that window share one check.
 */
export const CONTACTS_HINT_DELAY_MS = 60_000

/**
 * The contacts sync waits `cache.staleness.peers` between checks. It is
 * read once here; a config change takes effect at the next start. A config
 * that can't be read keeps the default and says so.
 */
export async function loadContactsTtl(ctx: DaemonContext): Promise<void> {
  try {
    const config = await getResolvedCacheConfig({ dataDir: ctx.dataDir })
    ctx.runtime.contacts.peersTtlMs = config.staleness.peers
  } catch (err) {
    // Not worth stopping a daemon whose accounts already connected
    const why = err instanceof ConfigError ? err.message : formatError(err)
    ctx.logger.warn(
      `Failed to read the cache config, contacts sync uses the default peer TTL: ${why}`,
    )
  }
}

/**
 * Start a contacts check for every connected account that is due. Returns
 * the checks it started, so a test can wait for them; the main loop doesn't.
 */
export function maybeSyncContacts(
  ctx: DaemonContext,
  now: number,
): Promise<void>[] {
  const started: Promise<void>[] = []
  const state = ctx.runtime.contacts

  for (const accountState of ctx.state.accounts.values()) {
    if (ctx.state.shutdownRequested) break
    const { accountId, client } = accountState
    if (accountState.status !== 'connected' || !client) continue
    const rt = ctx.runtime.accounts.get(accountId)
    if (!rt) continue
    if (state.inFlight.has(accountId)) continue
    if (now < (state.retryAt.get(accountId) ?? 0)) continue

    try {
      if (createRateLimitsService(rt.db).isBlocked(CONTACTS_METHOD)) continue

      const syncedAt = getContactsSyncedAt(rt.db)
      const checkAt = state.checkAt.get(accountId)
      const due =
        syncedAt === null ||
        now - syncedAt >= state.peersTtlMs ||
        (checkAt !== undefined && checkAt <= now)
      if (!due) continue
    } catch (err) {
      ctx.logger.warn(
        `[Account ${accountId}] Failed to check whether contacts are due: ${formatError(err)}`,
      )
      continue
    }

    started.push(syncAccountContacts(ctx, accountId, client, now))
  }

  return started
}

/**
 * One contacts check of the account: fetch the list with the cache's hash
 * and write what Telegram answers to the account's own cache. Never throws.
 */
export async function syncAccountContacts(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
  now: number,
): Promise<void> {
  const state = ctx.runtime.contacts
  const rt = ctx.runtime.accounts.get(accountId)
  if (!rt || state.inFlight.has(accountId)) return
  state.inFlight.add(accountId)

  try {
    createRateLimitsService(rt.db).recordCall(CONTACTS_METHOD)
    const result = await client
      .withParams({ abortSignal: ctx.runtime.shutdown.signal })
      .call({ _: CONTACTS_METHOD, hash: contactsHash(rt.db) })

    // A stop while the request ran: write nothing. The check and the write
    // are one synchronous block, so a stop can't land between them.
    if (ctx.state.shutdownRequested) {
      ctx.logger.debug(
        `[Account ${accountId}] Contacts check ended by the daemon stop`,
      )
      return
    }

    if (result._ === 'contacts.contactsNotModified') {
      markContactsNotModified(rt.db, now)
      ctx.logger.debug(`[Account ${accountId}] Contacts unchanged`)
    } else {
      const applied = applyContactsSnapshot(rt.db, result, now)
      ctx.logger.info(
        `[Account ${accountId}] Contacts synced: ${applied.contacts} (${applied.unmarked} no longer contacts)`,
      )
    }
    // A hint that arrived while the request ran was moved past `now`
    if ((state.checkAt.get(accountId) ?? Number.POSITIVE_INFINITY) <= now) {
      state.checkAt.delete(accountId)
    }
    state.retryAt.delete(accountId)
  } catch (err) {
    handleContactsError(ctx, accountId, rt.db, err, now)
  } finally {
    state.inFlight.delete(accountId)
  }
}

function handleContactsError(
  ctx: DaemonContext,
  accountId: number,
  db: Database,
  err: unknown,
  now: number,
): void {
  if (isDaemonStopError(err) || ctx.state.shutdownRequested) {
    ctx.logger.debug(
      `[Account ${accountId}] Contacts check ended by the daemon stop`,
    )
    return
  }

  const state = ctx.runtime.contacts
  if (tl.RpcError.is(err, 'FLOOD_WAIT_%d')) {
    const seconds = Math.max(1, err.seconds)
    state.retryAt.set(accountId, now + seconds * 1000)
    try {
      // The CLI sees it too: they share the account's rate limits
      createRateLimitsService(db).setFloodWait(CONTACTS_METHOD, seconds)
    } catch (writeErr) {
      ctx.logger.warn(
        `[Account ${accountId}] Failed to record the FLOOD_WAIT: ${formatError(writeErr)}`,
      )
    }
    ctx.logger.warn(
      `[Account ${accountId}] Contacts check hit FLOOD_WAIT, retrying in ${seconds}s`,
    )
    return
  }

  state.retryAt.set(accountId, now + CONTACTS_RETRY_MS)
  // A reconnect closes the old client, failing its request; the new one checks
  if (ctx.state.accounts.get(accountId)?.status !== 'connected') {
    ctx.logger.debug(
      `[Account ${accountId}] Contacts check ended by a lost connection: ${formatError(err)}`,
    )
    return
  }
  ctx.logger.warn(
    `[Account ${accountId}] Contacts check failed, retrying in 15 min: ${formatError(err)}`,
  )
}

/**
 * Ask for a hash check of the account's contacts in a minute. A request
 * that is already pending keeps its time, so a burst of hints costs one check.
 * A request that a running check is serving doesn't count: that check's
 * reply may predate the change, so the hint gets a check of its own.
 */
export function requestContactsCheck(
  ctx: DaemonContext,
  accountId: number,
  now: number,
): void {
  const { checkAt, inFlight } = ctx.runtime.contacts
  const at = checkAt.get(accountId)
  if (at === undefined || (inFlight.has(accountId) && at <= now)) {
    checkAt.set(accountId, now + CONTACTS_HINT_DELAY_MS)
  }
}

/**
 * Check the account's contacts at the next look, whatever the TTL. The
 * daemon calls it after each start and reconnect: its clients don't catch
 * up on updates missed while they were down (mtcute's `catchUp` is off),
 * so a contact change made then reaches the cache only through a check.
 * It drops the 15-minute wait of a failed check, which a dropped connection
 * usually caused; a FLOOD_WAIT still holds through the rate limits.
 */
export function requestContactsCheckNow(
  ctx: DaemonContext,
  accountId: number,
  now: number,
): void {
  ctx.runtime.contacts.checkAt.set(accountId, now)
  ctx.runtime.contacts.retryAt.delete(accountId)
}

/**
 * Apply a contact change from a real-time update to the account's own
 * cache. Telegram has no "contact added" update: a change on another device
 * comes as updatePeerSettings or updateUser, with the user's record in the
 * update's peers when Telegram includes it. A full record whose contact
 * flag differs from the cache is written; a hint without one asks for a
 * hash check. updateContactsReset unmarks every contact and checks at once.
 * Never throws.
 */
export function handleContactRawUpdate(
  ctx: DaemonContext,
  accountId: number,
  db: Database,
  info: RawUpdateInfo,
  now: number,
): void {
  const update = info.update
  let userId: number
  switch (update._) {
    case 'updatePeerSettings':
      if (update.peer._ !== 'peerUser') return
      userId = update.peer.userId
      break
    case 'updateUser':
      userId = update.userId
      break
    case 'updateContactsReset':
      try {
        const unmarked = unmarkAllContacts(db, now)
        ctx.runtime.contacts.checkAt.set(accountId, now)
        ctx.logger.info(
          `[Account ${accountId}] Contacts reset by Telegram: ${unmarked} unmarked, checking the list`,
        )
      } catch (err) {
        ctx.logger.error(
          `[Account ${accountId}] Error handling a contacts reset: ${formatError(err)}`,
        )
      }
      return
    default:
      return
  }

  try {
    const user = info.peers.users.get(userId)
    if (user?._ !== 'user' || user.min) {
      requestContactsCheck(ctx, accountId, now)
      return
    }

    const isContact = user.contact ? 1 : 0
    const cached = db
      .query('SELECT is_contact FROM users_cache WHERE user_id = ?')
      .get(String(userId)) as { is_contact: number } | null
    // A non-contact we don't cache stays out; an unchanged flag costs no write
    if (cached ? cached.is_contact === isContact : !isContact) return

    const input = apiUserToCacheInput(user)
    input.fetched_at = now
    createUsersCache(db).upsert(input)
    // A running check's older list would overwrite this row and set the hash
    if (ctx.runtime.contacts.inFlight.has(accountId)) {
      requestContactsCheck(ctx, accountId, now)
    }
    ctx.logger.debug(
      `[Account ${accountId}] User ${userId} ${isContact ? 'is now a contact' : 'is no longer a contact'}`,
    )
  } catch (err) {
    ctx.logger.error(
      `[Account ${accountId}] Error handling a contact update: ${formatError(err)}`,
    )
  }
}
