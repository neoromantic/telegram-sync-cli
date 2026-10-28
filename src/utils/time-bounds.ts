import { type DurationString, parseDuration } from '../db/types'

const DURATION = /^\d+[smhdw]$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/

/**
 * A `--since` or `--until` value as Unix seconds, or null when it is none of
 * the accepted forms:
 * - a duration back from `now`: `30m`, `24h`, `7d`, `2w`;
 * - a date, `2026-10-01`: local midnight, or with `end` the midnight after
 *   it, so an end date includes its whole day;
 * - a date and time, `2026-10-01T09:30`: local time unless it ends with `Z`
 *   or an offset such as `+03:00`.
 */
export function parseTimeBound(
  value: string,
  options: { now: number; end?: boolean },
): number | null {
  const input = value.trim()
  let ms: number

  if (DURATION.test(input)) {
    ms = options.now - parseDuration(input as DurationString)
  } else if (DATE.test(input)) {
    const [, year, month, day] = input.match(DATE)!.map(Number)
    const date = new Date(year!, month! - 1, day!)
    if (date.getMonth() !== month! - 1 || date.getDate() !== day) return null
    if (options.end) date.setDate(date.getDate() + 1)
    ms = date.getTime()
  } else if (DATE_TIME.test(input)) {
    ms = Date.parse(input)
  } else {
    return null
  }

  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
