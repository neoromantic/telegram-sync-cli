/**
 * Tests for daemon status service
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createDaemonStatusService,
  type DaemonInfo,
  type DaemonStatusService,
  summarizeDaemonStatus,
} from '../db/daemon-status'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

describe('DaemonStatusService', () => {
  let db: Database
  let service: DaemonStatusService

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    service = createDaemonStatusService(db)
  })

  describe('set/get', () => {
    it('sets and gets a value', () => {
      service.set('daemon_pid', '12345')

      expect(service.get('daemon_pid')).toBe('12345')
    })

    it('returns null for non-existent key', () => {
      expect(service.get('nonexistent')).toBeNull()
    })

    it('overwrites existing value', () => {
      service.set('count', '1')
      service.set('count', '2')

      expect(service.get('count')).toBe('2')
    })

    it('stores and retrieves JSON values', () => {
      const data = { connected: 3, total: 5 }
      service.set('accounts', JSON.stringify(data))

      const retrieved = service.get('accounts')
      expect(JSON.parse(retrieved!)).toEqual(data)
    })
  })

  describe('delete', () => {
    it('deletes a key', () => {
      service.set('key', 'value')
      expect(service.get('key')).toBe('value')

      service.delete('key')
      expect(service.get('key')).toBeNull()
    })

    it('does nothing for non-existent key', () => {
      // Should not throw
      service.delete('nonexistent')
    })
  })

  describe('getAll', () => {
    it('returns all key-value pairs', () => {
      service.set('key1', 'value1')
      service.set('key2', 'value2')
      service.set('key3', 'value3')

      const all = service.getAll()
      expect(Object.keys(all)).toHaveLength(3)
      expect(all.key1).toBe('value1')
      expect(all.key2).toBe('value2')
      expect(all.key3).toBe('value3')
    })

    it('returns empty object when no values', () => {
      const all = service.getAll()
      expect(all).toEqual({})
    })
  })

  describe('clear', () => {
    it('removes all values', () => {
      service.set('key1', 'value1')
      service.set('key2', 'value2')

      service.clear()

      expect(service.getAll()).toEqual({})
    })
  })

  describe('convenience methods', () => {
    describe('setDaemonRunning', () => {
      it('sets daemon as running with PID and start time', () => {
        const pid = 12345
        service.setDaemonRunning(pid, '0.3.1')

        expect(service.get('daemon_pid')).toBe(pid.toString())
        expect(service.get('daemon_started_at')).not.toBeNull()
        expect(service.get('daemon_status')).toBe('running')
      })

      it("drops the previous run's connection and queue until the first tick", () => {
        // What a daemon that crashed left behind
        service.setDaemonRunning(1111, '0.4.0')
        service.writeTick({
          connectionStatus: 'connected',
          lastError: 'connection reset',
          messagesSynced: 40,
          pendingJobs: 7,
          runningJobs: 1,
        })
        db.run(
          "UPDATE daemon_status SET value = '1000' WHERE key = 'last_update'",
        )
        const before = Date.now()

        service.setDaemonRunning(2222, '0.4.0')

        expect(service.getDaemonInfo()).toMatchObject({
          status: 'running',
          pid: 2222,
          connectionStatus: 'connecting',
          lastError: null,
          messagesSynced: 0,
          pendingJobs: 0,
          runningJobs: 0,
        })
        expect(service.getDaemonInfo().lastUpdate).toBeGreaterThanOrEqual(
          before,
        )
        expect(service.get('pending_jobs')).toBeNull()
        expect(service.get('running_jobs')).toBeNull()
      })

      it('records the version, tied to the PID', () => {
        service.setDaemonRunning(111, '0.3.1')

        expect(service.get('daemon_version')).toBe('0.3.1')
        expect(service.get('daemon_version_pid')).toBe('111')
        expect(service.getDaemonInfo().version).toBe('0.3.1')
      })

      it('writes nothing if one of its keys fails to write', () => {
        // The last write fails: the version and PID before it must roll back,
        // so a reader never sees a half-started daemon
        db.run(
          "CREATE TRIGGER fail_start BEFORE INSERT ON daemon_status WHEN NEW.key = 'daemon_status' BEGIN SELECT RAISE(ABORT, 'boom'); END",
        )

        expect(() => service.setDaemonRunning(111, '0.3.1')).toThrow('boom')

        expect(service.get('daemon_version')).toBeNull()
        expect(service.get('daemon_version_pid')).toBeNull()
        expect(service.get('daemon_pid')).toBeNull()
      })
    })

    describe('setDaemonStopped', () => {
      it('clears daemon running state', () => {
        service.setDaemonRunning(12345, '0.3.1')

        service.setDaemonStopped()

        expect(service.get('daemon_pid')).toBeNull()
        expect(service.get('daemon_status')).toBe('stopped')
      })

      it('clears the version', () => {
        service.setDaemonRunning(111, '0.3.1')

        service.setDaemonStopped()

        expect(service.get('daemon_version')).toBeNull()
        expect(service.get('daemon_version_pid')).toBeNull()
        expect(service.getDaemonInfo().version).toBeNull()
      })

      it('keeps the running state if one of its keys fails to write', () => {
        service.setDaemonRunning(111, '0.3.1')
        // The final 'stopped' write fails: the deletes before it must roll back
        db.run(
          "CREATE TRIGGER fail_stop BEFORE INSERT ON daemon_status WHEN NEW.value = 'stopped' BEGIN SELECT RAISE(ABORT, 'boom'); END",
        )

        expect(() => service.setDaemonStopped()).toThrow('boom')

        expect(service.get('daemon_pid')).toBe('111')
        expect(service.get('daemon_version')).toBe('0.3.1')
        expect(service.get('daemon_version_pid')).toBe('111')
        expect(service.getDaemonInfo().version).toBe('0.3.1')
      })
    })

    describe('isDaemonRunning', () => {
      it('returns true when daemon is running', () => {
        service.setDaemonRunning(12345, '0.3.1')
        expect(service.isDaemonRunning()).toBe(true)
      })

      it('returns false when daemon is stopped', () => {
        expect(service.isDaemonRunning()).toBe(false)
      })
    })

    describe('writeTick', () => {
      it("writes the account's figures and last_update", () => {
        const before = Date.now()
        service.writeTick({
          connectionStatus: 'connected',
          lastError: null,
          messagesSynced: 42,
          pendingJobs: 3,
          runningJobs: 1,
        })

        expect(service.getAll()).toMatchObject({
          connection_status: 'connected',
          messages_synced: '42',
          pending_jobs: '3',
          running_jobs: '1',
        })
        expect(service.get('last_error')).toBeNull()
        expect(Number(service.get('last_update'))).toBeGreaterThanOrEqual(
          before,
        )
      })

      it('writes a tick in one transaction', () => {
        db.run(`
          CREATE TRIGGER fail_running_jobs BEFORE INSERT ON daemon_status
          WHEN NEW.key = 'running_jobs'
          BEGIN SELECT RAISE(ABORT, 'disk full'); END
        `)

        expect(() =>
          service.writeTick({
            connectionStatus: 'connected',
            lastError: null,
            messagesSynced: 42,
            pendingJobs: 3,
            runningJobs: 1,
          }),
        ).toThrow('disk full')
        expect(service.getAll()).toEqual({})
      })

      it('keeps the last error until a tick without one', () => {
        const tick = {
          connectionStatus: 'error',
          lastError: 'AUTH_KEY_UNREGISTERED',
          messagesSynced: 0,
          pendingJobs: 0,
          runningJobs: 0,
        }
        service.writeTick(tick)
        expect(service.getDaemonInfo()).toMatchObject({
          connectionStatus: 'error',
          lastError: 'AUTH_KEY_UNREGISTERED',
        })

        service.writeTick({
          ...tick,
          connectionStatus: 'connected',
          lastError: null,
        })
        expect(service.getDaemonInfo()).toMatchObject({
          connectionStatus: 'connected',
          lastError: null,
        })
      })

      it("writes the account's sync pace, and a start clears it (#133)", () => {
        const tick = {
          connectionStatus: 'connected',
          lastError: null,
          messagesSynced: 0,
          pendingJobs: 4,
          runningJobs: 1,
        }
        service.writeTick(tick)
        expect(service.getDaemonInfo().pacing).toBeNull()

        service.writeTick({
          ...tick,
          pacing: {
            mode: 'history',
            targetCallsPerSecond: 0.75,
            floodWaits: 2,
          },
        })
        expect(service.getDaemonInfo().pacing).toEqual({
          mode: 'history',
          targetCallsPerSecond: 0.75,
          floodWaits: 2,
        })

        service.setDaemonRunning(4242, '0.9.0')
        expect(service.getDaemonInfo().pacing).toBeNull()
      })
    })

    describe('updateLastUpdate', () => {
      it('updates last update timestamp', () => {
        const before = Date.now()
        service.updateLastUpdate()
        const after = Date.now()

        const timestamp = parseInt(service.get('last_update')!, 10)
        expect(timestamp).toBeGreaterThanOrEqual(before)
        expect(timestamp).toBeLessThanOrEqual(after)
      })
    })

    describe('setMessagesSynced', () => {
      it('sets total messages synced count', () => {
        service.setMessagesSynced(1000)
        expect(service.get('messages_synced')).toBe('1000')
      })
    })

    describe('getDaemonInfo', () => {
      it('returns all daemon info', () => {
        service.setDaemonRunning(12345, '0.3.1')
        service.setMessagesSynced(1000)
        service.set('connection_status', 'connected')
        service.set('pending_jobs', '4')

        const info = service.getDaemonInfo()
        expect(info.status).toBe('running')
        expect(info.pid).toBe(12345)
        expect(info.startedAt).not.toBeNull()
        expect(info.connectionStatus).toBe('connected')
        expect(info.messagesSynced).toBe(1000)
        expect(info.pendingJobs).toBe(4)
        expect(info.runningJobs).toBe(0)
      })

      it('ignores the account totals that 0.3 wrote', () => {
        service.set('connected_accounts', '3')
        service.set('total_accounts', '5')

        expect(service.getDaemonInfo()).not.toHaveProperty('connectedAccounts')
        expect(service.getDaemonInfo()).not.toHaveProperty('totalAccounts')
      })

      it('returns null values when daemon not running', () => {
        const info = service.getDaemonInfo()
        expect(info.status).toBe('stopped')
        expect(info.pid).toBeNull()
        expect(info.version).toBeNull()
      })

      it("ignores a version left by another PID's daemon", () => {
        // A daemon that recorded its version died without cleanup, then an
        // older daemon started: it writes only these three keys
        service.setDaemonRunning(111, '0.3.1')
        service.set('daemon_pid', '222')
        service.set('daemon_started_at', Date.now().toString())
        service.set('daemon_status', 'running')

        const info = service.getDaemonInfo()
        expect(info.pid).toBe(222)
        expect(info.version).toBeNull()
      })
    })
  })
})

describe('summarizeDaemonStatus', () => {
  const info = (overrides: Partial<DaemonInfo>): DaemonInfo => ({
    status: 'running',
    pid: 4242,
    version: '0.4.0',
    startedAt: 1_000,
    lastUpdate: 5_000,
    connectionStatus: 'connected',
    lastError: null,
    messagesSynced: 10,
    pendingJobs: 0,
    runningJobs: 0,
    lastCatchUp: null,
    pacing: null,
    ...overrides,
  })

  it('sums only the rows the live daemon wrote', () => {
    const summary = summarizeDaemonStatus(
      [
        info({ messagesSynced: 10, startedAt: 2_000, lastUpdate: 9_000 }),
        info({
          connectionStatus: 'reconnecting',
          messagesSynced: 5,
          startedAt: 1_500,
          lastUpdate: 8_000,
        }),
        // A daemon that died without marking itself stopped
        info({
          pid: 1111,
          version: '0.0.1',
          messagesSynced: 99,
          lastUpdate: 99_000,
        }),
        info({ status: 'stopped', pid: null, messagesSynced: 7 }),
      ],
      4242,
    )

    expect(summary).toEqual({
      connectedAccounts: 1,
      totalAccounts: 2,
      version: '0.4.0',
      messagesSynced: 15,
      startedAt: 1_500,
      lastUpdate: 9_000,
    })
  })

  it('counts nothing without a live daemon, but keeps its last update', () => {
    const stopped = (lastUpdate: number | null) =>
      info({
        status: 'stopped',
        pid: null,
        startedAt: null,
        connectionStatus: 'disconnected',
        lastUpdate,
      })

    expect(
      summarizeDaemonStatus(
        [stopped(7_000), stopped(9_500), stopped(null)],
        null,
      ),
    ).toEqual({
      connectedAccounts: 0,
      totalAccounts: 0,
      version: null,
      messagesSynced: 0,
      startedAt: null,
      lastUpdate: 9_500,
    })
  })
})
