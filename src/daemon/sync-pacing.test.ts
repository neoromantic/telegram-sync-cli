import { describe, expect, it } from "bun:test";
import { createSyncPacer, PACING_CLEAN_RUN_CALLS, type SyncPacer } from "./sync-pacing";

const T0 = 1_760_000_000_000;

function runClean(pacer: SyncPacer, calls: number, start = T0) {
  let now = start;
  for (let i = 0; i < calls; i++) {
    now = Math.max(now, pacer.nextStartAt());
    pacer.recordStart(now);
    pacer.recordCleanCall();
  }
  return now;
}

const rate = (pacer: SyncPacer) => pacer.snapshot().targetCallsPerSecond;

describe("SyncPacer", () => {
  it("starts calm: 3 s between job starts, counted from each start", () => {
    const pacer = createSyncPacer();
    expect(pacer.isDue(T0)).toBe(true);

    pacer.recordStart(T0);

    expect(pacer.nextStartAt()).toBe(T0 + 3000);
    expect(pacer.isDue(T0 + 2999)).toBe(false);
    expect(pacer.isDue(T0 + 3000)).toBe(true);
    expect(pacer.snapshot()).toEqual({
      mode: "calm",
      targetCallsPerSecond: 1000 / 3000,
      floodWaits: 0,
    });
  });

  it("speeds up by 0.05 calls/s after each clean run of 30 calls", () => {
    const pacer = createSyncPacer();
    pacer.setHistoryDue(true);

    runClean(pacer, PACING_CLEAN_RUN_CALLS - 1);
    expect(rate(pacer)).toBeCloseTo(0.7, 2);

    runClean(pacer, 1);
    expect(rate(pacer)).toBeCloseTo(0.75, 2);

    runClean(pacer, PACING_CLEAN_RUN_CALLS);
    expect(rate(pacer)).toBeCloseTo(0.8, 2);
  });

  it("reaches the default cap of 0.9 calls/s, or the configured one, and stays there", () => {
    const pacer = createSyncPacer();
    pacer.setHistoryDue(true);

    runClean(pacer, PACING_CLEAN_RUN_CALLS * 4);
    expect(rate(pacer)).toBeCloseTo(0.9, 2);

    runClean(pacer, PACING_CLEAN_RUN_CALLS * 4);
    expect(rate(pacer)).toBeCloseTo(0.9, 2);

    const capped = createSyncPacer({
      maxCallsPerSecond: 0.8,
      calmIntervalMs: 3000,
    });
    capped.setHistoryDue(true);
    runClean(capped, PACING_CLEAN_RUN_CALLS * 10);
    expect(rate(capped)).toBeCloseTo(0.8, 2);
  });

  it("starts at the cap when the cap is below 0.7", () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.5,
      calmIntervalMs: 3000,
    });
    pacer.setHistoryDue(true);

    expect(rate(pacer)).toBeCloseTo(0.5, 2);
  });

  it("halves the pace on a FLOOD_WAIT and waits it out first", () => {
    const pacer = createSyncPacer();
    pacer.setHistoryDue(true);
    const now = runClean(pacer, PACING_CLEAN_RUN_CALLS * 4);
    expect(rate(pacer)).toBeCloseTo(0.9, 2);

    const pace = pacer.recordFloodWait(now + 200, 12);

    expect(pace).toBeCloseTo(0.45, 2);
    expect(rate(pacer)).toBeCloseTo(0.45, 2);
    const resume = now + 200 + 12_000 + Math.ceil(1000 / 0.45);
    expect(pacer.nextStartAt()).toBe(resume);
    expect(pacer.isDue(resume - 1)).toBe(false);
    expect(pacer.snapshot().floodWaits).toBe(1);
  });

  it("never halves below 0.2 calls/s, whatever the calm interval", () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.9,
      calmIntervalMs: 1000,
    });
    pacer.setHistoryDue(true);

    pacer.recordFloodWait(T0, 3);
    expect(rate(pacer)).toBeCloseTo(0.35, 2);

    for (let i = 0; i < 3; i++) pacer.recordFloodWait(T0, 3);
    expect(rate(pacer)).toBeCloseTo(0.2, 2);
    expect(pacer.snapshot().floodWaits).toBe(4);
  });

  it("speeds up again after a FLOOD_WAIT only after a full clean run", () => {
    const pacer = createSyncPacer();
    pacer.setHistoryDue(true);
    runClean(pacer, PACING_CLEAN_RUN_CALLS - 1);

    pacer.recordFloodWait(T0, 5);
    expect(rate(pacer)).toBeCloseTo(0.35, 2);

    runClean(pacer, PACING_CLEAN_RUN_CALLS - 1, T0 + 10_000);
    expect(rate(pacer)).toBeCloseTo(0.35, 2);
    runClean(pacer, 1, T0 + 200_000);
    expect(rate(pacer)).toBeCloseTo(0.4, 2);
  });

  it("returns to the calm interval once no history is due, and keeps the pace it learned", () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.9,
      calmIntervalMs: 5000,
    });
    pacer.setHistoryDue(true);
    const now = runClean(pacer, PACING_CLEAN_RUN_CALLS);
    expect(rate(pacer)).toBeCloseTo(0.75, 2);

    pacer.setHistoryDue(false);
    expect(pacer.nextStartAt()).toBe(now + 5000);
    expect(pacer.snapshot().mode).toBe("calm");
    runClean(pacer, PACING_CLEAN_RUN_CALLS * 2, now);

    pacer.setHistoryDue(true);
    expect(rate(pacer)).toBeCloseTo(0.75, 2);
  });
});
