/**
 * Catch-up after mtcute reconnects on its own or the computer wakes (#124).
 *
 * mtcute reconnects by itself after a network drop or a sleep, so the
 * health check's `getMe()` succeeds and the daemon's own reconnect never
 * runs. The daemon watches each client's connection state and the wall
 * clock between its loop ticks instead: after the account was offline
 * longer than a few seconds, or after a wake, it runs the dialog pass and
 * catch-up on the client it has. Catch-up is never polling: it runs on
 * start, after a reconnect and after a wake.
 */
import type { ConnectionState } from '@mtcute/bun'
import type { CatchUpReason } from '../db/daemon-status'
import { refreshDialogsAfterReconnect } from './daemon-bootstrap'
import type { DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'
import type { AccountConnectionState } from './types'

/** Offline for longer than this: messages may have been missed */
export const OFFLINE_CATCH_UP_MS = 5_000
/** The loop's 1-second wait took this long: the computer slept */
export const WAKE_GAP_MS = 30_000
/** The connection must stay up this long before the pass starts */
export const CATCH_UP_SETTLE_MS = 5_000
/** At most one pass per account in this time, however often it flaps */
export const CATCH_UP_MIN_INTERVAL_MS = 5 * 60_000

export interface PendingCatchUp {
  reason: CatchUpReason
  offlineMs: number
  /** Not before this time */
  dueAt: number
}

/** One account's connection, as its client last reported it */
export interface ConnectionWatch {
  online: boolean
  /** When the connection went down; cleared when it is back */
  offlineSince?: number
  /** A catch-up that waits for the connection to settle */
  pending?: PendingCatchUp
  /** When the last pass after a reconnect or a wake started */
  lastCatchUpAt?: number
}

export function createConnectionWatch(): ConnectionWatch {
  return { online: true }
}

function requestCatchUp(
  watch: ConnectionWatch,
  reason: CatchUpReason,
  offlineMs: number,
  now: number,
): void {
  const notBefore =
    watch.lastCatchUpAt === undefined
      ? now + CATCH_UP_SETTLE_MS
      : Math.max(
          now + CATCH_UP_SETTLE_MS,
          watch.lastCatchUpAt + CATCH_UP_MIN_INTERVAL_MS,
        )
  const previous = watch.pending
  watch.pending = {
    // A wake explains the outage better than the reconnect that follows it
    reason: previous?.reason === 'wake' ? 'wake' : reason,
    offlineMs: Math.max(previous?.offlineMs ?? 0, offlineMs),
    dueAt: notBefore,
  }
}

/**
 * Note a state the client reported. `connecting` and `offline` take the
 * account down; `connected` and `updating` (mtcute fetching what it missed)
 * bring it back. Back after more than `OFFLINE_CATCH_UP_MS` asks for a
 * catch-up; a pending one waits again for the connection to settle.
 */
export function noteConnectionState(
  watch: ConnectionWatch,
  state: ConnectionState,
  now: number,
): void {
  if (state === 'offline' || state === 'connecting') {
    if (watch.online) {
      watch.online = false
      watch.offlineSince = now
    }
    return
  }

  if (watch.online) return
  watch.online = true
  const offlineMs = now - (watch.offlineSince ?? now)
  watch.offlineSince = undefined
  if (offlineMs > OFFLINE_CATCH_UP_MS) {
    requestCatchUp(watch, 'reconnect', offlineMs, now)
  } else if (watch.pending) {
    watch.pending.dueAt = Math.max(
      watch.pending.dueAt,
      now + CATCH_UP_SETTLE_MS,
    )
  }
}

/**
 * Compare the wall clock with the start of the loop's 1-second wait: a wait
 * of more than `WAKE_GAP_MS` means the computer slept, and every connected
 * account catches up. Only the wait counts, so a slow tick (a health check
 * during an outage) is no wake. Returns the gap when it was one.
 */
export function detectWake(ctx: DaemonContext, now: number): number | null {
  const last = ctx.runtime.sleepStartedAt
  ctx.runtime.sleepStartedAt = null
  if (last === null) return null
  const gap = now - last
  if (gap <= WAKE_GAP_MS) return null

  ctx.logger.debug(`Woke after ${Math.round(gap / 1000)} s; catching up`)
  for (const accountState of ctx.state.accounts.values()) {
    if (accountState.status !== 'connected' || !accountState.watch) continue
    requestCatchUp(accountState.watch, 'wake', gap, now)
  }
  return gap
}

function takeDueCatchUp(
  accountState: AccountConnectionState,
  now: number,
): PendingCatchUp | null {
  const { watch } = accountState
  const pending = watch?.pending
  if (!watch || !pending || !watch.online || now < pending.dueAt) return null
  if (accountState.status !== 'connected' || !accountState.client) return null
  watch.pending = undefined
  watch.lastCatchUpAt = now
  return pending
}

/**
 * Start the catch-up of every account whose connection came back and
 * settled: a dialog pass on the account's current client, then the
 * scheduler queues catch-up for the chats whose newest message moved.
 * Each runs in the background; returns them for tests.
 */
export function runDueCatchUps(
  ctx: DaemonContext,
  now: number,
): Promise<boolean>[] {
  if (ctx.state.shutdownRequested) return []
  const started: Promise<boolean>[] = []
  for (const accountState of ctx.state.accounts.values()) {
    const { accountId } = accountState
    const rt = ctx.runtime.accounts.get(accountId)
    // An account that didn't connect at start has no scheduler to queue
    // the catch-up; a pass already running covers this one
    if (!rt?.scheduler || ctx.runtime.dialogPassesInFlight.has(accountId)) {
      continue
    }
    const pending = takeDueCatchUp(accountState, now)
    if (!pending || !accountState.client) continue

    started.push(
      refreshDialogsAfterReconnect(ctx, accountId, accountState.client, {
        reason: pending.reason,
        offlineMs: pending.offlineMs,
      }).catch((err) => {
        ctx.logger.error(
          `[Account ${accountId}] Catch-up after a reconnect failed: ${formatError(err)}`,
        )
        return false
      }),
    )
  }
  return started
}
