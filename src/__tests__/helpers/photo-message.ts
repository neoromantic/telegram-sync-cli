import { Long } from '@mtcute/bun'

/** Made-up bytes: `length` bytes counting up from `seed` */
export function fakeBytes(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i * 7) % 256)
}

/**
 * A made-up photo message shaped as mtcute gives it: Long IDs, a file
 * reference and a stripped thumbnail as Uint8Array
 */
export function photoMessage(
  peerId:
    | { _: 'peerUser'; userId: number }
    | { _: 'peerChannel'; channelId: number },
  id: number,
  fromId?:
    | { _: 'peerUser'; userId: number }
    | { _: 'peerChannel'; channelId: number },
) {
  return {
    _: 'message' as const,
    id,
    peerId,
    ...(fromId ? { fromId } : {}),
    date: 1_760_000_000 + id,
    message: 'A photo of the example lake',
    media: {
      _: 'messageMediaPhoto' as const,
      photo: {
        _: 'photo' as const,
        id: Long.fromString('5000000000000000001'),
        accessHash: Long.fromString('-4000000000000000002'),
        fileReference: fakeBytes(30, 1),
        date: 1_760_000_000,
        sizes: [
          {
            _: 'photoStrippedSize' as const,
            type: 'i',
            bytes: fakeBytes(1_000, 2),
          },
          { _: 'photoSize' as const, type: 'm', w: 320, h: 240, size: 12_000 },
          { _: 'photoSize' as const, type: 'x', w: 800, h: 600, size: 60_000 },
        ],
        dcId: 2,
      },
    },
  }
}
