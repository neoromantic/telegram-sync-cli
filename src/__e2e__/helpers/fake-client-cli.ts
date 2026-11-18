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
 * with the messages above it unread. messages.getHistory returns no
 * messages. FAKE_FLOOD_METHOD fails with a FLOOD_WAIT of
 * FAKE_FLOOD_SECONDS, a method of FAKE_INTERNAL_ERRORS with its
 * Telegram-side failure, and messages.sendMessage with PEER_ID_INVALID.
 * Any other method fails the way Telegram rejects an unknown one.
 */

/** This file, to pass as runCli's `entry` */
export const FAKE_CLIENT_CLI = import.meta.path

export const FAKE_CLIENT_DESTROYED = 'fake client: destroyed'

export const FAKE_CLIENT_CALL = 'fake client: call'

/** The newest message of every chat the fake client reads */
export const FAKE_TOP_MESSAGE = 30

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

if (import.meta.main) {
  // mock.module works in a plain `bun run` script too, not only in bun test
  const { mock } = await import('bun:test')
  const { tl } = await import('@mtcute/bun')
  const telegram = await import('../../services/telegram')

  // Never cleared, not even by destroy()
  setInterval(() => {}, 60_000)
  let readMaxId = 0
  const client = {
    async call(request: { _: string; maxId?: number }) {
      if (request._ === 'help.getConfig') return FAKE_CONFIG
      if (request._ === 'messages.getHistory') {
        return {
          _: 'messages.messages',
          messages: [],
          chats: [],
          users: [],
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
