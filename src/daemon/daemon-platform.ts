/**
 * The mtcute platform of the daemon's clients (#56). It imports nothing but
 * BunPlatform, so a child process in the tests loads it without the db code.
 *
 * mtcute's session storage and its sqlite driver register a cleanup through
 * `platform.beforeExit`. Bun's stock one turns that into process listeners
 * for SIGINT and SIGTERM, which saved and closed every session file the
 * moment a signal arrived, under clients that were still running, then sent
 * the signal again (so the daemon logged "Received SIGTERM" twice). Writes
 * queued after that failed: the updates loop couldn't save its state, peers
 * from a running sync job were lost, and destroy() threw "Database has
 * closed".
 *
 * Here the cleanups run only on process exit. The daemon closes every client
 * on a stop, and destroy() saves, closes the session file and unregisters its
 * cleanup, so a callback still registered at exit means the stop didn't get
 * that far: the shutdown timeout's process.exit(1), a crash, or a client
 * created after the cleanup. The callbacks are synchronous, so they still
 * save what was queued.
 *
 * The device model, logger and log level stay Bun's, so the session's entry
 * in Telegram's active sessions doesn't change. CLI clients keep the stock
 * platform.
 */
import { BunPlatform } from '@mtcute/bun'

const closeOnExit = new Set<() => void>()
let exitListenerInstalled = false

function closeSessionsOnExit(): void {
  // A driver's cleanup removes itself from the set, which is safe mid-loop
  for (const close of closeOnExit) {
    try {
      close()
    } catch (err) {
      console.error(`Failed to save a session file on exit: ${err}`)
    }
  }
}

export class DaemonPlatform extends BunPlatform {
  override beforeExit = (fn: () => void): (() => void) => {
    // One listener for the process: with 5 accounts, two callbacks each, a
    // listener per callback would pass Node's MaxListeners warning
    if (!exitListenerInstalled) {
      exitListenerInstalled = true
      process.once('exit', closeSessionsOnExit)
    }
    closeOnExit.add(fn)
    return () => {
      closeOnExit.delete(fn)
    }
  }
}

export const daemonPlatform = new DaemonPlatform()
