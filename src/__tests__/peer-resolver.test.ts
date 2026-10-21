import { describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'

import { resolvePeer } from '../commands/send/peer-resolver'
import type { ChatsCache } from '../db/chats-cache'
import type { UsersCache } from '../db/users-cache'

describe('resolvePeer', () => {
  it.each(['me', 'self', ' Me '])(
    'resolves %p to Saved Messages without an API call',
    async (identifier) => {
      const call = mock(async () => {
        throw new Error('unexpected API call')
      })
      const client = { call } as unknown as Pick<TelegramClient, 'call'>

      const peer = await resolvePeer(
        client,
        identifier,
        {} as UsersCache,
        {} as ChatsCache,
      )

      expect(peer).toEqual({
        inputPeer: { _: 'inputPeerSelf' },
        name: 'Saved Messages',
      })
      expect(call).not.toHaveBeenCalled()
    },
  )
})
