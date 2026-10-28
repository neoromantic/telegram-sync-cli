/**
 * History pages, tg send and live updates write the same message_type
 * (src/utils/message-type.ts)
 */
import { describe, expect, it } from 'bun:test'
import { Long, Message, PeersIndex, type tl } from '@mtcute/bun'

import { resolveRealtimeMessageType } from '../daemon/daemon-accounts'
import {
  classifyDocument,
  MESSAGE_TYPE_BY_MEDIA_TYPE,
  messageTypeOfMediaType,
  rawMediaType,
  resolveRawMessageType,
} from '../utils/message-type'
import {
  documentMessage,
  gifMessage,
  roundMessage,
  stickerMessage,
  videoMessage,
  voiceMessage,
  webpageMessage,
} from './helpers/media-messages'
import { photoMessage } from './helpers/photo-message'

const peer = { _: 'peerUser' as const, userId: 1001 }

function withMedia(media: Record<string, unknown>) {
  return { _: 'message', id: 50, peerId: peer, date: 1_760_000_050, media }
}

const geoPoint = {
  _: 'geoPoint',
  long: 13.4,
  lat: 52.5,
  accessHash: Long.fromString('1234'),
}

/** Raw messages whose live type mtcute can compute without peers */
const COMPARED: Record<string, unknown> = {
  photo: photoMessage(peer, 1),
  voice: voiceMessage(peer, 2),
  audio: documentMessage(peer, 3, {
    mimeType: 'audio/mpeg',
    attributes: [
      { _: 'documentAttributeAudio', duration: 200, title: 'Example song' },
      { _: 'documentAttributeFilename', fileName: 'example-song.mp3' },
    ],
  }),
  video: videoMessage(peer, 4),
  round: roundMessage(peer, 5),
  'gif via animated attribute': gifMessage(peer, 6),
  'gif via image size': documentMessage(peer, 7, {
    mimeType: 'image/gif',
    attributes: [
      { _: 'documentAttributeImageSize', w: 200, h: 100 },
      { _: 'documentAttributeFilename', fileName: 'wave.gif' },
    ],
  }),
  sticker: stickerMessage(peer, 8),
  'custom emoji': documentMessage(peer, 9, {
    mimeType: 'application/x-tgsticker',
    attributes: [
      {
        _: 'documentAttributeCustomEmoji',
        alt: '🙂',
        stickerset: { _: 'inputStickerSetEmpty' },
      },
    ],
  }),
  document: documentMessage(peer, 10, {
    mimeType: 'application/pdf',
    attributes: [
      { _: 'documentAttributeFilename', fileName: 'example-report.pdf' },
    ],
  }),
  'png sent as a file': documentMessage(peer, 11, {
    mimeType: 'image/png',
    attributes: [
      { _: 'documentAttributeImageSize', w: 640, h: 480 },
      { _: 'documentAttributeFilename', fileName: 'chart.png' },
    ],
  }),
  webpage: webpageMessage(peer, 12),
  'pending link preview': withMedia({
    _: 'messageMediaWebPage',
    webpage: { _: 'webPagePending', id: Long.fromString('77'), date: 1 },
  }),
  'empty link preview': withMedia({
    _: 'messageMediaWebPage',
    webpage: { _: 'webPageEmpty', id: Long.fromString('78') },
  }),
  geo: withMedia({ _: 'messageMediaGeo', geo: geoPoint }),
  'empty geo': withMedia({ _: 'messageMediaGeo', geo: { _: 'geoPointEmpty' } }),
  'live location': withMedia({
    _: 'messageMediaGeoLive',
    geo: geoPoint,
    period: 900,
  }),
  venue: withMedia({
    _: 'messageMediaVenue',
    geo: geoPoint,
    title: 'Example cafe',
    address: '1 Example Street',
    provider: '',
    venueId: '',
    venueType: '',
  }),
  contact: withMedia({
    _: 'messageMediaContact',
    phoneNumber: '+15550000000',
    firstName: 'Alice',
    lastName: 'Example',
    vcard: '',
    userId: 1002,
  }),
  dice: withMedia({ _: 'messageMediaDice', value: 4, emoticon: '🎲' }),
  unsupported: withMedia({ _: 'messageMediaUnsupported' }),
  'photo without photo': withMedia({ _: 'messageMediaPhoto', ttlSeconds: 10 }),
  'document without document': withMedia({
    _: 'messageMediaDocument',
    ttlSeconds: 10,
  }),
  'empty media': withMedia({ _: 'messageMediaEmpty' }),
  text: { _: 'message', id: 60, peerId: peer, date: 1, message: 'Hello' },
  service: {
    _: 'messageService',
    id: 61,
    peerId: peer,
    date: 1,
    action: { _: 'messageActionHistoryClear' },
  },
}

