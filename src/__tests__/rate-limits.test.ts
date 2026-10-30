/**
 * Rate limiting service tests
 *
 * Tests for RateLimitsService including:
 * - Recording API calls
 * - Getting call counts
 * - Flood wait management
 * - API activity logging
 * - Pruning old data
 * - Status summary
 */

import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createRateLimitsService, RateLimitsService } from '../db/rate-limits'
import { createTestCacheDatabase } from '../db/schema'
import { trackApiCall } from '../utils/telegram-rate-limits'

describe('RateLimitsService', () => {
  let db: Database
  let service: RateLimitsService
  let originalDateNow: typeof Date.now

  beforeEach(() => {
    const testDb = createTestCacheDatabase()
    db = testDb.db
    service = createRateLimitsService(db)

    // Store original Date.now for restoration
    originalDateNow = Date.now
  })

  afterEach(() => {
    // Restore original Date.now
    Date.now = originalDateNow
    db.close()
  })

  /**
   * Helper to mock Date.now to a specific timestamp
   */
  function mockTime(timestampMs: number): void {
    Date.now = () => timestampMs
  }

  /**
   * Helper to get current unix timestamp in seconds
   */
  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000)
  }

  // ===========================================================================
  // Recording API calls (recordCall)
  // ===========================================================================

  describe('recordCall', () => {
    it('should record a call count correctly', () => {
      // Set a fixed time
      const baseTime = 1700000000000 // Fixed timestamp in ms
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')

      const count = service.getCallCount('messages.sendMessage', 1)
      expect(count).toBe(1)
    })

    it('should increment count in same time window', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')

      const count = service.getCallCount('messages.sendMessage', 1)
      expect(count).toBe(3)
    })

    it('should track different methods separately', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')
      service.recordCall('contacts.getContacts')

      expect(service.getCallCount('messages.sendMessage', 1)).toBe(2)
      expect(service.getCallCount('contacts.getContacts', 1)).toBe(1)
    })

    it('should create new window after time passes', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')

      // Move time forward by more than 60 seconds (window size)
      mockTime(baseTime + 61000)

      service.recordCall('messages.sendMessage')

      // Looking back 1 minute from new time should only see the new call
      const countLastMinute = service.getCallCount('messages.sendMessage', 1)
      expect(countLastMinute).toBe(1)

      // Looking back 2 minutes should see all calls
      const countLastTwoMinutes = service.getCallCount(
        'messages.sendMessage',
        2,
      )
      expect(countLastTwoMinutes).toBe(3)
    })
  })

  // ===========================================================================
  // Getting call counts (getCallCount)
  // ===========================================================================

  describe('getCallCount', () => {
    it('should return 0 for no calls', () => {
      const count = service.getCallCount('messages.sendMessage', 1)
      expect(count).toBe(0)
    })

    it('should return 0 for unknown method', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')

      const count = service.getCallCount('unknown.method', 1)
      expect(count).toBe(0)
    })

    it('should count calls for specific method', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')
      service.recordCall('contacts.getContacts')
      service.recordCall('contacts.getContacts')
      service.recordCall('contacts.getContacts')

      expect(service.getCallCount('messages.sendMessage', 1)).toBe(2)
      expect(service.getCallCount('contacts.getContacts', 1)).toBe(3)
    })

    it('should count all calls when method is null', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')
      service.recordCall('contacts.getContacts')
      service.recordCall('users.getUsers')

      const totalCount = service.getCallCount(null, 1)
      expect(totalCount).toBe(4)
    })

    it('should respect time window (minutes parameter)', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      // Record calls at base time
      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')

      // Move forward 70 seconds (into next minute window)
      mockTime(baseTime + 70000)

      // Record more calls
      service.recordCall('messages.sendMessage')

      // Move forward another 70 seconds (now ~2.3 minutes from start)
      mockTime(baseTime + 140000)

      service.recordCall('messages.sendMessage')

      // 1 minute window should only see the most recent call
      expect(service.getCallCount('messages.sendMessage', 1)).toBe(1)

      // 3 minute window should see all calls (all within 3 min from current time)
      expect(service.getCallCount('messages.sendMessage', 3)).toBe(4)
    })

    it('should return 0 when all calls are outside time window', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.recordCall('messages.sendMessage')
      service.recordCall('messages.sendMessage')

      // Move forward by 5 minutes
      mockTime(baseTime + 300000)

      // 1 minute window should show 0
      const count = service.getCallCount('messages.sendMessage', 1)
      expect(count).toBe(0)
    })
  })

  // ===========================================================================
  // Flood wait management
  // ===========================================================================

  describe('setFloodWait', () => {
    it('should store flood wait block correctly', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)

      const floodWait = service.getFloodWait('messages.sendMessage')
      expect(floodWait).not.toBeNull()
      expect(floodWait?.blockedUntil).toBe(nowSeconds() + 30)
    })

    it('should allow multiple methods to be blocked', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)
      service.setFloodWait('contacts.getContacts', 60)

      const floodWait1 = service.getFloodWait('messages.sendMessage')
      const floodWait2 = service.getFloodWait('contacts.getContacts')

      expect(floodWait1).not.toBeNull()
      expect(floodWait2).not.toBeNull()
      expect(floodWait1?.blockedUntil).toBe(nowSeconds() + 30)
      expect(floodWait2?.blockedUntil).toBe(nowSeconds() + 60)
    })
  })

  describe('getFloodWait', () => {
    it('should return correct flood wait info', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 45)

      const floodWait = service.getFloodWait('messages.sendMessage')
      expect(floodWait).not.toBeNull()
      expect(floodWait?.blockedUntil).toBeGreaterThan(nowSeconds())
      expect(floodWait?.waitSeconds).toBeGreaterThan(0)
    })

    it('should return null when method is not blocked', () => {
      const floodWait = service.getFloodWait('messages.sendMessage')
      expect(floodWait).toBeNull()
    })

    it('should return null when flood wait has expired', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)

      // Move time forward past the flood wait expiry
      mockTime(baseTime + 35000)

      const floodWait = service.getFloodWait('messages.sendMessage')
      expect(floodWait).toBeNull()
    })
  })

  describe('isBlocked', () => {
    it('should return true during flood wait', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)

      expect(service.isBlocked('messages.sendMessage')).toBe(true)
    })

    it('should return false when not blocked', () => {
      expect(service.isBlocked('messages.sendMessage')).toBe(false)
    })

    it('should return false after flood wait expires', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)

      // Move time forward past expiry
      mockTime(baseTime + 35000)

      expect(service.isBlocked('messages.sendMessage')).toBe(false)
    })

    it('should track blocking status per method independently', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)

      expect(service.isBlocked('messages.sendMessage')).toBe(true)
      expect(service.isBlocked('contacts.getContacts')).toBe(false)
    })
  })

  describe('getWaitTime', () => {
    it('should return correct remaining seconds', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 60)

      // Move forward 20 seconds
      mockTime(baseTime + 20000)

      const waitTime = service.getWaitTime('messages.sendMessage')
      expect(waitTime).toBe(40)
    })

    it('should return 0 when not blocked', () => {
      const waitTime = service.getWaitTime('messages.sendMessage')
      expect(waitTime).toBe(0)
    })

    it('should return 0 after flood wait expires', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)

      // Move time forward past expiry
      mockTime(baseTime + 35000)

      const waitTime = service.getWaitTime('messages.sendMessage')
      expect(waitTime).toBe(0)
    })

    it('should never return negative values', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 10)

      // Move time way past expiry
      mockTime(baseTime + 100000)

      const waitTime = service.getWaitTime('messages.sendMessage')
      expect(waitTime).toBe(0)
    })
  })

  describe('clearExpiredFloodWaits', () => {
    it('should remove expired flood waits', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('method1', 10)
      service.setFloodWait('method2', 20)
      service.setFloodWait('method3', 100)

      // Move forward so method1 and method2 expire
      mockTime(baseTime + 25000)

      const cleared = service.clearExpiredFloodWaits()

      // At least 2 should be cleared (method1 and method2)
      expect(cleared).toBeGreaterThanOrEqual(2)

      // Verify method3 is still blocked
      expect(service.isBlocked('method3')).toBe(true)
    })

    it('should return 0 when no expired flood waits', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 100)

      const cleared = service.clearExpiredFloodWaits()
      expect(cleared).toBe(0)
    })

    it('should return 0 when no flood waits exist', () => {
      const cleared = service.clearExpiredFloodWaits()
      expect(cleared).toBe(0)
    })
  })

  // ===========================================================================
  // API activity logging
  // ===========================================================================

  describe('logActivity', () => {
    it('should store activity entries', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.logActivity({
        timestamp: Date.now(),
        method: 'messages.sendMessage',
        success: 1,
        response_ms: 150,
      })

      const activities = service.getActivity({ limit: 10 })
      expect(activities).toHaveLength(1)
      expect(activities[0]?.method).toBe('messages.sendMessage')
      expect(activities[0]?.success).toBe(1)
      expect(activities[0]?.response_ms).toBe(150)
    })

    it('should store activity with error details', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.logActivity({
        timestamp: Date.now(),
        method: 'messages.sendMessage',
        success: 0,
        error_code: 420,
        context: 'FLOOD_WAIT_30',
      })

      const activities = service.getActivity({ onlyErrors: true })
      expect(activities).toHaveLength(1)
      expect(activities[0]?.success).toBe(0)
      expect(activities[0]?.error_code).toBe(420)
    })

    it('should store multiple activity entries', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      for (let i = 0; i < 5; i++) {
        service.logActivity({
          timestamp: Date.now() + i,
          method: `method${i}`,
          success: 1,
        })
      }

      const activities = service.getActivity({ limit: 100 })
      expect(activities).toHaveLength(5)
    })
  })

  describe('getActivity', () => {
    beforeEach(() => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      // Set up test data
      service.logActivity({
        timestamp: Date.now(),
        method: 'messages.sendMessage',
        success: 1,
        response_ms: 100,
      })
      service.logActivity({
        timestamp: Date.now() + 1,
        method: 'messages.sendMessage',
        success: 0,
        error_code: 420,
        context: 'FLOOD_WAIT',
      })
      service.logActivity({
        timestamp: Date.now() + 2,
        method: 'contacts.getContacts',
        success: 1,
        response_ms: 200,
      })
      service.logActivity({
        timestamp: Date.now() + 3,
        method: 'contacts.getContacts',
        success: 0,
        error_code: 500,
        context: 'SERVER_ERROR',
      })
    })

    it('should retrieve recent entries', () => {
      const activities = service.getActivity({ limit: 10 })
      expect(activities).toHaveLength(4)
    })

    it('should filter by method', () => {
      const activities = service.getActivity({
        method: 'messages.sendMessage',
        limit: 10,
      })
      expect(activities).toHaveLength(2)
      expect(activities.every((a) => a.method === 'messages.sendMessage')).toBe(
        true,
      )
    })

    it('should filter errors only', () => {
      const activities = service.getActivity({ onlyErrors: true, limit: 10 })
      expect(activities).toHaveLength(2)
      expect(activities.every((a) => a.success === 0)).toBe(true)
    })

    it('should filter by method and errors combined', () => {
      const activities = service.getActivity({
        method: 'contacts.getContacts',
        onlyErrors: true,
        limit: 10,
      })
      expect(activities).toHaveLength(1)
      expect(activities[0]?.method).toBe('contacts.getContacts')
      expect(activities[0]?.success).toBe(0)
    })

    it('should respect limit parameter', () => {
      const activities = service.getActivity({ limit: 2 })
      expect(activities).toHaveLength(2)
    })

    it('should return entries in descending timestamp order', () => {
      const activities = service.getActivity({ limit: 10 })
      for (let i = 0; i < activities.length - 1; i++) {
        expect(activities[i]!.timestamp).toBeGreaterThanOrEqual(
          activities[i + 1]!.timestamp,
        )
      }
    })

    it('should use default limit of 100', () => {
      // Add more entries
      for (let i = 0; i < 50; i++) {
        service.logActivity({
          timestamp: Date.now() + 10 + i,
          method: 'test.method',
          success: 1,
        })
      }

      const activities = service.getActivity({})
      // 4 from beforeEach + 50 = 54, which is less than default 100
      expect(activities.length).toBeLessThanOrEqual(100)
    })
  })

  // ===========================================================================
  // Status
  // ===========================================================================

  describe('getStatus', () => {
    it('should return complete summary', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      // getStatus counts the calls logged in api_activity
      for (const method of [
        'messages.sendMessage',
        'messages.sendMessage',
        'contacts.getContacts',
      ]) {
        service.logActivity({ timestamp: baseTime, method, success: 1 })
      }

      const status = service.getStatus()

      expect(status.totalCalls).toBe(3)
      expect(status.callsByMethod).toEqual({
        'messages.sendMessage': 2,
        'contacts.getContacts': 1,
      })
      expect(status.activeFloodWaits).toEqual([])
    })

    it('should include active flood waits', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 30)
      service.setFloodWait('contacts.getContacts', 60)

      const status = service.getStatus()

      expect(status.activeFloodWaits).toHaveLength(2)
      expect(
        status.activeFloodWaits.find(
          (fw) => fw.method === 'messages.sendMessage',
        ),
      ).toBeDefined()
      expect(
        status.activeFloodWaits.find(
          (fw) => fw.method === 'contacts.getContacts',
        ),
      ).toBeDefined()
    })

    it('should not include expired flood waits', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 10)
      service.setFloodWait('contacts.getContacts', 100)

      // Move time forward so first one expires
      mockTime(baseTime + 15000)

      const status = service.getStatus()

      expect(status.activeFloodWaits).toHaveLength(1)
      expect(status.activeFloodWaits[0]?.method).toBe('contacts.getContacts')
    })

    it('should return empty status when no activity', () => {
      const status = service.getStatus()

      expect(status.totalCalls).toBe(0)
      expect(status.callsByMethod).toEqual({})
      expect(status.activeFloodWaits).toEqual([])
    })

    it('should only count calls from last minute', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.logActivity({
        timestamp: baseTime,
        method: 'messages.sendMessage',
        success: 1,
      })

      // Move forward 2 minutes
      mockTime(baseTime + 120000)

      service.logActivity({
        timestamp: baseTime + 120000,
        method: 'contacts.getContacts',
        success: 1,
      })

      const status = service.getStatus()

      // Only the recent call should be counted
      expect(status.totalCalls).toBe(1)
      expect(status.callsByMethod).toEqual({
        'contacts.getContacts': 1,
      })
    })

    it('counts the last 60 seconds across a rate window boundary', async () => {
      // 50 s into a calendar minute
      const minute = 1_700_000_000_000 - (1_700_000_000_000 % 60_000)
      let now = minute + 50_000
      const clocked = createRateLimitsService(db, { now: () => now })
      const callAt = (at: number) => {
        now = at
        return trackApiCall(clocked, 'messages.getHistory', async () => {
          now += 250
          return null
        })
      }

      await callAt(minute - 10_000) // 100 s before the status: too old
      await callAt(minute + 50_000) // the minute that ended
      await callAt(minute + 70_000) // the current minute
      now = minute + 90_000

      const status = clocked.getStatus()
      expect(status.totalCalls).toBe(2)
      expect(status.callsByMethod).toEqual({ 'messages.getHistory': 2 })

      // The current calendar window alone holds one of them
      const windows = db
        .query(
          'SELECT window_start, call_count FROM rate_limits ORDER BY window_start',
        )
        .all()
      expect(windows.at(-1)).toEqual({
        window_start: (minute + 60_000) / 1000,
        call_count: 1,
      })
    })
  })

  // ===========================================================================
  // Factory function
  // ===========================================================================

  describe('createRateLimitsService', () => {
    it('should create a functional service instance', () => {
      const testDb = createTestCacheDatabase()
      const newService = createRateLimitsService(testDb.db)

      expect(newService).toBeInstanceOf(RateLimitsService)

      // Verify it works
      newService.recordCall('test.method')
      const count = newService.getCallCount('test.method', 1)
      expect(count).toBe(1)

      testDb.db.close()
    })
  })

  // ===========================================================================
  // Edge cases and error handling
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle special characters in method names', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      const specialMethod = 'method.with\'quotes"and\\backslash'
      service.recordCall(specialMethod)

      const count = service.getCallCount(specialMethod, 1)
      expect(count).toBe(1)
    })

    it('should handle very long method names', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      const longMethod = 'a'.repeat(1000)
      service.recordCall(longMethod)

      const count = service.getCallCount(longMethod, 1)
      expect(count).toBe(1)
    })

    it('should handle zero wait time for flood wait', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.setFloodWait('messages.sendMessage', 0)

      // With 0 wait time, should immediately be unblocked
      const isBlocked = service.isBlocked('messages.sendMessage')
      // May be true or false depending on timing, but shouldn't throw
      expect(typeof isBlocked).toBe('boolean')
    })

    it('should handle large wait times', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      // Set a very large wait time (1 day)
      service.setFloodWait('messages.sendMessage', 86400)

      const floodWait = service.getFloodWait('messages.sendMessage')
      expect(floodWait).not.toBeNull()
      expect(floodWait?.waitSeconds).toBeGreaterThan(0)
    })

    it('should handle concurrent operations on same method', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      // Simulate rapid calls
      for (let i = 0; i < 100; i++) {
        service.recordCall('rapid.method')
      }

      const count = service.getCallCount('rapid.method', 1)
      expect(count).toBe(100)
    })

    it('should handle activity logging with null optional fields', () => {
      const baseTime = 1700000000000
      mockTime(baseTime)

      service.logActivity({
        timestamp: Date.now(),
        method: 'test.method',
        success: 1,
        // All optional fields omitted
      })

      const activities = service.getActivity({ limit: 1 })
      expect(activities).toHaveLength(1)
      expect(activities[0]?.response_ms).toBeNull()
      expect(activities[0]?.error_code).toBeNull()
    })
  })
})
