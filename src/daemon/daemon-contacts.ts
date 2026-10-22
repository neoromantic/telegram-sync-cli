/**
 * The daemon keeps each account's contact list current (#8). It only reads
 * from Telegram: contacts.getContacts with the hash of the cached list, so
 * an unchanged list costs one tiny contactsNotModified reply.
 *
 * A check is due when the cached list is older than the peer TTL, or when
 * an update hinted at a change (`checkAt`). The main loop looks once at the
 * start and then every 30 ticks; a check runs in the background and never
 * holds the job loop.
 */
import type { Database } from 'bun:sqlite'
import type { TelegramClient } from '@mtcute/bun'
import { tl } from '@mtcute/bun'
import {
  applyContactsSnapshot,
  contactsHash,
  getContactsSyncedAt,
  markContactsNotModified,
} from '../db/contacts-sync'
import { createRateLimitsService } from '../db/rate-limits'
import type { DaemonContext } from './daemon-context'
import { formatError, isDaemonStopError } from './daemon-utils'

export const CONTACTS_METHOD = 'contacts.getContacts'

/** How long a check that failed (not a FLOOD_WAIT) waits before the next */
export const CONTACTS_RETRY_MS = 15 * 60 * 1000

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
    // A hint that arrived while the request ran still gets its own check
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
  ctx.logger.warn(
    `[Account ${accountId}] Contacts check failed, retrying in 15 min: ${formatError(err)}`,
  )
}
