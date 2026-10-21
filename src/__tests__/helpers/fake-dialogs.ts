/**
 * Fake mtcute dialogs and a client that lists them, for dialog pass tests.
 * Only the fields the daemon reads are filled in.
 */
import type { Dialog, TelegramClient } from '@mtcute/bun'

export interface FakeDialogInput {
  kind: 'user' | 'group' | 'supergroup' | 'channel'
  /** Raw ID: user ID, basic group ID or channel ID */
  id: number
  title?: string
  username?: string
  membersCount?: number | null
  topMessage?: number
  archived?: boolean
}

export function fakeDialog(input: FakeDialogInput): Dialog {
  const { kind, id } = input
  const title = input.title ?? `Chat ${id}`

  const rawPeer =
    kind === 'user'
      ? { _: 'peerUser', userId: id }
      : kind === 'group'
        ? { _: 'peerChat', chatId: id }
        : { _: 'peerChannel', channelId: id }

  const peer =
    kind === 'user'
      ? {
          type: 'user',
          displayName: title,
          username: input.username ?? null,
          raw: { _: 'user', id, firstName: title, accessHash: 777 },
        }
      : {
          type: 'chat',
          chatType: kind,
          title,
          username: input.username ?? null,
          membersCount: input.membersCount ?? null,
          raw:
            kind === 'group'
              ? { _: 'chat', id }
              : { _: 'channel', id, accessHash: 777 },
          isCreator: false,
          isAdmin: false,
        }

  return {
    raw: { _: 'dialog', peer: rawPeer, topMessage: input.topMessage ?? 0 },
    peer,
    lastMessage: null,
    isArchived: input.archived ?? false,
  } as unknown as Dialog
}

export interface FakeDialogClientOptions {
  /** Throw after listing this many dialogs */
  failAfter?: number
}

/** A client whose `iterDialogs` lists the given dialogs */
export function fakeDialogClient(
  dialogs: FakeDialogInput[],
  options: FakeDialogClientOptions = {},
) {
  const calls: unknown[] = []

  async function* iterDialogs(params?: unknown) {
    calls.push(params)
    let listed = 0
    for (const input of dialogs) {
      if (options.failAfter !== undefined && listed >= options.failAfter) {
        throw new Error('FLOOD_WAIT_600')
      }
      yield fakeDialog(input)
      listed++
    }
  }

  return {
    client: { iterDialogs } as unknown as TelegramClient,
    /** Params of every `iterDialogs` call */
    calls,
  }
}
