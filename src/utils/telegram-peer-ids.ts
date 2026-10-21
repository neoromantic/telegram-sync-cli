import type { tl } from '@mtcute/bun'

export const CHANNEL_PEER_ID_OFFSET = 1_000_000_000_000

type RawPeerLike = {
  _?: string
  userId?: number
  chatId?: number
  channelId?: number
}

export function toPeerIdFromRawPeer(
  peer: RawPeerLike | null | undefined,
): number | null {
  if (!peer) return null
  switch (peer._) {
    case 'peerUser':
      return typeof peer.userId === 'number' ? peer.userId : null
    case 'peerChat':
      return typeof peer.chatId === 'number' ? -peer.chatId : null
    case 'peerChannel':
      return typeof peer.channelId === 'number'
        ? -CHANNEL_PEER_ID_OFFSET - peer.channelId
        : null
    default:
      return null
  }
}

/**
 * Marked peer ID for an input peer, in the same format as
 * `toPeerIdFromRawPeer`. `inputPeerSelf` carries no ID, so the caller passes
 * its own user ID.
 */
export function toPeerIdFromInputPeer(
  peer: tl.TypeInputPeer,
  selfId: number | null,
): number | null {
  switch (peer._) {
    case 'inputPeerSelf':
      return selfId
    case 'inputPeerUser':
    case 'inputPeerUserFromMessage':
      return toPeerIdFromRawPeer({ _: 'peerUser', userId: peer.userId })
    case 'inputPeerChat':
      return toPeerIdFromRawPeer({ _: 'peerChat', chatId: peer.chatId })
    case 'inputPeerChannel':
    case 'inputPeerChannelFromMessage':
      return toPeerIdFromRawPeer({
        _: 'peerChannel',
        channelId: peer.channelId,
      })
    default:
      return null
  }
}

export function toChannelIdFromPeerId(peerId: number): number {
  const abs = Math.abs(peerId)
  return abs > CHANNEL_PEER_ID_OFFSET ? abs - CHANNEL_PEER_ID_OFFSET : abs
}

export function getCandidateChatIds(peerId: number): number[] {
  const candidates = new Set<number>()
  candidates.add(peerId)

  if (peerId < 0) {
    const abs = Math.abs(peerId)
    candidates.add(abs)
    if (abs > CHANNEL_PEER_ID_OFFSET) {
      candidates.add(abs - CHANNEL_PEER_ID_OFFSET)
    }
  }

  return Array.from(candidates)
}
