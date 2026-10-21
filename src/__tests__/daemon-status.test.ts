/**
 * Tests for daemon status service
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  createDaemonStatusService,
  type DaemonStatusService,
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

      it('records the version, tied to the PID', () => {
        service.setDaemonRunning(111, '0.3.1')

        expect(service.get('daemon_version')).toBe('0.3.1')
        expect(service.get('daemon_version_pid')).toBe('111')
        expect(service.getDaemonInfo().version).toBe('0.3.1')
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

    describe('setConnectedAccounts', () => {
      it('sets connected accounts count', () => {
        service.setConnectedAccounts(3, 5)

        expect(service.get('connected_accounts')).toBe('3')
        expect(service.get('total_accounts')).toBe('5')
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
        service.setConnectedAccounts(3, 5)
        service.setMessagesSynced(1000)

        const info = service.getDaemonInfo()
        expect(info.status).toBe('running')
        expect(info.pid).toBe(12345)
        expect(info.startedAt).not.toBeNull()
        expect(info.connectedAccounts).toBe(3)
        expect(info.totalAccounts).toBe(5)
        expect(info.messagesSynced).toBe(1000)
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
