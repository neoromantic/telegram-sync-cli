/**
 * The file of a cached message, read from its raw TL message in every form
 * raw_json takes (src/utils/attachment.ts)
 */
import { describe, expect, it } from 'bun:test'
import { _messageMediaFromTl, Long, Thumbnail, type tl } from '@mtcute/bun'

import {
  type TelegramMessage,
  telegramMessageToInput,
} from '../daemon/sync-worker-core'
import {
  type AttachmentInfo,
  attachmentDefaultFileName,
  extractAttachment,
  pickThumb,
  uniqueFileIdOf,
} from '../utils/attachment'
import { toRawJson } from '../utils/raw-json'
import {
  documentMessage,
  gifMessage,
  pdfDocumentMessage,
  roundMessage,
  stickerMessage,
  videoMessage,
  voiceMessage,
  webpageMessage,
} from './helpers/media-messages'
import { fakeBytes, photoMessage } from './helpers/photo-message'

const peer = { _: 'peerUser' as const, userId: 1001 }

/**
 * The uniqueFileId mtcute gives the media of a raw message. mtcute decodes
 * every preview of a photo on the way, and the made-up stripped previews
 * aren't real JPEG data, so they are left out.
 */
function mtcuteUniqueFileId(message: { media: unknown }): string {
  const media = message.media as { photo?: { sizes: Array<{ _: string }> } }
  const raw = media.photo
    ? {
        ...media,
        photo: {
          ...media.photo,
          sizes: media.photo.sizes.filter(
            (size) => size._ !== 'photoStrippedSize',
          ),
        },
      }
    : media
  const parsed = _messageMediaFromTl(null, raw as tl.TypeMessageMedia)
  return (parsed as unknown as { uniqueFileId: string }).uniqueFileId
}

function progressivePhotoMessage(id: number) {
  const message = photoMessage(peer, id)
  return {
    ...message,
    media: {
      ...message.media,
      photo: {
        ...message.media.photo,
        sizes: [
          { _: 'photoStrippedSize', type: 'i', bytes: fakeBytes(500, 9) },
          { _: 'photoSize', type: 'm', w: 320, h: 240, size: 11_000 },
          {
            _: 'photoSizeProgressive',
            type: 'y',
            w: 1280,
            h: 960,
            sizes: [5_000, 20_000, 80_000],
          },
        ],
      },
    },
  }
}

const audioMessage = documentMessage(peer, 30, {
  mimeType: 'audio/mpeg',
  size: 3_200_000,
  thumbs: [],
  attributes: [
    { _: 'documentAttributeAudio', duration: 200, title: 'Example song' },
    { _: 'documentAttributeFilename', fileName: 'example-song.mp3' },
  ],
})

const pdfMessage = pdfDocumentMessage(peer, 31)

const gifAsImageMessage = documentMessage(peer, 32, {
  mimeType: 'image/gif',
  size: 50_000,
  attributes: [
    { _: 'documentAttributeImageSize', w: 200, h: 100 },
    { _: 'documentAttributeFilename', fileName: 'wave.gif' },
  ],
})

const pngFileMessage = documentMessage(peer, 33, {
  mimeType: 'image/png',
  size: 70_000,
  attributes: [
    { _: 'documentAttributeImageSize', w: 640, h: 480 },
    { _: 'documentAttributeFilename', fileName: 'chart.png' },
  ],
})

const customEmojiMessage = documentMessage(peer, 34, {
  mimeType: 'application/x-tgsticker',
  size: 9_000,
  attributes: [
    {
      _: 'documentAttributeCustomEmoji',
      alt: '🙂',
      stickerset: { _: 'inputStickerSetEmpty' },
    },
  ],
})

const webpageDocumentMessage = {
  ...webpageMessage(peer, 35),
  media: {
    _: 'messageMediaWebPage',
    webpage: {
      ...webpageMessage(peer, 35).media.webpage,
      type: 'document',
      document: pdfMessage.media.document,
    },
  },
}

function base(info: Partial<AttachmentInfo>): AttachmentInfo {
  return {
    kind: 'document',
    source: 'message',
    fileName: null,
    mimeType: null,
    size: null,
    duration: null,
    width: null,
    height: null,
    uniqueFileId: expect.any(String) as unknown as string,
    groupedId: null,
    ...info,
  }
}

