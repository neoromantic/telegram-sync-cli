import { describe, expect, it } from 'bun:test'
import { Long } from '@mtcute/bun'

import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { toRawJson } from '../utils/raw-json'
import { fakeBytes, photoMessage } from './helpers/photo-message'

function fromBase64(value: unknown): Uint8Array {
  expect(typeof value).toBe('string')
  return Uint8Array.fromBase64(value as string)
}

describe('toRawJson', () => {
  it('writes byte arrays as base64 that decodes to the same bytes', () => {
    const message = photoMessage({ _: 'peerUser', userId: 10 }, 1)

    const raw = JSON.parse(toRawJson(message))

    const { photo } = message.media
    expect(fromBase64(raw.media.photo.sizes[0].bytes)).toEqual(
      fakeBytes(1_000, 2),
    )
    expect(raw.media.photo.sizes[1]).toEqual(photo.sizes[1])
    expect(raw.peerId).toEqual({ _: 'peerUser', userId: 10 })
  })

  it('makes a photo message far smaller than plain JSON', () => {
    const message = photoMessage({ _: 'peerUser', userId: 10 }, 1)

    const plain = JSON.stringify(message).length
    const compact = toRawJson(message).length

    // Plain JSON writes every byte as a key of its own: 7,000+ characters
    // for 1,030 bytes; base64 takes 4 characters per 3 bytes
    expect(plain).toBeGreaterThan(7_000)
    expect(compact).toBeLessThan(2_000)
  })

  it('writes a Buffer and a subarray as base64 of their own bytes', () => {
    const bytes = fakeBytes(12, 3)
    const raw = JSON.parse(
      toRawJson({ buffer: Buffer.from(bytes), part: bytes.subarray(4, 8) }),
    )

    expect(fromBase64(raw.buffer)).toEqual(bytes)
    expect(fromBase64(raw.part)).toEqual(bytes.subarray(4, 8))
  })

  it('writes a bigint as a decimal string and keeps other values', () => {
    expect(
      JSON.parse(
        toRawJson({ hash: 12345678901234567890n, empty: new Uint8Array() }),
      ),
    ).toEqual({ hash: '12345678901234567890', empty: '' })
    expect(toRawJson({ a: [1, 'x', null, true], b: undefined })).toBe(
      '{"a":[1,"x",null,true]}',
    )
  })

  it('writes Long values as decimal strings, signed unless unsigned (#108)', () => {
    const message = photoMessage({ _: 'peerUser', userId: 10 }, 1)

    const raw = JSON.parse(toRawJson(message))

    expect(raw.media.photo.id).toBe('5000000000000000001')
    expect(raw.media.photo.accessHash).toBe('-4000000000000000002')
    expect(
      JSON.parse(
        toRawJson({ hash: Long.fromString('18446744073709551615', true) }),
      ),
    ).toEqual({ hash: '18446744073709551615' })
  })

  it('leaves out every fileReference and keeps the stripped thumbnail (#95)', () => {
    const message = photoMessage({ _: 'peerUser', userId: 10 }, 1)
    const nested = {
      _: 'message',
      media: {
        _: 'messageMediaWebPage',
        webpage: { _: 'webPage', photo: message.media.photo },
      },
    }

    const raw = toRawJson(nested)

    expect(raw).not.toContain('fileReference')
    expect(JSON.parse(raw).media.webpage.photo.sizes[0].bytes).toBeString()
  })

  it('is what a fetched message stores', () => {
    const message = photoMessage({ _: 'peerUser', userId: 10 }, 1)

    expect(parseRawMessage(message, 10)?.raw_json).toBe(toRawJson(message))
  })
})
