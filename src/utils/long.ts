import type { tl } from '@mtcute/bun'
import Long from 'long'

export function toLong(
  value: tl.Long | bigint | number | string | null | undefined,
): tl.Long {
  if (Long.isLong(value)) {
    return value
  }
  if (typeof value === 'bigint') {
    return Long.fromString(value.toString())
  }
  if (value === null || value === undefined) {
    return Long.fromInt(0)
  }
  return Long.fromValue(value)
}
