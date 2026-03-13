/**
 * Daemon status service
 * Key-value store for daemon state tracking
 */
import type { Database } from 'bun:sqlite'
import { DaemonStatusRow } from './sync-schema'

/**
 * Daemon info structure
 */
export interface DaemonInfo {
  status: 'running' | 'stopped'
  pid: number | null
  startedAt: number | null
  lastUpdate: number | null
  connectedAccounts: number
  totalAccounts: number
  messagesSynced: number
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
  /** Mark daemon as running with given PID */
  setDaemonRunning(pid: number): void
  /** Mark daemon as stopped */
  setDaemonStopped(): void
  /** Check if daemon is running */
  isDaemonRunning(): boolean
  /** Update connected accounts count */
  setConnectedAccounts(connected: number, total: number): void
  /** Update last update timestamp */
  updateLastUpdate(): void
  /** Set total messages synced */
  setMessagesSynced(count: number): void
  /** Get all daemon info */
  getDaemonInfo(): DaemonInfo
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

    setDaemonRunning(pid: number): void {
      const now = Date.now()
      service.set('daemon_pid', pid.toString())
      service.set('daemon_started_at', now.toString())
      service.set('daemon_status', 'running')
    },

    setDaemonStopped(): void {
      service.delete('daemon_pid')
      service.delete('daemon_started_at')
      service.set('daemon_status', 'stopped')
    },

    isDaemonRunning(): boolean {
      return service.get('daemon_status') === 'running'
    },

    setConnectedAccounts(connected: number, total: number): void {
      service.set('connected_accounts', connected.toString())
      service.set('total_accounts', total.toString())
    },

    updateLastUpdate(): void {
      service.set('last_update', Date.now().toString())
    },

    setMessagesSynced(count: number): void {
      service.set('messages_synced', count.toString())
    },

    getDaemonInfo(): DaemonInfo {
      const pidStr = service.get('daemon_pid')
      const startedAtStr = service.get('daemon_started_at')
      const lastUpdateStr = service.get('last_update')
      const connectedStr = service.get('connected_accounts')
      const totalStr = service.get('total_accounts')
      const syncedStr = service.get('messages_synced')

      return {
        status:
          service.get('daemon_status') === 'running' ? 'running' : 'stopped',
        pid: pidStr ? parseInt(pidStr, 10) : null,
        startedAt: startedAtStr ? parseInt(startedAtStr, 10) : null,
        lastUpdate: lastUpdateStr ? parseInt(lastUpdateStr, 10) : null,
        connectedAccounts: connectedStr ? parseInt(connectedStr, 10) : 0,
        totalAccounts: totalStr ? parseInt(totalStr, 10) : 0,
        messagesSynced: syncedStr ? parseInt(syncedStr, 10) : 0,
      }
    },
  }

  return service
}
