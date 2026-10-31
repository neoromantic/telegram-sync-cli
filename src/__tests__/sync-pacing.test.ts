/**
 * The adaptive pace of an account's sync jobs (#133), on an injected clock:
 * speed-up after clean runs, back-off on a FLOOD_WAIT, the cap, the calm
 * interval. No real waits.
 */
import { describe, expect, it } from 'bun:test'
import {
  createSyncPacer,
  PACING_CLEAN_RUN_CALLS,
  type SyncPacer,
} from '../daemon/sync-pacing'

const T0 = 1_760_000_000_000

/** Run `calls` clean jobs, each one as soon as the pace allows */
function runClean(pacer: SyncPacer, calls: number, start = T0): number {
  let now = start
  for (let i = 0; i < calls; i++) {
    now = Math.max(now, pacer.nextStartAt())
    pacer.recordStart(now)
    pacer.recordCleanCall()
  }
  return now
}

const rate = (pacer: SyncPacer) => pacer.snapshot().targetCallsPerSecond

describe('SyncPacer', () => {
  it('starts calm: 3 s between job starts, counted from each start', () => {
    const pacer = createSyncPacer()
    expect(pacer.isDue(T0)).toBe(true)

    pacer.recordStart(T0)

    expect(pacer.nextStartAt()).toBe(T0 + 3000)
    expect(pacer.isDue(T0 + 2999)).toBe(false)
    expect(pacer.isDue(T0 + 3000)).toBe(true)
    expect(pacer.snapshot()).toEqual({
      mode: 'calm',
      targetCallsPerSecond: 1000 / 3000,
      floodWaits: 0,
    })
  })

  it('starts history at 0.7 calls/s', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)
    pacer.recordStart(T0)

    expect(pacer.nextStartAt()).toBe(T0 + Math.ceil(1000 / 0.7))
    expect(pacer.snapshot().mode).toBe('history')
  })

  it('speeds up by 0.05 calls/s after each clean run of 30 calls', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)

    runClean(pacer, PACING_CLEAN_RUN_CALLS - 1)
    expect(rate(pacer)).toBeCloseTo(0.7, 2)

    runClean(pacer, 1)
    expect(rate(pacer)).toBeCloseTo(0.75, 2)

    runClean(pacer, PACING_CLEAN_RUN_CALLS)
    expect(rate(pacer)).toBeCloseTo(0.8, 2)
  })

  it('never goes above the cap', () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.8,
      calmIntervalMs: 3000,
    })
    pacer.setHistoryDue(true)

    runClean(pacer, PACING_CLEAN_RUN_CALLS * 10)

    expect(rate(pacer)).toBeCloseTo(0.8, 2)
  })

  it('reaches the default cap of 0.9 calls/s and stays there', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)

    runClean(pacer, PACING_CLEAN_RUN_CALLS * 4)
    expect(rate(pacer)).toBeCloseTo(0.9, 2)

    runClean(pacer, PACING_CLEAN_RUN_CALLS * 4)
    expect(rate(pacer)).toBeCloseTo(0.9, 2)
  })

  it('starts at the cap when the cap is below 0.7', () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.5,
      calmIntervalMs: 3000,
    })
    pacer.setHistoryDue(true)

    expect(rate(pacer)).toBeCloseTo(0.5, 2)
  })

  it('halves the pace on a FLOOD_WAIT and waits it out first', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)
    const now = runClean(pacer, PACING_CLEAN_RUN_CALLS * 4)
    expect(rate(pacer)).toBeCloseTo(0.9, 2)

    const pace = pacer.recordFloodWait(now + 200, 12)

    expect(pace).toBeCloseTo(0.45, 2)
    expect(rate(pacer)).toBeCloseTo(0.45, 2)
    // The wait, then one interval at the new pace
    const resume = now + 200 + 12_000 + Math.ceil(1000 / 0.45)
    expect(pacer.nextStartAt()).toBe(resume)
    expect(pacer.isDue(resume - 1)).toBe(false)
    expect(pacer.snapshot().floodWaits).toBe(1)
  })

  it('never halves below 0.2 calls/s', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)

    for (let i = 0; i < 4; i++) pacer.recordFloodWait(T0, 3)

    expect(rate(pacer)).toBeCloseTo(0.2, 2)
    expect(pacer.snapshot().floodWaits).toBe(4)
  })

  it('slows down on a FLOOD_WAIT with a calm interval shorter than the history pace', () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.9,
      calmIntervalMs: 1000,
    })
    pacer.setHistoryDue(true)
    const before = rate(pacer)

    pacer.recordFloodWait(T0, 3)

    expect(rate(pacer)).toBeLessThan(before)
    expect(rate(pacer)).toBeCloseTo(0.35, 2)
  })

  it('never runs faster than the cap', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)

    runClean(pacer, 20_000)

    expect(rate(pacer)).toBeLessThanOrEqual(0.9)
  })

  it('speeds up again after a FLOOD_WAIT only after a full clean run', () => {
    const pacer = createSyncPacer()
    pacer.setHistoryDue(true)
    runClean(pacer, PACING_CLEAN_RUN_CALLS - 1)

    pacer.recordFloodWait(T0, 5)
    expect(rate(pacer)).toBeCloseTo(0.35, 2)

    runClean(pacer, PACING_CLEAN_RUN_CALLS - 1, T0 + 10_000)
    expect(rate(pacer)).toBeCloseTo(0.35, 2)
    runClean(pacer, 1, T0 + 200_000)
    expect(rate(pacer)).toBeCloseTo(0.4, 2)
  })

  it('returns to the calm interval once no history is due, and keeps the pace it learned', () => {
    const pacer = createSyncPacer({
      maxCallsPerSecond: 0.9,
      calmIntervalMs: 5000,
    })
    pacer.setHistoryDue(true)
    const now = runClean(pacer, PACING_CLEAN_RUN_CALLS)
    expect(rate(pacer)).toBeCloseTo(0.75, 2)

    pacer.setHistoryDue(false)
    expect(pacer.nextStartAt()).toBe(now + 5000)
    expect(pacer.snapshot().mode).toBe('calm')
    // Calm calls don't speed history up
    runClean(pacer, PACING_CLEAN_RUN_CALLS * 2, now)

    pacer.setHistoryDue(true)
    expect(rate(pacer)).toBeCloseTo(0.75, 2)
  })
})
