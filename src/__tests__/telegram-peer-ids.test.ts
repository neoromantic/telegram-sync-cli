import { describe, expect, it } from 'bun:test'
import {
  getCandidateChatIds,
  toMarkedPeerId,
  toPeerIdFromRawPeer,
} from '../utils/telegram-peer-ids'

describe('toMarkedPeerId', () => {
  it('marks raw IDs the way the sync tables store them', () => {
    expect(toMarkedPeerId(1001, 'private')).toBe(1001)
    expect(toMarkedPeerId(4001, 'group')).toBe(-4001)
    expect(toMarkedPeerId(1234567890, 'supergroup')).toBe(-1001234567890)
    expect(toMarkedPeerId(1234567890, 'channel')).toBe(-1001234567890)
  })

  it('matches the IDs built from raw peers', () => {
    expect(toPeerIdFromRawPeer({ _: 'peerChat', chatId: 4001 })).toBe(
      toMarkedPeerId(4001, 'group'),
    )
    expect(
      toPeerIdFromRawPeer({ _: 'peerChannel', channelId: 1234567890 }),
    ).toBe(toMarkedPeerId(1234567890, 'channel'))
  })

  it('maps back to the raw ID through the candidates', () => {
    expect(
      getCandidateChatIds(toMarkedPeerId(1234567890, 'channel')),
    ).toContain(1234567890)
    expect(getCandidateChatIds(toMarkedPeerId(4001, 'group'))).toContain(4001)
  })
})
