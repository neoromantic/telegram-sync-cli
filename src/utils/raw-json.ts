/**
 * The JSON every raw_json column stores:
 * - a byte array (Uint8Array, Buffer included) as a base64 string: plain
 *   JSON.stringify writes a Uint8Array as an object with a key per byte
 * - a bigint and a TL Long (mtcute's `long` objects, `{ low, high,
 *   unsigned }`) as a decimal string (#108)
 * - no `fileReference`: Telegram's file references expire, and a download
 *   fetches the message again for a fresh one (#95)
 * Everything else is written as JSON.stringify writes it.
 */
import Long from 'long'

export function toRawJson(value: unknown): string {
  return JSON.stringify(value, rawJsonReplacer)
}

function rawJsonReplacer(
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  if (key === 'fileReference') return undefined
  // JSON.stringify calls toJSON before the replacer, so a Buffer arrives as
  // { type, data }: look at the holder's own value
  const original = this[key]
  if (original instanceof Uint8Array) {
    return original.toBase64()
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (Long.isLong(value)) {
    return value.toString()
  }
  return value
}
