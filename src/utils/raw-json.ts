/**
 * The JSON every raw_json column stores. A bigint is written as a decimal
 * string and a byte array (Uint8Array, Buffer included) as a base64 string:
 * plain JSON.stringify writes a Uint8Array as an object with a key per byte.
 * Everything else is written as JSON.stringify writes it.
 */
export function toRawJson(value: unknown): string {
  return JSON.stringify(value, rawJsonReplacer)
}

function rawJsonReplacer(
  this: Record<string, unknown>,
  key: string,
  value: unknown,
): unknown {
  // JSON.stringify calls toJSON before the replacer, so a Buffer arrives as
  // { type, data }: look at the holder's own value
  const original = this[key]
  if (original instanceof Uint8Array) {
    return original.toBase64()
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}
