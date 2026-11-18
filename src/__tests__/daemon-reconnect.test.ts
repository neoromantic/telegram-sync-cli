/**
 * Tests for daemon reconnection logic
 */
import { describe, expect, it } from "bun:test";
import { calculateReconnectDelay } from "../daemon/daemon";
import { DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from "../daemon/types";

describe("calculateReconnectDelay", () => {
  it("returns initial delay for first attempt", () => {
    const delay = calculateReconnectDelay(1);
    expect(delay).toBe(DEFAULT_RECONNECT_CONFIG.initialDelayMs);
  });

  it("doubles delay for each subsequent attempt (exponential backoff)", () => {
    const config: ReconnectConfig = {
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      maxAttempts: 10,
      backoffMultiplier: 2,
    };

    expect(calculateReconnectDelay(1, config)).toBe(1000); // 1000 * 2^0
    expect(calculateReconnectDelay(2, config)).toBe(2000); // 1000 * 2^1
    expect(calculateReconnectDelay(3, config)).toBe(4000); // 1000 * 2^2
    expect(calculateReconnectDelay(4, config)).toBe(8000); // 1000 * 2^3
    expect(calculateReconnectDelay(5, config)).toBe(16000); // 1000 * 2^4
  });

  it("caps delay at maxDelayMs", () => {
    const config: ReconnectConfig = {
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      maxAttempts: 10,
      backoffMultiplier: 2,
    };

    // 1000 * 2^3 = 8000, but should be capped at 5000
    expect(calculateReconnectDelay(4, config)).toBe(5000);
    expect(calculateReconnectDelay(5, config)).toBe(5000);
    expect(calculateReconnectDelay(10, config)).toBe(5000);
  });

  it("uses default config when not provided", () => {
    const delay1 = calculateReconnectDelay(1);
    const delay2 = calculateReconnectDelay(2);

    expect(delay1).toBe(DEFAULT_RECONNECT_CONFIG.initialDelayMs);
    expect(delay2).toBe(
      DEFAULT_RECONNECT_CONFIG.initialDelayMs * DEFAULT_RECONNECT_CONFIG.backoffMultiplier,
    );
  });

  it("respects custom backoff multiplier", () => {
    const config: ReconnectConfig = {
      initialDelayMs: 1000,
      maxDelayMs: 100000,
      maxAttempts: 10,
      backoffMultiplier: 3, // Triple instead of double
    };

    expect(calculateReconnectDelay(1, config)).toBe(1000); // 1000 * 3^0
    expect(calculateReconnectDelay(2, config)).toBe(3000); // 1000 * 3^1
    expect(calculateReconnectDelay(3, config)).toBe(9000); // 1000 * 3^2
    expect(calculateReconnectDelay(4, config)).toBe(27000); // 1000 * 3^3
  });

  it("works with default config values (5s initial, 5min max)", () => {
    // Verify default config produces expected delays
    // Default: 5000ms initial, 300000ms max, multiplier 2

    expect(calculateReconnectDelay(1)).toBe(5000); // 5s
    expect(calculateReconnectDelay(2)).toBe(10000); // 10s
    expect(calculateReconnectDelay(3)).toBe(20000); // 20s
    expect(calculateReconnectDelay(4)).toBe(40000); // 40s
    expect(calculateReconnectDelay(5)).toBe(80000); // 80s
    expect(calculateReconnectDelay(6)).toBe(160000); // 160s
    expect(calculateReconnectDelay(7)).toBe(300000); // capped at 5min
    expect(calculateReconnectDelay(8)).toBe(300000); // still capped
  });
});

describe("DEFAULT_RECONNECT_CONFIG", () => {
  it("has sensible default values", () => {
    expect(DEFAULT_RECONNECT_CONFIG.initialDelayMs).toBe(5000); // 5 seconds
    expect(DEFAULT_RECONNECT_CONFIG.maxDelayMs).toBe(300000); // 5 minutes
    expect(DEFAULT_RECONNECT_CONFIG.maxAttempts).toBe(10);
    expect(DEFAULT_RECONNECT_CONFIG.backoffMultiplier).toBe(2);
  });
});
