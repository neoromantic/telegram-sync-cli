/**
 * Daemon status service
 * Key-value store for daemon state tracking
 */
import type { Database } from 'bun:sqlite'
import { DaemonStatusRow } from './sync-schema'

/**
 * What the daemon last wrote to one account's cache. Each account's file has
 * its own rows: a row counts only while its daemon_pid is the live daemon's.
 */
export interface DaemonInfo {
  status: 'running' | 'stopped'
  pid: number | null
  /** The version the running daemon recorded at start; null if none */
  version: string | null
  startedAt: number | null
  lastUpdate: number | null
  /** The account's connection: connected, reconnecting, error, … */
  connectionStatus: string | null
  lastError: string | null
  /** Messages the daemon cached for this account since it started */
  messagesSynced: number
  pendingJobs: number
  runningJobs: number
}

/** One main-loop tick's figures for an account */
export interface DaemonTick {
  connectionStatus: string
  lastError: string | null
  messagesSynced: number
  pendingJobs: number
  runningJobs: number
}

/**
 * Daemon status service interface
 */
export interface DaemonStatusService {
  /** Get a value by key */
  get(key: string): string | null
  /** Set a value */
  set(key: string, value: string): void
  /** Delete a key */
  delete(key: string): void
  /** Get all key-value pairs */
  getAll(): Record<string, string>
  /** Clear all values */
  clear(): void

  // Convenience methods
  /**
   * Mark daemon as running with given PID and version: the account is
   * `connecting`, and the previous run's error and job counts are gone
   */
  setDaemonRunning(pid: number, version: string): void
  /** Mark daemon as stopped */
  setDaemonStopped(): void
  /** Check if daemon is running */
  isDaemonRunning(): boolean
  /** Update last update timestamp */
  updateLastUpdate(): void
  /** Set total messages synced */
  setMessagesSynced(count: number): void
  /** Write a tick's figures and last_update in one transaction */
  writeTick(tick: DaemonTick): void
  /** Get all daemon info */
  getDaemonInfo(): DaemonInfo
}

/** The daemon's figures over every account it runs */
export interface DaemonSummary {
  /** Accounts whose rows the live daemon wrote and that are connected */
  connectedAccounts: number
  /** Accounts whose rows the live daemon wrote */
  totalAccounts: number
  /**
   * The version the live daemon recorded in its rows; null without live
   * rows or when it recorded none
   */
  version: string | null
  messagesSynced: number
  /** The earliest start among the live rows */
  startedAt: number | null
  /**
   * The newest update among the live rows; without a live daemon, the
   * newest any daemon wrote, so a stopped daemon still says when it last ran
   */
  lastUpdate: number | null
}

/**
 * Sum the accounts' rows. Only rows whose daemon_pid is the live daemon's
 * PID (from daemon.pid) count: a stopped daemon's or an older version's rows
 * say nothing about now. Only lastUpdate of a stopped daemon reads them.
 */
export function summarizeDaemonStatus(
  infos: DaemonInfo[],
  livePid: number | null,
): DaemonSummary {
  const live =
    livePid === null
      ? []
      : infos.filter(
          (info) => info.status === 'running' && info.pid === livePid,
        )
  const startTimes = live.flatMap((info) =>
    info.startedAt === null ? [] : [info.startedAt],
  )
  const updates = (livePid === null ? infos : live).flatMap((info) =>
    info.lastUpdate === null ? [] : [info.lastUpdate],
  )
  return {
    connectedAccounts: live.filter(
      (info) => info.connectionStatus === 'connected',
    ).length,
    totalAccounts: live.length,
    // Every live row is the same daemon's
    version: live.find((info) => info.version !== null)?.version ?? null,
    messagesSynced: live.reduce((sum, info) => sum + info.messagesSynced, 0),
    startedAt: startTimes.length > 0 ? Math.min(...startTimes) : null,
    lastUpdate: updates.length > 0 ? Math.max(...updates) : null,
  }
}

