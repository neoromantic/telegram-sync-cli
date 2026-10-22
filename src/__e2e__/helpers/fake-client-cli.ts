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
 * help.getConfig returns FAKE_CONFIG; any other method fails the way
 * Telegram rejects an unknown one.
 */

/** This file, to pass as runCli's `entry` */
export const FAKE_CLIENT_CLI = import.meta.path

export const FAKE_CLIENT_DESTROYED = 'fake client: destroyed'

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
  const telegram = await import('../../services/telegram')

  // Never cleared, not even by destroy()
  setInterval(() => {}, 60_000)
  const client = {
    async call(request: { _: string }) {
      if (request._ === 'help.getConfig') return FAKE_CONFIG
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
