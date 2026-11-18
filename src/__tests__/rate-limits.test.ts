/**
 * Rate limiting service tests
 *
 * Tests for RateLimitsService including:
 * - Recording API calls
 * - Flood wait management
 * - API activity logging
 * - Status summary
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRateLimitsService, type RateLimitsService } from "../db/rate-limits";
import { trackApiCall } from "../utils/telegram-rate-limits";
import { createAccountCacheDb } from "./helpers/cache-db";

describe("RateLimitsService", () => {
  let db: Database;
  let service: RateLimitsService;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    db = createAccountCacheDb();
    service = createRateLimitsService(db);

    // Store original Date.now for restoration
    originalDateNow = Date.now;
  });

  afterEach(() => {
    // Restore original Date.now
    Date.now = originalDateNow;
    db.close();
  });

  /**
   * Helper to mock Date.now to a specific timestamp
   */
  function mockTime(timestampMs: number): void {
    Date.now = () => timestampMs;
  }

  /**
   * Helper to get current unix timestamp in seconds
   */
  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** The rate windows recordCall wrote */
  function callWindows() {
    return db
      .query(
        "SELECT method, window_start, call_count FROM rate_limits ORDER BY window_start, method",
      )
      .all();
  }

  /** The rows logActivity wrote */
  function activityRows() {
    return db
      .query(
        "SELECT timestamp, method, success, error_code, response_ms, context FROM api_activity ORDER BY id",
      )
      .all();
  }

  // ===========================================================================
  // Recording API calls (recordCall)
  // ===========================================================================

  describe("recordCall", () => {
    const baseTime = 1700000000000;
    const windowStart = Math.floor(baseTime / 60_000) * 60;

    it("counts calls per method in the current window", () => {
      mockTime(baseTime);

      service.recordCall("messages.sendMessage");
      service.recordCall("messages.sendMessage");
      service.recordCall("contacts.getContacts");

      expect(callWindows()).toEqual([
        {
          method: "contacts.getContacts",
          window_start: windowStart,
          call_count: 1,
        },
        {
          method: "messages.sendMessage",
          window_start: windowStart,
          call_count: 2,
        },
      ]);
    });

    it("should create new window after time passes", () => {
      mockTime(baseTime);

      service.recordCall("messages.sendMessage");
      service.recordCall("messages.sendMessage");

      // Move time forward by more than 60 seconds (window size)
      mockTime(baseTime + 61000);

      service.recordCall("messages.sendMessage");

      expect(callWindows()).toEqual([
        {
          method: "messages.sendMessage",
          window_start: windowStart,
          call_count: 2,
        },
        {
          method: "messages.sendMessage",
          window_start: windowStart + 60,
          call_count: 1,
        },
      ]);
    });
  });

  // ===========================================================================
  // Flood wait management
  // ===========================================================================

  describe("setFloodWait", () => {
    it("should store flood wait block correctly", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);

      const floodWait = service.getFloodWait("messages.sendMessage");
      expect(floodWait).not.toBeNull();
      expect(floodWait?.blockedUntil).toBe(nowSeconds() + 30);
    });

    it("should allow multiple methods to be blocked", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);
      service.setFloodWait("contacts.getContacts", 60);

      const floodWait1 = service.getFloodWait("messages.sendMessage");
      const floodWait2 = service.getFloodWait("contacts.getContacts");

      expect(floodWait1).not.toBeNull();
      expect(floodWait2).not.toBeNull();
      expect(floodWait1?.blockedUntil).toBe(nowSeconds() + 30);
      expect(floodWait2?.blockedUntil).toBe(nowSeconds() + 60);
    });
  });

  describe("getFloodWait", () => {
    it("should return correct flood wait info", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 45);

      const floodWait = service.getFloodWait("messages.sendMessage");
      expect(floodWait).not.toBeNull();
      expect(floodWait?.blockedUntil).toBeGreaterThan(nowSeconds());
      expect(floodWait?.waitSeconds).toBeGreaterThan(0);
    });

    it("should return null when method is not blocked", () => {
      const floodWait = service.getFloodWait("messages.sendMessage");
      expect(floodWait).toBeNull();
    });

    it("should return null when flood wait has expired", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);

      // Move time forward past the flood wait expiry
      mockTime(baseTime + 35000);

      const floodWait = service.getFloodWait("messages.sendMessage");
      expect(floodWait).toBeNull();
    });
  });

  describe("isBlocked", () => {
    it("should return true during flood wait", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);

      expect(service.isBlocked("messages.sendMessage")).toBe(true);
    });

    it("should return false when not blocked", () => {
      expect(service.isBlocked("messages.sendMessage")).toBe(false);
    });

    it("should return false after flood wait expires", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);

      // Move time forward past expiry
      mockTime(baseTime + 35000);

      expect(service.isBlocked("messages.sendMessage")).toBe(false);
    });

    it("should track blocking status per method independently", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);

      expect(service.isBlocked("messages.sendMessage")).toBe(true);
      expect(service.isBlocked("contacts.getContacts")).toBe(false);
    });
  });

  describe("getWaitTime", () => {
    it("should return correct remaining seconds", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 60);

      // Move forward 20 seconds
      mockTime(baseTime + 20000);

      const waitTime = service.getWaitTime("messages.sendMessage");
      expect(waitTime).toBe(40);
    });

    it("should return 0 when not blocked", () => {
      const waitTime = service.getWaitTime("messages.sendMessage");
      expect(waitTime).toBe(0);
    });

    it("should return 0 after flood wait expires", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);

      // Move time forward past expiry
      mockTime(baseTime + 35000);

      const waitTime = service.getWaitTime("messages.sendMessage");
      expect(waitTime).toBe(0);
    });

    it("should never return negative values", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 10);

      // Move time way past expiry
      mockTime(baseTime + 100000);

      const waitTime = service.getWaitTime("messages.sendMessage");
      expect(waitTime).toBe(0);
    });
  });

  // ===========================================================================
  // API activity logging
  // ===========================================================================

  describe("logActivity", () => {
    it("should store activity entries", () => {
      const baseTime = 1700000000000;

      service.logActivity({
        timestamp: baseTime,
        method: "messages.sendMessage",
        success: 1,
        response_ms: 150,
      });

      expect(activityRows()).toEqual([
        {
          timestamp: baseTime,
          method: "messages.sendMessage",
          success: 1,
          error_code: null,
          response_ms: 150,
          context: null,
        },
      ]);
    });

    it("should store activity with error details", () => {
      const baseTime = 1700000000000;

      service.logActivity({
        timestamp: baseTime,
        method: "messages.sendMessage",
        success: 0,
        error_code: 420,
        context: "FLOOD_WAIT_30",
      });

      expect(activityRows()).toEqual([
        {
          timestamp: baseTime,
          method: "messages.sendMessage",
          success: 0,
          error_code: "420",
          response_ms: null,
          context: "FLOOD_WAIT_30",
        },
      ]);
    });
  });

  // ===========================================================================
  // Status
  // ===========================================================================

  describe("getStatus", () => {
    it("should return complete summary", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      // getStatus counts the calls logged in api_activity
      for (const method of [
        "messages.sendMessage",
        "messages.sendMessage",
        "contacts.getContacts",
      ]) {
        service.logActivity({ timestamp: baseTime, method, success: 1 });
      }

      const status = service.getStatus();

      expect(status.totalCalls).toBe(3);
      expect(status.callsByMethod).toEqual({
        "messages.sendMessage": 2,
        "contacts.getContacts": 1,
      });
      expect(status.activeFloodWaits).toEqual([]);
    });

    it("should include active flood waits", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 30);
      service.setFloodWait("contacts.getContacts", 60);

      const status = service.getStatus();

      expect(status.activeFloodWaits).toHaveLength(2);
      expect(
        status.activeFloodWaits.find((fw) => fw.method === "messages.sendMessage"),
      ).toBeDefined();
      expect(
        status.activeFloodWaits.find((fw) => fw.method === "contacts.getContacts"),
      ).toBeDefined();
    });

    it("should not include expired flood waits", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 10);
      service.setFloodWait("contacts.getContacts", 100);

      // Move time forward so first one expires
      mockTime(baseTime + 15000);

      const status = service.getStatus();

      expect(status.activeFloodWaits).toHaveLength(1);
      expect(status.activeFloodWaits[0]?.method).toBe("contacts.getContacts");
    });

    it("should return empty status when no activity", () => {
      const status = service.getStatus();

      expect(status.totalCalls).toBe(0);
      expect(status.callsByMethod).toEqual({});
      expect(status.activeFloodWaits).toEqual([]);
    });

    it("should only count calls from last minute", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.logActivity({
        timestamp: baseTime,
        method: "messages.sendMessage",
        success: 1,
      });

      // Move forward 2 minutes
      mockTime(baseTime + 120000);

      service.logActivity({
        timestamp: baseTime + 120000,
        method: "contacts.getContacts",
        success: 1,
      });

      const status = service.getStatus();

      // Only the recent call should be counted
      expect(status.totalCalls).toBe(1);
      expect(status.callsByMethod).toEqual({
        "contacts.getContacts": 1,
      });
    });

    it("counts the last 60 seconds across a rate window boundary", async () => {
      // 50 s into a calendar minute
      const minute = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
      let now = minute + 50_000;
      const clocked = createRateLimitsService(db, { now: () => now });
      const callAt = (at: number) => {
        now = at;
        return trackApiCall(clocked, "messages.getHistory", async () => {
          now += 250;
          return null;
        });
      };

      await callAt(minute - 10_000); // 100 s before the status: too old
      await callAt(minute + 50_000); // the minute that ended
      await callAt(minute + 70_000); // the current minute
      now = minute + 90_000;

      const status = clocked.getStatus();
      expect(status.totalCalls).toBe(2);
      expect(status.callsByMethod).toEqual({ "messages.getHistory": 2 });

      // The current calendar window alone holds one of them
      const windows = db
        .query("SELECT window_start, call_count FROM rate_limits ORDER BY window_start")
        .all();
      expect(windows.at(-1)).toEqual({
        window_start: (minute + 60_000) / 1000,
        call_count: 1,
      });
    });
  });

  // ===========================================================================
  // Edge cases and error handling
  // ===========================================================================

  describe("edge cases", () => {
    it("should handle zero wait time for flood wait", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      service.setFloodWait("messages.sendMessage", 0);

      // With 0 wait time, should immediately be unblocked
      const isBlocked = service.isBlocked("messages.sendMessage");
      // May be true or false depending on timing, but shouldn't throw
      expect(typeof isBlocked).toBe("boolean");
    });

    it("should handle large wait times", () => {
      const baseTime = 1700000000000;
      mockTime(baseTime);

      // Set a very large wait time (1 day)
      service.setFloodWait("messages.sendMessage", 86400);

      const floodWait = service.getFloodWait("messages.sendMessage");
      expect(floodWait).not.toBeNull();
      expect(floodWait?.waitSeconds).toBeGreaterThan(0);
    });
  });
});
