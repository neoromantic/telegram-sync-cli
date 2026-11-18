/**
 * Runs the tg CLI (src/index.ts) with a fake Telegram client in place of
 * mtcute's, for api.e2e.test.ts. Pass it as `entry` to runCli.
 *
 * The fake client keeps the process alive even after destroy(), which
 * prints FAKE_CLIENT_DESTROYED to stderr: a connected mtcute client might
 * leave a handle open after it is closed, and that can't be checked
 * offline. So tg api ends only through an explicit exit, as raw(),
 * success() and error() do.
 *
 * help.getConfig returns FAKE_CONFIG. messages.readHistory and
 * channels.readHistory mark the chat read and print FAKE_CLIENT_CALL with
 * the method and max_id to stderr; messages.getPeerDialogs then returns a
 * dialog read up to that max_id, or to FAKE_TOP_MESSAGE for 0 (everything),
 * with the messages above it unread. messages.getMessages finds the
 * messages of FAKE_MESSAGE_CHATS and returns messageEmpty for any other ID;
 * channels.getMessages finds every ID but FAKE_GONE_MESSAGE; neither finds
 * a message once it is deleted. messages.deleteMessages and
 * channels.deleteMessages print FAKE_CLIENT_CALL with the IDs and delete
 * and count every ID, except that FAKE_UNDELETABLE_MESSAGE fails with
 * MESSAGE_DELETE_FORBIDDEN, FAKE_GONE_MESSAGE is not counted and
 * FAKE_KEPT_MESSAGE is neither deleted nor counted. FAKE_FLOOD_METHOD fails with a
 * FLOOD_WAIT of FAKE_FLOOD_SECONDS, a method of FAKE_INTERNAL_ERRORS with
 * its Telegram-side failure, and messages.sendMessage with
 * PEER_ID_INVALID. Any other method fails the way Telegram rejects an
 * unknown one.
 */

/** This file, to pass as runCli's `entry` */
export const FAKE_CLIENT_CLI = import.meta.path

export const FAKE_CLIENT_DESTROYED = 'fake client: destroyed'

export const FAKE_CLIENT_CALL = 'fake client: call'

/** The newest message of every chat the fake client reads */
export const FAKE_TOP_MESSAGE = 30

/** The account the fake client is signed in as */
export const FAKE_SELF_ID = 999

/** The messages messages.getMessages finds: message ID to marked chat ID */
export const FAKE_MESSAGE_CHATS: Record<number, number> = {
  12: 10,
  13: 10,
  9: 10,
  40: 20,
  3: -4242,
  7: FAKE_SELF_ID,
}

/** A message delete refuses with MESSAGE_DELETE_FORBIDDEN */
export const FAKE_UNDELETABLE_MESSAGE = 9

/** A message already gone: a delete succeeds but does not count it */
export const FAKE_GONE_MESSAGE = 26

/** A message a delete leaves in place without an error, and does not count */
export const FAKE_KEPT_MESSAGE = 27

/** The method Telegram answers with FLOOD_WAIT_<FAKE_FLOOD_SECONDS> */
export const FAKE_FLOOD_METHOD = 'help.getNearestDc'

export const FAKE_FLOOD_SECONDS = 42

/** Methods Telegram fails on its side, with the error code and text */
export const FAKE_INTERNAL_ERRORS: Record<string, [number, string]> = {
  'help.getAppConfig': [500, 'INTERNAL'],
  'help.getCdnConfig': [-503, 'Timeout'],
}

/** A made-up help.getConfig result */
export const FAKE_CONFIG = {
  _: 'config',
  date: 1700000000,
  expires: 1700003600,
  testMode: false,
  thisDc: 2,
  dcOptions: [],
  chatSizeMax: 200,
}

interface FakeInputPeer {
  _: string
  userId?: number
  chatId?: number
  channelId?: number
}

/** The peer a message of this input peer carries */
function fakePeer(peer: FakeInputPeer | null | undefined) {
  if (peer?._ === 'inputPeerChannel') {
    return { _: 'peerChannel', channelId: peer.channelId }
  }
  if (peer?._ === 'inputPeerChat') {
    return { _: 'peerChat', chatId: peer.chatId }
  }
  return { _: 'peerUser', userId: peer?.userId ?? FAKE_SELF_ID }
}