function parseNumber(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

/**
 * Create a daemon status service
 */
export function createDaemonStatusService(db: Database): DaemonStatusService {
  const stmts = {
    get: db.query(`
      SELECT value FROM daemon_status WHERE key = $key
    `),

    set: db.prepare(`
      INSERT OR REPLACE INTO daemon_status (key, value, updated_at)
      VALUES ($key, $value, $now)
    `),

    delete: db.prepare(`
      DELETE FROM daemon_status WHERE key = $key
    `),

    getAll: db
      .query(`
      SELECT key, value FROM daemon_status
    `)
      .as(DaemonStatusRow),

    clear: db.prepare(`
      DELETE FROM daemon_status
    `),
  }

  const service: DaemonStatusService = {
    get(key: string): string | null {
      const result = stmts.get.get({ $key: key }) as {
        value: string | null
      } | null
      return result?.value ?? null
    },

    set(key: string, value: string): void {
      stmts.set.run({
        $key: key,
        $value: value,
        $now: Date.now(),
      })
    },

    delete(key: string): void {
      stmts.delete.run({ $key: key })
    },

    getAll(): Record<string, string> {
      const rows = stmts.getAll.all()
      const result: Record<string, string> = {}
      for (const row of rows) {
        if (row.value !== null) {
          result[row.key] = row.value
        }
      }
      return result
    },

    clear(): void {
      stmts.clear.run()
    },

    setDaemonRunning(pid: number, version: string): void {
      const now = Date.now()
      // One transaction, so a reader never sees the new daemon_pid without
      // its version. daemon_version_pid ties the version to this daemon: an
      // older one that starts later rewrites only daemon_pid.
      db.transaction(() => {
        service.set('daemon_version', version)
        service.set('daemon_version_pid', pid.toString())
        service.set('daemon_pid', pid.toString())
        service.set('daemon_started_at', now.toString())
        service.set('daemon_status', 'running')
        service.set('messages_synced', '0')
        // The previous run's connection and queue say nothing about this
        // one: the account is connecting until the daemon's first tick
        service.set('connection_status', 'connecting')
        service.delete('last_error')
        service.delete('pending_jobs')
        service.delete('running_jobs')
        service.set('last_update', now.toString())
      }).immediate()
    },

    setDaemonStopped(): void {
      db.transaction(() => {
        service.delete('daemon_pid')
        service.delete('daemon_started_at')
        service.delete('daemon_version')
        service.delete('daemon_version_pid')
        service.set('daemon_status', 'stopped')
        service.set('connection_status', 'disconnected')
      }).immediate()
    },

    isDaemonRunning(): boolean {
      return service.get('daemon_status') === 'running'
    },

    updateLastUpdate(): void {
      service.set('last_update', Date.now().toString())
    },

    setMessagesSynced(count: number): void {
      service.set('messages_synced', count.toString())
    },

    writeTick(tick: DaemonTick): void {
      db.transaction(() => {
        service.set('connection_status', tick.connectionStatus)
        if (tick.lastError === null) {
          service.delete('last_error')
        } else {
          service.set('last_error', tick.lastError)
        }
        service.set('messages_synced', String(tick.messagesSynced))
        service.set('pending_jobs', String(tick.pendingJobs))
        service.set('running_jobs', String(tick.runningJobs))
        service.set('last_update', Date.now().toString())
      }).immediate()
    },

    getDaemonInfo(): DaemonInfo {
      // One query reads every key from one snapshot (WAL), so a daemon that
      // is starting or stopping is never seen half written. The
      // connected_accounts and total_accounts rows of 0.3 are ignored.
      const values = service.getAll()
      const read = (key: string) => values[key] ?? null
      const pid = read('daemon_pid')
      return {
        status: read('daemon_status') === 'running' ? 'running' : 'stopped',
        pid: parseNumber(pid),
        // Only the daemon that wrote daemon_pid vouches for the version
        version:
          pid !== null && read('daemon_version_pid') === pid
            ? read('daemon_version')
            : null,
        startedAt: parseNumber(read('daemon_started_at')),
        lastUpdate: parseNumber(read('last_update')),
        connectionStatus: read('connection_status'),
        lastError: read('last_error'),
        messagesSynced: parseNumber(read('messages_synced')) ?? 0,
        pendingJobs: parseNumber(read('pending_jobs')) ?? 0,
        runningJobs: parseNumber(read('running_jobs')) ?? 0,
      }
    },
  }

  return service
}
