import { expect } from 'bun:test'
import type { tl } from '@mtcute/bun'
import { toLong } from '../../utils/long'

/** Narrow an input peer to one kind, or fail the test */
export function assertPeer<K extends tl.TypeInputPeer['_']>(
  peer: tl.TypeInputPeer | null,
  kind: K,
): asserts peer is Extract<tl.TypeInputPeer, { _: K }> {
  if (peer?._ !== kind) {
    throw new Error(`Expected ${kind}, got ${peer?._ ?? 'null'}`)
  }
}

export function expectLongEqual(
  actual: tl.Long,
  expected: string | number | bigint,
) {
  expect(actual.toString()).toBe(toLong(expected).toString())
}
