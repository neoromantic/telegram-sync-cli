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
