import { describe, expect, it } from 'bun:test'

import { parseTimeBound } from '../utils/time-bounds'

/** A fixed clock: 2026-10-15 12:00 local time */
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime()
const seconds = (date: Date) => date.getTime() / 1000

describe('parseTimeBound', () => {
  it('reads a duration back from now', () => {
    expect(parseTimeBound('24h', { now: NOW })).toBe(NOW / 1000 - 24 * 3600)
    expect(parseTimeBound('7d', { now: NOW })).toBe(NOW / 1000 - 7 * 86400)
    expect(parseTimeBound('30m', { now: NOW })).toBe(NOW / 1000 - 1800)
    expect(parseTimeBound('2w', { now: NOW })).toBe(NOW / 1000 - 14 * 86400)
  })

  it('reads a date as local midnight, and as the next midnight for an end', () => {
    expect(parseTimeBound('2026-10-01', { now: NOW })).toBe(
      seconds(new Date(2026, 9, 1)),
    )
    expect(parseTimeBound('2026-10-01', { now: NOW, end: true })).toBe(
      seconds(new Date(2026, 9, 2)),
    )
    expect(parseTimeBound('2026-12-31', { now: NOW, end: true })).toBe(
      seconds(new Date(2027, 0, 1)),
    )
  })

  it('reads a date and time, local unless it has Z or an offset', () => {
    expect(parseTimeBound('2026-10-01T09:30', { now: NOW })).toBe(
      seconds(new Date(2026, 9, 1, 9, 30)),
    )
    expect(parseTimeBound('2026-10-01T09:30:15Z', { now: NOW })).toBe(
      Date.UTC(2026, 9, 1, 9, 30, 15) / 1000,
    )
    expect(parseTimeBound('2026-10-01T09:30+03:00', { now: NOW })).toBe(
      Date.UTC(2026, 9, 1, 6, 30) / 1000,
    )
    expect(parseTimeBound('2026-10-01T09:30:15.500Z', { now: NOW })).toBe(
      Date.UTC(2026, 9, 1, 9, 30, 15) / 1000,
    )
  })

  it('returns null for anything else', () => {
    for (const value of [
      'yesterday',
      '7',
      '7days',
      '2026-02-30',
      '2026-13-01',
      '2026-10-01T25:00',
      '2026-02-30T09:30',
      '2026-04-31T09:30+03:00',
      '2026-10-01T24:00',
      '2026-10-01T09:60',
      '2026-10-01T09:30:60Z',
      '01.10.2026',
      '',
    ]) {
      expect(parseTimeBound(value, { now: NOW })).toBeNull()
    }
  })
})
