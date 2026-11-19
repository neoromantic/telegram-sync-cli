import { type DurationString, parseDuration } from "../db/types";

const DURATION = /^\d+[smhdw]$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function localDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year!, month! - 1, day!);
  if (date.getMonth() !== month! - 1 || date.getDate() !== day) return null;
  return date;
}

/**
 * A `--since` or `--until` value as Unix seconds, or null when it is none of
 * the accepted forms:
 * - a duration back from `now`: `30m`, `24h`, `7d`, `2w`;
 * - a date, `2026-10-01`: local midnight, or with `end` the midnight after
 *   it, so an end date includes its whole day;
 * - a date and time, `2026-10-01T09:30`: local time unless it ends with `Z`
 *   or an offset such as `+03:00`.
 */
export function parseTimeBound(value: string, options: { now: number; end?: boolean }) {
  const input = value.trim();
  let ms: number;

  if (DURATION.test(input)) {
    ms = options.now - parseDuration(input as DurationString);
  } else if (DATE.test(input)) {
    const date = localDate(input);
    if (!date) return null;
    if (options.end) date.setDate(date.getDate() + 1);
    ms = date.getTime();
  } else if (DATE_TIME.test(input)) {
    const [, date, hour, minute, second] = input.match(DATE_TIME)!;
    if (!localDate(date!)) return null;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) {
      return null;
    }
    ms = Date.parse(input);
  } else {
    return null;
  }

  return Number.isFinite(ms) ? Math.ceil(ms / 1000) : null;
}