if (import.meta.main) {
  // mock.module works in a plain `bun run` script too, not only in bun test
  const { mock } = await import('bun:test')
  const { tl } = await import('@mtcute/bun')
  const telegram = await import('../../services/telegram')
  const { toInputPeerFromPeerId } = await import(
    '../../utils/telegram-peer-ids'
  )

  // Never cleared, not even by destroy()
  setInterval(() => {}, 60_000)
  let readMaxId = 0
  const deleted = new Set<number>()
  const client = {
    async call(request: {
      _: string
      maxId?: number
      id?: Array<number | { id: number }>
      revoke?: boolean
      channel?: { channelId: number }
    }) {
      if (request._ === 'help.getConfig') return FAKE_CONFIG
      if (
        request._ === 'messages.getMessages' ||
        request._ === 'channels.getMessages'
      ) {
        const ids = (request.id ?? []).map((item) =>
          typeof item === 'number' ? item : item.id,
        )
        console.error(
          `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: request._, id: ids })}`,
        )
        const channel = request.channel
        return {
          _: 'messages.messages',
          messages: ids.map((id) => {
            const chatId = FAKE_MESSAGE_CHATS[id]
            const found = channel
              ? id !== FAKE_GONE_MESSAGE
              : chatId !== undefined
            if (!found || deleted.has(id)) return { _: 'messageEmpty', id }
            return {
              _: 'message',
              id,
              peerId: channel
                ? { _: 'peerChannel', channelId: channel.channelId }
                : fakePeer(toInputPeerFromPeerId(chatId as number, null)),
              date: 1_760_000_000,
              message: 'A made-up message.',
            }
          }),
          chats: [],
          users: [],
        }
      }
      if (
        request._ === 'messages.deleteMessages' ||
        request._ === 'channels.deleteMessages'
      ) {
        const ids = (request.id ?? []) as number[]
        console.error(
          `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: request._, id: ids, revoke: request.revoke })}`,
        )
        if (ids.includes(FAKE_UNDELETABLE_MESSAGE)) {
          throw tl.RpcError.fromTl({
            _: 'rpc_error',
            errorCode: 403,
            errorMessage: 'MESSAGE_DELETE_FORBIDDEN',
          })
        }
        const removed = ids.filter(
          (id) => id !== FAKE_GONE_MESSAGE && id !== FAKE_KEPT_MESSAGE,
        )
        for (const id of removed) deleted.add(id)
        return {
          _: 'messages.affectedMessages',
          pts: 1,
          ptsCount: removed.length,
        }
      }
      if (
        request._ === 'messages.readHistory' ||
        request._ === 'channels.readHistory'
      ) {
        console.error(
          `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: request._, maxId: request.maxId })}`,
        )
        readMaxId = request.maxId ?? 0
        return request._ === 'channels.readHistory'
          ? true
          : { _: 'messages.affectedMessages', pts: 1, ptsCount: 1 }
      }
      if (request._ === 'messages.getPeerDialogs') {
        const boundary = readMaxId || FAKE_TOP_MESSAGE
        return {
          _: 'messages.peerDialogs',
          dialogs: [
            {
              _: 'dialog',
              peer: { _: 'peerUser', userId: 1 },
              topMessage: FAKE_TOP_MESSAGE,
              readInboxMaxId: boundary,
              unreadCount: FAKE_TOP_MESSAGE - boundary,
            },
          ],
          messages: [],
          chats: [],
          users: [],
        }
      }
      if (request._ === FAKE_FLOOD_METHOD) {
        throw tl.RpcError.fromTl({
          _: 'rpc_error',
          errorCode: 420,
          errorMessage: `FLOOD_WAIT_${FAKE_FLOOD_SECONDS}`,
        })
      }
      const internal = FAKE_INTERNAL_ERRORS[request._]
      if (internal) {
        throw tl.RpcError.fromTl({
          _: 'rpc_error',
          errorCode: internal[0],
          errorMessage: internal[1],
        })
      }
      if (request._ === 'messages.sendMessage') {
        throw tl.RpcError.fromTl({
          _: 'rpc_error',
          errorCode: 400,
          errorMessage: 'PEER_ID_INVALID',
        })
      }
      throw Object.assign(new Error('METHOD_INVALID'), { code: 400 })
    },
    // Real destroy() closes the connection and saves the session
    // asynchronously, so the marker comes only after an await: a caller that
    // exits without awaiting destroy() never prints it
    async destroy() {
      await Bun.sleep(20)
      console.error(FAKE_CLIENT_DESTROYED)
    },
  }

  mock.module('../../services/telegram', () => ({
    ...telegram,
    getClientForAccount: () => client,
  }))

  await import('../../index')
}
