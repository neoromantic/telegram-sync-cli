import { describe, expect, it } from 'bun:test'
import { getMarkedPeerId, parseMarkedPeerId } from '@mtcute/bun'
import Long from 'long'
import {
  legacyChatIdCandidates,
  toInputPeerFromPeerId,
  toMarkedPeerId,
  toPeerIdFromRawChat,
  toPeerIdFromRawPeer,
  toRawPeerId,
} from '../utils/telegram-peer-ids'

/** Bare IDs of each chat type, boundaries included */
const SAMPLES = [
  { type: 'private', raw: 1001, marked: 1001 },
  { type: 'group', raw: 4001, marked: -4001 },
  { type: 'group', raw: 1, marked: -1 },
  { type: 'group', raw: 999_999_999_999, marked: -999_999_999_999 },
  { type: 'supergroup', raw: 1234567890, marked: -1001234567890 },
  { type: 'channel', raw: 1, marked: -1_000_000_000_001 },
  { type: 'channel', raw: 9876543210, marked: -1009876543210 },
  { type: 'community', raw: 5555555555, marked: -1005555555555 },
] as const

const RAW_PEERS = SAMPLES.map(({ type, raw }) =>
  type === 'private'
    ? ({ _: 'peerUser', userId: raw } as const)
    : type === 'group'
      ? ({ _: 'peerChat', chatId: raw } as const)
      : ({ _: 'peerChannel', channelId: raw } as const),
)

describe('toMarkedPeerId', () => {
  it('marks bare IDs the way the cache tables store them', () => {
    for (const { type, raw, marked } of SAMPLES) {
      expect(toMarkedPeerId(raw, type)).toBe(marked)
    }
  })

  it('matches the IDs built from raw peers', () => {
    expect(toPeerIdFromRawPeer({ _: 'peerChat', chatId: 4001 })).toBe(
      toMarkedPeerId(4001, 'group'),
    )
    expect(
      toPeerIdFromRawPeer({ _: 'peerChannel', channelId: 1234567890 }),
    ).toBe(toMarkedPeerId(1234567890, 'channel'))
  })
})

describe('toRawPeerId', () => {
  it('inverts toMarkedPeerId for every chat type and boundary', () => {
    for (const { type, raw, marked } of SAMPLES) {
      expect(toRawPeerId(toMarkedPeerId(raw, type))).toBe(raw)
      expect(toRawPeerId(marked)).toBe(raw)
    }
    expect(toRawPeerId(-999_999_999_999)).toBe(999_999_999_999)
    expect(toRawPeerId(-1_000_000_000_001)).toBe(1)
  })

  it('names no peer for 0 and -1000000000000', () => {
    expect(toRawPeerId(0)).toBeNull()
    expect(toRawPeerId(-1_000_000_000_000)).toBeNull()
    expect(toRawPeerId(1.5)).toBeNull()
  })
})

describe('toPeerIdFromRawChat', () => {
  it('marks every kind of raw user and chat', () => {
    expect(toPeerIdFromRawChat({ _: 'user', id: 1001 })).toBe(1001)
    expect(toPeerIdFromRawChat({ _: 'chat', id: 4001 })).toBe(-4001)
    expect(toPeerIdFromRawChat({ _: 'chatForbidden', id: 4001 })).toBe(-4001)
    expect(toPeerIdFromRawChat({ _: 'channel', id: 1234567890 })).toBe(
      -1001234567890,
    )
    expect(toPeerIdFromRawChat({ _: 'channelForbidden', id: 1234567890 })).toBe(
      -1001234567890,
    )
    expect(toPeerIdFromRawChat({ _: 'community', id: 1234567890 })).toBe(
      -1001234567890,
    )
    expect(
      toPeerIdFromRawChat({ _: 'communityForbidden', id: 1234567890 }),
    ).toBe(-1001234567890)
  })

  it('gives null for anything else', () => {
    expect(toPeerIdFromRawChat({ _: 'chatEmpty', id: 4001 })).toBeNull()
    expect(toPeerIdFromRawChat({ _: 'dialog' })).toBeNull()
    expect(toPeerIdFromRawChat({})).toBeNull()
    expect(toPeerIdFromRawChat(null)).toBeNull()
  })
})

describe('toInputPeerFromPeerId', () => {
  it('builds a user peer, with and without an access hash', () => {
    expect(toInputPeerFromPeerId(1001, '777')).toEqual({
      _: 'inputPeerUser',
      userId: 1001,
      accessHash: Long.fromInt(777),
    })
    expect(toInputPeerFromPeerId(1001, null)).toEqual({
      _: 'inputPeerUser',
      userId: 1001,
      accessHash: Long.fromInt(0),
    })
  })

  it('builds a basic group peer, which needs no access hash', () => {
    expect(toInputPeerFromPeerId(-4001, null)).toEqual({
      _: 'inputPeerChat',
      chatId: 4001,
    })
    expect(toInputPeerFromPeerId(-4001, '777')).toEqual({
      _: 'inputPeerChat',
      chatId: 4001,
    })
  })

  it('builds a channel peer with the bare channel ID', () => {
    expect(toInputPeerFromPeerId(-1001234567890, '777')).toEqual({
      _: 'inputPeerChannel',
      channelId: 1234567890,
      accessHash: Long.fromInt(777),
    })
    expect(toInputPeerFromPeerId(-1001234567890, null)).toEqual({
      _: 'inputPeerChannel',
      channelId: 1234567890,
      accessHash: Long.fromInt(0),
    })
  })

  it('rejects 0 and -1000000000000', () => {
    expect(toInputPeerFromPeerId(0, null)).toBeNull()
    expect(toInputPeerFromPeerId(-1_000_000_000_000, '777')).toBeNull()
  })
})

describe('legacyChatIdCandidates', () => {
  it('gives the basic group and the channel that 0.2.0 printed as N', () => {
    expect(legacyChatIdCandidates(4242)).toEqual([-4242, -1000000004242])
    expect(legacyChatIdCandidates(1234567890)).toEqual([
      -1234567890, -1001234567890,
    ])
  })

  it('gives only the channel for a number too large for a basic group', () => {
    expect(legacyChatIdCandidates(1_000_000_000_000)).toEqual([
      -2_000_000_000_000,
    ])
  })

  it('gives nothing for a number that is not a bare ID', () => {
    expect(legacyChatIdCandidates(0)).toEqual([])
    expect(legacyChatIdCandidates(-4242)).toEqual([])
    expect(legacyChatIdCandidates(1.5)).toEqual([])
  })
})

describe('agreement with mtcute', () => {
  it('marks raw peers like getMarkedPeerId', () => {
    for (const peer of RAW_PEERS) {
      expect(toPeerIdFromRawPeer(peer)).toBe(getMarkedPeerId(peer))
    }
  })

  it('marks bare IDs and reads them back like mtcute', () => {
    for (const { type, raw } of SAMPLES) {
      const marked = toMarkedPeerId(raw, type)
      const mtcuteType =
        type === 'private' ? 'user' : type === 'group' ? 'chat' : 'channel'
      expect(marked).toBe(getMarkedPeerId(raw, mtcuteType))
      expect(parseMarkedPeerId(marked)).toEqual([mtcuteType, raw])
      expect(toRawPeerId(marked)).toBe(parseMarkedPeerId(marked)[1])
    }
  })

  it('builds the input peers whose marked ID mtcute reads back', () => {
    for (const { marked } of SAMPLES) {
      const peer = toInputPeerFromPeerId(marked, '777')
      expect(peer).not.toBeNull()
      expect(getMarkedPeerId(peer!)).toBe(marked)
    }
  })
})
