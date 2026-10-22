/**
 * Telegram's 64-bit hash for methods that take a `hash` and answer
 * `…NotModified` when nothing changed (https://core.telegram.org/api/offsets)
 */

const MASK_64 = (1n << 64n) - 1n

/** Telegram's xor-shift hash of the values, as a signed 64-bit integer */
export function telegramHash(values: readonly bigint[]): bigint {
  let h = 0n
  for (const value of values) {
    h ^= h >> 21n
    h ^= (h << 35n) & MASK_64
    h ^= h >> 4n
    h = (h + BigInt.asUintN(64, value)) & MASK_64
  }
  return BigInt.asIntN(64, h)
}
