import type { TelegramClient, tl } from '@mtcute/bun'

import { normalizeUsername } from './identifiers'

type TelegramClientLike = Pick<TelegramClient, 'call'>

export async function resolveUsername(
  client: TelegramClientLike,
  identifier: string,
): Promise<tl.contacts.TypeResolvedPeer> {
  const username = normalizeUsername(identifier)
  return client.call({
    _: 'contacts.resolveUsername',
    username,
  } satisfies tl.contacts.RawResolveUsernameRequest)
}
