import { BunPlatform } from "@mtcute/bun";

const closeOnExit = new Set<() => void>();
let exitListenerInstalled = false;

function closeSessionsOnExit(): void {
  for (const close of closeOnExit) {
    try {
      close();
    } catch (err) {
      console.error(`Failed to save a session file on exit: ${err}`);
    }
  }
}

export class DaemonPlatform extends BunPlatform {
  override beforeExit = (fn: () => void): (() => void) => {
    if (!exitListenerInstalled) {
      exitListenerInstalled = true;
      process.once("exit", closeSessionsOnExit);
    }
    closeOnExit.add(fn);
    return () => {
      closeOnExit.delete(fn);
    };
  };
}

export const daemonPlatform = new DaemonPlatform();
