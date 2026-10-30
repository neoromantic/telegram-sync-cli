/**
 * Fake mtcute dialogs and a client that lists them, for dialog pass tests.
 * Only the fields the daemon reads are filled in.
 */
import {
  Chat,
  Dialog,
  PeersIndex,
  type RpcCallOptions,
  type TelegramClient,
  type tl,
} from '@mtcute/bun'

import { toLong } from '../../utils/long'
import { waitLikeFloodWait } from './flood-wait'

export interface FakeDialogInput {
  kind: 'user' | 'group' | 'supergroup' | 'channel'
  /** Raw ID: user ID, basic group ID or channel ID */
  id: number
  title?: string
  username?: string
  membersCount?: number | null
  topMessage?: number
  archived?: boolean
  /** A user dialog with a bot */
  bot?: boolean
  /** A user dialog with a deleted account */
  deleted?: boolean
  /** The dialog's newest message, as the dialog list carries it */
  lastMessage?: { id: number; text?: string; date?: number }
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
          raw: {
            _: 'user',
            id,
            firstName: title,
            accessHash: 777,
            bot: input.bot,
            deleted: input.deleted,
          },
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

  const last = input.lastMessage
  return {
    raw: { _: 'dialog', peer: rawPeer, topMessage: input.topMessage ?? 0 },
    peer,
    lastMessage: last
      ? {
          raw: {
            _: 'message',
            id: last.id,
            peerId: rawPeer,
            message: last.text ?? '',
            date: last.date ?? 1_700_000_000,
          },
          date: new Date((last.date ?? 1_700_000_000) * 1000),
        }
      : null,
    isArchived: input.archived ?? false,
  } as unknown as Dialog
}

export interface CommunityDialogInput {
  /** Raw community ID, a channel ID */
  id: number
  title?: string
  accessHash: string
}

/**
 * A real mtcute Dialog for a community, so `peer.chatType` is what mtcute
 * reports. It always has an access hash: `lastMessage` reads `peer.id`,
 * which throws without one.
 */
export function communityDialog({
  id,
  title = 'Example Community',
  accessHash,
}: CommunityDialogInput): Dialog {
  return new Dialog(
    {
      _: 'dialog',
      peer: { _: 'peerChannel', channelId: id },
      topMessage: 0,
      readInboxMaxId: 0,
      readOutboxMaxId: 0,
      unreadCount: 0,
      unreadMentionsCount: 0,
      unreadReactionsCount: 0,
      notifySettings: { _: 'peerNotifySettings' },
    } as tl.RawDialog,
    PeersIndex.from({
      users: [],
      chats: [fakeRawCommunity({ id, title, accessHash })],
    }),
    new Map(),
  )
}

export interface FakeDialogClientOptions {
  /** Throw after listing this many dialogs */
  failAfter?: number
  /** What `failAfter` throws, FLOOD_WAIT_600 by default */
  error?: Error
  /** Called when the pass asks for the dialog after the `count`th one */
  onListed?: (count: number) => void
  /**
   * After listing this many dialogs, the next page waits like a FLOOD_WAIT
   * until the `abortSignal` given to `withParams` aborts
   */
  waitAfter?: number
  /** Called on a timer once that wait has started */
  onWait?: () => void
  /** What `getJoinedCommunities` lists, none by default */
  communities?: FakeCommunityInput[]
  /** What `getJoinedCommunities` throws */
  communitiesError?: Error
  /**
   * `getJoinedCommunities` waits like a FLOOD_WAIT until the `abortSignal`
   * given to `withParams` aborts; `onWait` is called once the wait started
   */
  communitiesWaitUntilAbort?: boolean
}

export interface FakeCommunityInput {
  /** Raw community ID, a channel ID */
  id: number
  title?: string
  accessHash: string
  /** Listed as communityForbidden */
  forbidden?: boolean
}

/** A raw community as `communities.getJoinedCommunities` lists it */
export function fakeRawCommunity({
  id,
  title = 'Example Community',
  accessHash,
  forbidden = false,
}: FakeCommunityInput): tl.RawCommunity | tl.RawCommunityForbidden {
  return forbidden
    ? { _: 'communityForbidden', id, accessHash: toLong(accessHash), title }
    : {
        _: 'community',
        id,
        accessHash: toLong(accessHash),
        title,
        photo: { _: 'chatPhotoEmpty' },
        date: 1_700_000_000,
      }
}

/**
 * A client whose `iterDialogs` lists the given dialogs and whose
 * `getJoinedCommunities` lists `options.communities`. `withParams` returns
 * one whose methods make their requests with those params, as mtcute's does.
 */
export function fakeDialogClient(
  dialogs: FakeDialogInput[],
  options: FakeDialogClientOptions = {},
) {
  const calls: unknown[] = []
  const params: RpcCallOptions[] = []
  const communityCalls: (RpcCallOptions | undefined)[] = []

  const nextPage = (callParams: RpcCallOptions | undefined) =>
    waitLikeFloodWait(callParams, { onWait: options.onWait })

  function iterDialogsWith(callParams?: RpcCallOptions) {
    return async function* iterDialogs(iterParams?: unknown) {
      calls.push(iterParams)
      let listed = 0
      for (const input of dialogs) {
        if (listed === options.waitAfter) await nextPage(callParams)
        if (options.failAfter !== undefined && listed >= options.failAfter) {
          throw options.error ?? new Error('FLOOD_WAIT_600')
        }
        yield fakeDialog(input)
        listed++
        options.onListed?.(listed)
      }
      // The page after the last dialog
      if (listed === options.waitAfter) await nextPage(callParams)
    }
  }

  function getJoinedCommunitiesWith(callParams?: RpcCallOptions) {
    return async function getJoinedCommunities(): Promise<Chat[]> {
      communityCalls.push(callParams)
      if (options.communitiesWaitUntilAbort) await nextPage(callParams)
      if (options.communitiesError) throw options.communitiesError
      return (options.communities ?? []).map(
        (input) => new Chat(fakeRawCommunity(input)),
      )
    }
  }

  const client = {
    iterDialogs: iterDialogsWith(),
    getJoinedCommunities: getJoinedCommunitiesWith(),
    withParams(callParams: RpcCallOptions) {
      params.push(callParams)
      return {
        ...client,
        iterDialogs: iterDialogsWith(callParams),
        getJoinedCommunities: getJoinedCommunitiesWith(callParams),
      }
    },
  }

  return {
    client: client as unknown as TelegramClient,
    /** Params of every `iterDialogs` call */
    calls,
    /** Params of every `withParams` call */
    params,
    /** Call params of every `getJoinedCommunities` call */
    communityCalls,
  }
}