function liveType(raw: unknown) {
  const message = new Message(
    raw as tl.TypeMessage,
    PeersIndex.from({ users: [], chats: [] }),
  )
  return resolveRealtimeMessageType(message)
}

describe('resolveRawMessageType', () => {
  for (const [name, raw] of Object.entries(COMPARED)) {
    it(`gives a ${name} message the type a live update writes`, () => {
      expect(resolveRawMessageType(raw)).toEqual(liveType(raw))
    })
  }

  it('types each kind of file as live updates do', () => {
    const types = Object.fromEntries(
      Object.entries(COMPARED).map(([name, raw]) => [
        name,
        resolveRawMessageType(raw).messageType,
      ]),
    )
    expect(types).toMatchObject({
      photo: 'photo',
      voice: 'voice',
      audio: 'audio',
      video: 'video',
      round: 'video',
      'gif via animated attribute': 'video',
      'gif via image size': 'video',
      sticker: 'sticker',
      'custom emoji': 'sticker',
      document: 'document',
      'png sent as a file': 'document',
      webpage: 'webpage',
      'pending link preview': 'text',
      geo: 'location',
      'live location': 'location',
      dice: 'dice',
      unsupported: 'text',
      'photo without photo': 'text',
      'empty media': 'text',
      service: 'service',
    })
  })

  // mtcute needs the peers of these to build their media
  it('types a poll, a story and a to-do list as live updates do', () => {
    expect(
      resolveRawMessageType(withMedia({ _: 'messageMediaPoll', poll: {} })),
    ).toEqual({ messageType: 'poll', hasMedia: true })
    expect(
      resolveRawMessageType(withMedia({ _: 'messageMediaStory', id: 3 })),
    ).toEqual({ messageType: 'unknown', hasMedia: true })
    expect(
      resolveRawMessageType(withMedia({ _: 'messageMediaToDo', todo: {} })),
    ).toEqual({ messageType: 'unknown', hasMedia: true })
  })

  it('reads a message without a TL name as a message', () => {
    const { _, ...untagged } = photoMessage(peer, 70)
    expect(resolveRawMessageType(untagged)).toEqual({
      messageType: 'photo',
      hasMedia: true,
    })
    expect(
      resolveRawMessageType({ id: 71, date: 1, media: { photo: {} } }),
    ).toEqual({ messageType: 'text', hasMedia: false })
  })

  it('reads the media of a sent message', () => {
    expect(
      resolveRawMessageType({
        _: 'updateShortSentMessage',
        id: 72,
        date: 1,
        pts: 1,
        ptsCount: 1,
        media: voiceMessage(peer, 72).media,
      }),
    ).toEqual({ messageType: 'voice', hasMedia: true })
  })

  it('gives text to anything that is not a message', () => {
    expect(resolveRawMessageType(null)).toEqual({
      messageType: 'text',
      hasMedia: false,
    })
    expect(resolveRawMessageType('not a message')).toEqual({
      messageType: 'text',
      hasMedia: false,
    })
  })
})

describe('message type helpers', () => {
  it('maps every mtcute media type, unknown ones to unknown', () => {
    expect(messageTypeOfMediaType('live_location')).toBe('location')
    expect(messageTypeOfMediaType('story')).toBe('unknown')
    expect(messageTypeOfMediaType(undefined)).toBe('unknown')
    for (const [type, messageType] of Object.entries(
      MESSAGE_TYPE_BY_MEDIA_TYPE,
    )) {
      expect(messageTypeOfMediaType(type)).toBe(messageType)
    }
  })

  it('names the attribute that decided a document', () => {
    const gif = gifMessage(peer, 80).media.document
    expect(classifyDocument(gif)).toEqual({
      type: 'video',
      attr: gif.attributes[1]!,
    })
    expect(classifyDocument({ attributes: 'garbage' })).toEqual({
      type: 'document',
      attr: null,
    })
  })

  it('gives no type to media it does not know', () => {
    expect(rawMediaType({ _: 'messageMediaSomethingNew' })).toBeNull()
    expect(rawMediaType(undefined)).toBeNull()
  })
})
