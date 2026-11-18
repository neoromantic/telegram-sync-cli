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

    expect(calculateReconnectDelay(1, config)).toBe(1000);
    expect(calculateReconnectDelay(2, config)).toBe(2000);
    expect(calculateReconnectDelay(3, config)).toBe(4000);
    expect(calculateReconnectDelay(4, config)).toBe(8000);
    expect(calculateReconnectDelay(5, config)).toBe(16000);
  });

  it("caps delay at maxDelayMs", () => {
    const config: ReconnectConfig = {
      initialDelayMs: 1000,
      maxDelayMs: 5000,
      maxAttempts: 10,
      backoffMultiplier: 2,
    };

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
      backoffMultiplier: 3,
    };

    expect(calculateReconnectDelay(1, config)).toBe(1000);
    expect(calculateReconnectDelay(2, config)).toBe(3000);
    expect(calculateReconnectDelay(3, config)).toBe(9000);
    expect(calculateReconnectDelay(4, config)).toBe(27000);
  });

  it("works with default config values (5s initial, 5min max)", () => {
    expect(calculateReconnectDelay(1)).toBe(5000);
    expect(calculateReconnectDelay(2)).toBe(10000);
    expect(calculateReconnectDelay(3)).toBe(20000);
    expect(calculateReconnectDelay(4)).toBe(40000);
    expect(calculateReconnectDelay(5)).toBe(80000);
    expect(calculateReconnectDelay(6)).toBe(160000);
    expect(calculateReconnectDelay(7)).toBe(300000);
    expect(calculateReconnectDelay(8)).toBe(300000);
  });
});

describe("DEFAULT_RECONNECT_CONFIG", () => {
  it("has sensible default values", () => {
    expect(DEFAULT_RECONNECT_CONFIG.initialDelayMs).toBe(5000);
    expect(DEFAULT_RECONNECT_CONFIG.maxDelayMs).toBe(300000);
    expect(DEFAULT_RECONNECT_CONFIG.maxAttempts).toBe(10);
    expect(DEFAULT_RECONNECT_CONFIG.backoffMultiplier).toBe(2);
  });
});
