/**
 * Tests for sync worker real helpers
 */
import { describe, expect, it } from 'bun:test'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'

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

    expect(page.map((message) => message?.from_id)).toEqual([
      111,
      -222,
      -1000000000333,
      null,
    ])
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
  })

  it('maps media types and sets has_media', () => {
    const location = parseRawMessage(
      {
        _: 'message',
        id: 30,
        date: 1700000200,
        media: { _: 'messageMediaGeoLive' },
      },
      9,
    )

    const unknown = parseRawMessage(
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
    expect(unknown?.message_type).toBe('media')
    expect(unknown?.has_media).toBe(true)
  })
})