describe('extractAttachment', () => {
  it('reads a photo: its largest plain size', () => {
    expect(extractAttachment(photoMessage(peer, 20))).toEqual(
      base({
        kind: 'photo',
        mimeType: 'image/jpeg',
        size: 60_000,
        width: 800,
        height: 600,
      }),
    )
  })

  it('reads a photo with a progressive size: that size, its largest part', () => {
    expect(extractAttachment(progressivePhotoMessage(21))).toEqual(
      base({
        kind: 'photo',
        mimeType: 'image/jpeg',
        size: 80_000,
        width: 1280,
        height: 960,
      }),
    )
  })

  it('reads each kind of document', () => {
    expect(extractAttachment(voiceMessage(peer, 22))).toEqual(
      base({ kind: 'voice', mimeType: 'audio/ogg', size: 24_000, duration: 7 }),
    )
    expect(extractAttachment(audioMessage)).toEqual(
      base({
        kind: 'audio',
        fileName: 'example-song.mp3',
        mimeType: 'audio/mpeg',
        size: 3_200_000,
        duration: 200,
      }),
    )
    expect(extractAttachment(videoMessage(peer, 23))).toEqual(
      base({
        kind: 'video',
        fileName: 'example-lake.mp4',
        mimeType: 'video/mp4',
        size: 4_000_000,
        duration: 12.5,
        width: 1280,
        height: 720,
      }),
    )
    expect(extractAttachment(roundMessage(peer, 24))).toEqual(
      base({
        kind: 'round',
        mimeType: 'video/mp4',
        size: 900_000,
        duration: 9,
        width: 384,
        height: 384,
      }),
    )
    expect(extractAttachment(gifMessage(peer, 25))).toEqual(
      base({
        kind: 'animation',
        fileName: 'wave.gif.mp4',
        mimeType: 'video/mp4',
        size: 300_000,
        duration: 3,
        width: 480,
        height: 270,
      }),
    )
    expect(extractAttachment(gifAsImageMessage)).toEqual(
      base({
        kind: 'animation',
        fileName: 'wave.gif',
        mimeType: 'image/gif',
        size: 50_000,
        width: 200,
        height: 100,
      }),
    )
    expect(extractAttachment(stickerMessage(peer, 26))).toEqual(
      base({
        kind: 'sticker',
        fileName: 'sticker.webp',
        mimeType: 'image/webp',
        size: 25_000,
        width: 512,
        height: 512,
      }),
    )
    expect(extractAttachment(customEmojiMessage)).toEqual(
      base({
        kind: 'sticker',
        mimeType: 'application/x-tgsticker',
        size: 9_000,
      }),
    )
    expect(extractAttachment(pdfMessage)).toEqual(
      base({
        fileName: 'example-report.pdf',
        mimeType: 'application/pdf',
        size: 120_000,
      }),
    )
    expect(extractAttachment(pngFileMessage)).toEqual(
      base({
        fileName: 'chart.png',
        mimeType: 'image/png',
        size: 70_000,
        width: 640,
        height: 480,
      }),
    )
  })

  it('reads the photo or document of a link preview', () => {
    expect(extractAttachment(webpageMessage(peer, 27))).toEqual(
      base({
        kind: 'photo',
        source: 'webpage',
        mimeType: 'image/jpeg',
        size: 40_000,
        width: 800,
        height: 533,
      }),
    )
    expect(extractAttachment(webpageDocumentMessage)).toEqual(
      base({
        source: 'webpage',
        fileName: 'example-report.pdf',
        mimeType: 'application/pdf',
        size: 120_000,
      }),
    )
  })

  it('reads the media of a sent message', () => {
    expect(
      extractAttachment({
        _: 'updateShortSentMessage',
        out: true,
        id: 28,
        pts: 10,
        ptsCount: 1,
        date: 1_760_000_028,
        media: pdfMessage.media,
      }),
    ).toEqual(extractAttachment(pdfMessage))
  })

  it('gives null for a message without a file', () => {
    const withMedia = (media: unknown) => ({
      _: 'message',
      id: 40,
      peerId: peer,
      date: 1,
      media,
    })
    const photo = photoMessage(peer, 40).media.photo
    for (const message of [
      { _: 'message', id: 40, peerId: peer, date: 1, message: 'Hello' },
      { _: 'messageService', id: 40, peerId: peer, date: 1, action: {} },
      { _: 'messageEmpty', id: 40 },
      withMedia({ _: 'messageMediaEmpty' }),
      withMedia({ _: 'messageMediaGeo', geo: { _: 'geoPointEmpty' } }),
      withMedia({ _: 'messageMediaPoll', poll: {}, results: {} }),
      withMedia({ _: 'messageMediaPhoto', ttlSeconds: 10 }),
      withMedia({ _: 'messageMediaPhoto', photo: { ...photo, sizes: [] } }),
      withMedia({ _: 'messageMediaDocument', ttlSeconds: 10 }),
      withMedia({
        _: 'messageMediaWebPage',
        webpage: { _: 'webPageEmpty', id: Long.fromString('9') },
      }),
      withMedia({
        _: 'messageMediaWebPage',
        webpage: {
          ...webpageMessage(peer, 40).media.webpage,
          photo: undefined,
        },
      }),
    ]) {
      expect(extractAttachment(message)).toBeNull()
    }
  })

  it('gives null for anything that is not a message', () => {
    for (const input of [
      undefined,
      null,
      42,
      'not json',
      '{}',
      '[]',
      'null',
      { _: 'user', id: 1 },
      { media: photoMessage(peer, 1).media },
    ]) {
      expect(extractAttachment(input)).toBeNull()
    }
  })

  describe('every form raw_json takes', () => {
    const message = {
      ...videoMessage(peer, 41),
      groupedId: Long.fromString('-8000000000000000001'),
    }
    const expected = extractAttachment(message)

    it('reads the raw message', () => {
      expect(expected).toMatchObject({
        kind: 'video',
        groupedId: '-8000000000000000001',
      })
    })

    it('reads raw_json written by toRawJson: base64 bytes, Long objects', () => {
      const rawJson = toRawJson(message)
      expect(JSON.parse(rawJson).media.document.fileReference).toBeString()
      expect(JSON.parse(rawJson).groupedId).toHaveProperty('high')
      expect(extractAttachment(rawJson)).toEqual(expected)
    })

    it('reads raw_json of older rows: bytes as objects with a key per byte', () => {
      const rawJson = JSON.stringify(message)
      expect(JSON.parse(rawJson).media.document.fileReference).toHaveProperty(
        '0',
      )
      expect(extractAttachment(rawJson)).toEqual(expected)
    })

    it('reads IDs as decimal strings, numbers and bigints', () => {
      const document = message.media.document
      expect(
        extractAttachment({
          ...message,
          groupedId: '-8000000000000000001',
          media: {
            ...message.media,
            document: { ...document, id: '6000000000000000003' },
          },
        }),
      ).toEqual(expected)
      expect(
        extractAttachment({
          ...message,
          groupedId: -8000000000000000001n,
          media: {
            ...message.media,
            document: {
              ...document,
              id: 6000000000000000003n,
              size: '4000000',
            },
          },
        }),
      ).toEqual(expected)
      expect(
        extractAttachment({
          ...message,
          groupedId: 12345,
          media: {
            ...message.media,
            document: { ...document, id: 77 },
          },
        }),
      ).toMatchObject({
        groupedId: '12345',
        uniqueFileId: uniqueFileIdOf(2, 77n),
      })
    })

    it('reads an unsigned Long', () => {
      expect(
        extractAttachment({
          ...message,
          groupedId: { low: -1, high: -1, unsigned: true },
        })?.groupedId,
      ).toBe('18446744073709551615')
    })
  })

  it('reads the abstract sync worker message and its raw_json', () => {
    const { _, ...untagged } = photoMessage(peer, 42)
    const expected = extractAttachment(photoMessage(peer, 42))
    expect(expected).not.toBeNull()
    expect(extractAttachment(untagged)).toEqual(expected)
    const input = telegramMessageToInput(1001, untagged as TelegramMessage)
    expect(extractAttachment(input.raw_json)).toEqual(expected)

    // Media not in raw TL form can't be read
    expect(
      extractAttachment({ id: 43, date: 1, media: { photo: {} } }),
    ).toBeNull()
  })
})

