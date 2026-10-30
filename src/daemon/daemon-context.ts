import type { Database } from 'bun:sqlite'
import type { AccountsDbInterface } from '../db'
import type { DaemonStatusService } from '../db/daemon-status'
import { type CacheRetentionConfig, getDefaultCacheConfig } from '../db/types'
import {
  createMigrationsState,
  type MigrationsState,
} from './daemon-migrations'
import { DaemonStopError } from './daemon-utils'
import type { PidFile } from './pid-file'
import type { SyncScheduler } from './scheduler'
import type { RealSyncWorker } from './sync-worker'
import type {
  DaemonLogger,
  DaemonState,
  DaemonVerbosity,
  ReconnectConfig,
} from './types'

/**
 * One account's share of the daemon: its own cache, scheduler and sync
 * worker. A job queued in an account's cache runs only on that account's
 * client, with that account's access hashes and rate limits.
 */
export interface AccountRuntime {
  accountId: number
  /** The account's cache database, accounts/<id>/cache.db */
  db: Database
  statusService: DaemonStatusService
  /** Created once the account connects at startup */
  scheduler: SyncScheduler | null
  /** Bound to the account's current client; null while it is disconnected */
  worker: RealSyncWorker | null
  /** When the account's last job finished; each account waits its own delay */
  lastJobProcessTime: number
  /** Messages cached for this account since the daemon started */
  messagesSynced: number
}

export interface DaemonRuntime {
  accounts: Map<number, AccountRuntime>
  /** Each account's running sync job; one at a time per account */
  jobsInFlight: Map<number, Promise<void>>
  signalHandlersSetup: boolean
  /** Accounts whose dialog pass after a reconnect is still running */
  dialogPassesInFlight: Set<number>
  /**
   * Aborted by a daemon stop: the dialog passes and sync jobs pass its
   * signal to their requests, so a FLOOD_WAIT they wait out ends at once
   */
  shutdown: AbortController
  /** The background contacts sync of every account (#8) */
  contacts: ContactsSyncState
  /** The background migrations of every account's cache (#89) */
  migrations: MigrationsState
  /**
   * Wall clock when the main loop began its 1-second wait; a much longer
   * wait means the computer slept (#124)
   */
  sleepStartedAt: number | null
}

export interface ContactsSyncState {
  /**
   * How old the account's contact list may get before the daemon checks it
   * again: `cache.staleness.peers`, read when the daemon starts
   */
  peersTtlMs: number
  /** Accounts whose contacts.getContacts is still running */
  inFlight: Set<number>
  /** Per account: no check before this time, after a failed one */
  retryAt: Map<number, number>
  /** Per account: an update hinted at a change, check at this time */
  checkAt: Map<number, number>
}

export interface DaemonContext {
  dataDir: string
  pidPath: string
  verbosity: DaemonVerbosity
  reconnectConfig: ReconnectConfig
  shutdownTimeoutMs: number
  logger: DaemonLogger
  pidFile: PidFile
  state: DaemonState
  accountsDb: AccountsDbInterface
  runtime: DaemonRuntime
  /**
   * How long each cache keeps its bookkeeping rows, read from config.json
   * once at start; the defaults when absent
   */
  retention?: CacheRetentionConfig
}

export function createDaemonRuntime(): DaemonRuntime {
  return {
    accounts: new Map(),
    jobsInFlight: new Map(),
    signalHandlersSetup: false,
    dialogPassesInFlight: new Set(),
    shutdown: new AbortController(),
    contacts: {
      peersTtlMs: getDefaultCacheConfig().staleness.peers,
      inFlight: new Set(),
      retryAt: new Map(),
      checkAt: new Map(),
    },
    migrations: createMigrationsState(),
    sleepStartedAt: null,
  }
}

/**
 * Ask the daemon to stop: the loops end at their next check, and the
 * requests the dialog passes and sync jobs wait on end at once (#64)
 */
export function requestShutdown(ctx: DaemonContext): void {
  ctx.state.shutdownRequested = true
  if (!ctx.runtime.shutdown.signal.aborted) {
    ctx.runtime.shutdown.abort(new DaemonStopError())
  }
}

/** Messages cached since the daemon started, over every account */
export function totalMessagesSynced(runtime: DaemonRuntime): number {
  let total = 0
  for (const rt of runtime.accounts.values()) total += rt.messagesSynced
  return total
}
