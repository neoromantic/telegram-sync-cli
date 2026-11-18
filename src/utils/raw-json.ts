import Long from "long";

export function toRawJson(value: unknown): string {
  return JSON.stringify(value, rawJsonReplacer);
}

function rawJsonReplacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  if (key === "fileReference") return undefined;
  const original = this[key];
  if (original instanceof Uint8Array) {
    return original.toBase64();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Long.isLong(value)) {
    return value.toString();
  }
  return value;
}

type JsonObject = Record<string, unknown>;

function bytesOfByteObject(value: JsonObject): Uint8Array | null {
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  const bytes = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== String(i)) return null;
    const byte = value[keys[i] as string];
    if (
      typeof byte !== "number" ||
      !Number.isInteger(byte) ||
      byte < 0 ||
      byte > 255 ||
      Object.is(byte, -0)
    ) {
      return null;
    }
    bytes[i] = byte;
  }
  return bytes;
}

function isInt32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= -0x8000_0000 &&
    value <= 0x7fff_ffff &&
    !Object.is(value, -0)
  );
}

function decimalOfLongObject(value: JsonObject): string | null {
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !isInt32(value.low) ||
    !isInt32(value.high) ||
    typeof value.unsigned !== "boolean"
  ) {
    return null;
  }
  const bits = (BigInt(value.high as number) << 32n) | BigInt((value.low as number) >>> 0);
  return (value.unsigned ? BigInt.asUintN(64, bits) : BigInt.asIntN(64, bits)).toString();
}

function reencodeValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    for (let i = 0; i < value.length; i++) {
      const item = reencodeValue(value[i]);
      if (item.changed) {
        value[i] = item.value;
        changed = true;
      }
    }
    return { value, changed };
  }
  if (typeof value !== "object" || value === null) {
    return { value, changed: false };
  }

  const object = value as JsonObject;
  const decimal = decimalOfLongObject(object);
  if (decimal !== null) return { value: decimal, changed: true };
  const bytes = bytesOfByteObject(object);
  if (bytes !== null) return { value: bytes.toBase64(), changed: true };

  let changed = false;
  for (const key of Object.keys(object)) {
    if (key === "fileReference") {
      delete object[key];
      changed = true;
      continue;
    }
    const item = reencodeValue(object[key]);
    if (item.changed) {
      object[key] = item.value;
      changed = true;
    }
  }
  return { value: object, changed };
}

/** Text that may hold a form toRawJson no longer writes; false is certain */
export function mayNeedReencode(rawJson: string): boolean {
  return (
    rawJson.includes('"unsigned":') ||
    rawJson.includes('"0":') ||
    rawJson.includes('"fileReference"')
  );
}

/**
 * The parsed raw_json of a row in toRawJson's current form. `changed` tells
 * whether it differs from what the row holds; `value` is null for text that
 * isn't JSON, which is kept as it is.
 */
export function reencodeRawJson(rawJson: string): {
  value: unknown;
  changed: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { value: null, changed: false };
  }
  if (!mayNeedReencode(rawJson)) return { value: parsed, changed: false };
  return reencodeValue(parsed);
}