describe('uniqueFileId', () => {
  it('equals the uniqueFileId mtcute gives each file', () => {
    for (const message of [
      photoMessage(peer, 1),
      progressivePhotoMessage(2),
      voiceMessage(peer, 3),
      audioMessage,
      videoMessage(peer, 4),
      roundMessage(peer, 5),
      gifMessage(peer, 6),
      gifAsImageMessage,
      stickerMessage(peer, 7),
      customEmojiMessage,
      pdfMessage,
    ]) {
      expect(extractAttachment(message)?.uniqueFileId).toBe(
        mtcuteUniqueFileId(message),
      )
      expect(extractAttachment(toRawJson(message))?.uniqueFileId).toBe(
        mtcuteUniqueFileId(message),
      )
    }
  })

  it('equals mtcute for every preview type', () => {
    const photo = photoMessage(peer, 1).media.photo
    for (const type of ['a', 'c', 'm', 'y', 'u', 's']) {
      const size = { _: 'photoSize' as const, type, w: 90, h: 90, size: 1 }
      expect(uniqueFileIdOf(1, 5000000000000000001n, type)).toBe(
        new Thumbnail(photo as unknown as tl.RawPhoto, size).uniqueFileId,
      )
    }
  })

  it('is the same for the same file in two messages', () => {
    expect(extractAttachment(videoMessage(peer, 1))?.uniqueFileId).toBe(
      extractAttachment(videoMessage({ _: 'peerChannel', channelId: 77 }, 9))
        ?.uniqueFileId,
    )
  })
})

