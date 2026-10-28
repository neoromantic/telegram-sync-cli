import { Long } from '@mtcute/bun'

import { fakeBytes } from './photo-message'

type Peer =
  | { _: 'peerUser'; userId: number }
  | { _: 'peerChat'; chatId: number }
  | { _: 'peerChannel'; channelId: number }

export interface FakeDocument {
  mimeType: string
  attributes: Array<Record<string, unknown> & { _: string }>
  size?: number
  /** The document's previews; a stripped size and a 320 px one by default */
  thumbs?: Array<Record<string, unknown> & { _: string }>
  /** Document ID, as a decimal string */
  id?: string
}

/**
 * A made-up raw TL document, shaped as mtcute gives it: Long IDs, a file
 * reference and a stripped thumbnail as Uint8Array
 */
export function fakeDocument(document: FakeDocument) {
  return {
    _: 'document' as const,
    id: Long.fromString(document.id ?? '6000000000000000003'),
    accessHash: Long.fromString('-3000000000000000004'),
    fileReference: fakeBytes(30, 3),
    date: 1_760_000_000,
    mimeType: document.mimeType,
    size: document.size ?? 4_000_000,
    thumbs: document.thumbs ?? [
      { _: 'photoStrippedSize', type: 'i', bytes: fakeBytes(800, 4) },
      { _: 'photoSize', type: 'm', w: 320, h: 180, size: 3_000 },
    ],
    dcId: 2,
    attributes: document.attributes,
  }
}

/** A made-up message holding a document */
export function documentMessage(
  peerId: Peer,
  id: number,
  document: FakeDocument,
  extra: Record<string, unknown> = {},
) {
  return {
    _: 'message' as const,
    id,
    peerId,
    date: 1_760_000_000 + id,
    message: '',
    media: {
      _: 'messageMediaDocument' as const,
      document: fakeDocument(document),
    },
    ...extra,
  }
}

export function pdfDocumentMessage(peerId: Peer, id: number) {
  return documentMessage(peerId, id, {
    id: '6000000000000000013',
    mimeType: 'application/pdf',
    size: 120_000,
    attributes: [
      { _: 'documentAttributeFilename', fileName: 'example-report.pdf' },
    ],
  })
}

export function voiceMessage(peerId: Peer, id: number) {
  return documentMessage(peerId, id, {
    mimeType: 'audio/ogg',
    size: 24_000,
    thumbs: [],
    attributes: [
      {
        _: 'documentAttributeAudio',
        voice: true,
        duration: 7,
        waveform: fakeBytes(63, 5),
      },
    ],
  })
}

export function videoMessage(peerId: Peer, id: number) {
  return documentMessage(peerId, id, {
    mimeType: 'video/mp4',
    attributes: [
      {
        _: 'documentAttributeVideo',
        supportsStreaming: true,
        duration: 12.5,
        w: 1280,
        h: 720,
      },
      { _: 'documentAttributeFilename', fileName: 'example-lake.mp4' },
    ],
  })
}

export function roundMessage(peerId: Peer, id: number) {
  return documentMessage(peerId, id, {
    mimeType: 'video/mp4',
    size: 900_000,
    attributes: [
      {
        _: 'documentAttributeVideo',
        roundMessage: true,
        duration: 9,
        w: 384,
        h: 384,
      },
    ],
  })
}

/** A GIF as Telegram stores it: an MP4 with the animated attribute */
export function gifMessage(peerId: Peer, id: number) {
  return documentMessage(peerId, id, {
    mimeType: 'video/mp4',
    size: 300_000,
    attributes: [
      { _: 'documentAttributeImageSize', w: 480, h: 270 },
      { _: 'documentAttributeVideo', duration: 3, w: 480, h: 270 },
      { _: 'documentAttributeFilename', fileName: 'wave.gif.mp4' },
      { _: 'documentAttributeAnimated' },
    ],
  })
}

export function stickerMessage(peerId: Peer, id: number) {
  return documentMessage(peerId, id, {
    mimeType: 'image/webp',
    size: 25_000,
    attributes: [
      { _: 'documentAttributeImageSize', w: 512, h: 512 },
      {
        _: 'documentAttributeSticker',
        alt: '🙂',
        stickerset: { _: 'inputStickerSetEmpty' },
      },
      { _: 'documentAttributeFilename', fileName: 'sticker.webp' },
    ],
  })
}

/** A message whose link preview carries a photo */
export function webpageMessage(peerId: Peer, id: number) {
  return {
    _: 'message' as const,
    id,
    peerId,
    date: 1_760_000_000 + id,
    message: 'https://example.com/lake',
    media: {
      _: 'messageMediaWebPage' as const,
      webpage: {
        _: 'webPage' as const,
        id: Long.fromString('7000000000000000005'),
        url: 'https://example.com/lake',
        displayUrl: 'example.com/lake',
        hash: 0,
        type: 'photo',
        siteName: 'Example',
        title: 'The example lake',
        photo: {
          _: 'photo' as const,
          id: Long.fromString('5000000000000000011'),
          accessHash: Long.fromString('-4000000000000000012'),
          fileReference: fakeBytes(30, 6),
          date: 1_760_000_000,
          sizes: [
            { _: 'photoSize' as const, type: 'm', w: 320, h: 213, size: 9_000 },
            {
              _: 'photoSize' as const,
              type: 'x',
              w: 800,
              h: 533,
              size: 40_000,
            },
          ],
          dcId: 2,
        },
      },
    },
  }
}
