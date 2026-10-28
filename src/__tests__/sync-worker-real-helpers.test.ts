/**
 * Tests for sync worker real helpers
 */
import { describe, expect, it } from 'bun:test'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import {
  gifMessage,
  pdfDocumentMessage,
  roundMessage,
  stickerMessage,
  videoMessage,
  voiceMessage,
} from './helpers/media-messages'

describe('sync-worker-real parseRawMessage', () => {
  it('maps forward_from_id for all peer types', () => {
    const base = {
      _: 'message',
      id: 10,
      date: 1700000000,
      message: 'Forwarded',
    }

    const fromUser = parseRawMessage(
      {
        ...base,
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerUser', userId: 111 },
          date: 1699999999,
        },
      },
      1,
    )

    const fromChat = parseRawMessage(
      {
        ...base,
        id: 11,
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerChat', chatId: 222 },
          date: 1699999998,
        },
      },
      1,
    )

    const fromChannel = parseRawMessage(
      {
        ...base,
        id: 12,
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerChannel', channelId: 333 },
          date: 1699999997,
        },
      },
      1,
    )

    expect(fromUser?.forward_from_id).toBe(111)
    expect(fromChat?.forward_from_id).toBe(-222)
    expect(fromChannel?.forward_from_id).toBe(-1000000000333)
  })

  it('gives a sender its marked ID', () => {
    const page = [
      { _: 'peerUser', userId: 111 },
      { _: 'peerChat', chatId: 222 },
      { _: 'peerChannel', channelId: 333 },
      undefined,
    ].map((fromId, index) =>
      parseRawMessage(
        {
          _: 'message',
          id: 30 + index,
          peerId: { _: 'peerChannel', channelId: 1234567890 },
          ...(fromId ? { fromId } : {}),
          date: 1700000000,
          message: 'hello',
        },
        -1001234567890,
      ),
    )

    // Telegram leaves fromId out of a channel post: the channel is the sender
    expect(page.map((message) => message?.from_id)).toEqual([
      111, -222, -1000000000333, -1001234567890,
    ])
  })

  it('gives an incoming private message without fromId its user as the sender', () => {
    const result = parseRawMessage(
      {
        _: 'message',
        id: 40,
        peerId: { _: 'peerUser', userId: 5550001 },
        date: 1700000000,
        message: 'hi',
      },
      5550001,
    )

    expect(result?.from_id).toBe(5550001)
  })

  it('marks service messages as service without media', () => {
    const result = parseRawMessage(
      {
        _: 'messageService',
        id: 20,
        date: 1700000100,
      },
      5,
    )

    expect(result?.message_type).toBe('service')
    expect(result?.has_media).toBe(false)
    expect(result?.text).toBeNull()
    // No fromId and no peerId: nothing names a sender
    expect(result?.from_id).toBeNull()
  })

  it('maps media types and sets has_media', () => {
    const location = parseRawMessage(
      {
        _: 'message',
        id: 30,
        date: 1700000200,
        media: {
          _: 'messageMediaGeoLive',
          geo: { _: 'geoPoint', long: 13.4, lat: 52.5, accessHash: 0 },
          period: 900,
        },
      },
      9,
    )

    const unsupported = parseRawMessage(
      {
        _: 'message',
        id: 31,
        date: 1700000201,
        media: { _: 'messageMediaUnsupported' },
      },
      9,
    )

    expect(location?.message_type).toBe('location')
    expect(location?.has_media).toBe(true)
    // mtcute gives live updates no media for these, so they store text
    expect(unsupported?.message_type).toBe('text')
    expect(unsupported?.has_media).toBe(false)
  })

  it('types files as live updates do', () => {
    const peer = { _: 'peerUser' as const, userId: 9 }
    const types = [
      voiceMessage(peer, 32),
      videoMessage(peer, 33),
      roundMessage(peer, 34),
      gifMessage(peer, 35),
      stickerMessage(peer, 36),
      pdfDocumentMessage(peer, 37),
    ].map((raw) => {
      const parsed = parseRawMessage(raw, 9)
      return [parsed?.message_type, parsed?.has_media]
    })

    expect(types).toEqual([
      ['voice', true],
      ['video', true],
      ['video', true],
      ['video', true],
      ['sticker', true],
      ['document', true],
    ])
  })

  it('types a dice as live updates do', () => {
    const dice = parseRawMessage(
      {
        _: 'message',
        id: 38,
        date: 1700000202,
        media: { _: 'messageMediaDice', value: 3, emoticon: '🎲' },
      },
      9,
    )
    expect(dice).toMatchObject({ message_type: 'dice', has_media: true })
  })
})