describe('pickThumb', () => {
  it("picks a photo's m size, with mtcute's ID and size", () => {
    const message = photoMessage(peer, 1)
    const photo = message.media.photo
    const thumb = new Thumbnail(
      photo as unknown as tl.RawPhoto,
      photo.sizes[1] as tl.RawPhotoSize,
    )
    expect(pickThumb(message)).toEqual({
      type: 'm',
      width: 320,
      height: 240,
      size: thumb.fileSize!,
      uniqueFileId: thumb.uniqueFileId,
    })
  })

  it('picks the smallest plain size of a photo without an m size', () => {
    const message = photoMessage(peer, 1)
    const sizes = message.media.photo.sizes.filter((size) => size.type !== 'm')
    expect(
      pickThumb({
        ...message,
        media: {
          ...message.media,
          photo: {
            ...message.media.photo,
            sizes: [
              ...sizes,
              { _: 'photoSize', type: 's', w: 90, h: 68, size: 1_500 },
            ],
          },
        },
      }),
    ).toMatchObject({ type: 's', size: 1_500 })
  })

  it("picks a document's preview, with its own size, not the file's", () => {
    const message = videoMessage(peer, 1)
    const document = message.media.document
    const thumb = new Thumbnail(
      document as unknown as tl.RawDocument,
      document.thumbs[1] as unknown as tl.RawPhotoSize,
    )
    const picked = pickThumb(toRawJson(message))
    expect(picked).toEqual({
      type: 'm',
      width: 320,
      height: 180,
      size: thumb.fileSize!,
      uniqueFileId: thumb.uniqueFileId,
    })
    expect(picked?.size).toBe(3_000)
    expect(picked?.size).not.toBe(extractAttachment(message)?.size)
  })

  it('takes the largest part of a progressive preview', () => {
    const progressive = {
      _: 'photoSizeProgressive' as const,
      type: 'x',
      w: 800,
      h: 450,
      sizes: [2_000, 6_000, 14_000],
    }
    const message = documentMessage(peer, 2, {
      mimeType: 'video/mp4',
      attributes: [
        { _: 'documentAttributeVideo', duration: 5, w: 800, h: 450 },
      ],
      thumbs: [
        { _: 'photoSize', type: 'm', w: 320, h: 180, size: 3_000 },
        progressive,
      ],
    })
    const thumb = new Thumbnail(
      message.media.document as unknown as tl.RawDocument,
      progressive,
    )
    expect(pickThumb(message)).toEqual({
      type: 'x',
      width: 800,
      height: 450,
      size: thumb.fileSize!,
      uniqueFileId: thumb.uniqueFileId,
    })
  })

  it('gives null without a usable preview', () => {
    expect(pickThumb(voiceMessage(peer, 1))).toBeNull()
    expect(
      pickThumb(
        documentMessage(peer, 2, {
          mimeType: 'application/pdf',
          attributes: [],
          thumbs: [{ _: 'photoStrippedSize', type: 'i', bytes: fakeBytes(9) }],
        }),
      ),
    ).toBeNull()
    expect(pickThumb('{}')).toBeNull()
  })
})

describe('attachmentDefaultFileName', () => {
  it('names a file by its kind and MIME type', () => {
    const named = (kind: AttachmentInfo['kind'], mimeType: string | null) =>
      attachmentDefaultFileName(base({ kind, mimeType, uniqueFileId: 'x' }))
    expect(named('photo', 'image/jpeg')).toBe('photo.jpg')
    expect(named('voice', 'audio/ogg')).toBe('voice.ogg')
    expect(named('video', 'video/mp4')).toBe('video.mp4')
    expect(named('round', 'video/mp4')).toBe('round.mp4')
    expect(named('animation', 'video/mp4')).toBe('animation.mp4')
    expect(named('audio', 'audio/mpeg')).toBe('audio.mp3')
    expect(named('sticker', 'application/x-tgsticker')).toBe('sticker.tgs')
    expect(named('sticker', 'image/webp')).toBe('sticker.webp')
    expect(named('document', 'application/pdf')).toBe('file.pdf')
    expect(named('document', 'application/x-unknown')).toBe('file.bin')
    expect(named('document', null)).toBe('file.bin')
  })
})
