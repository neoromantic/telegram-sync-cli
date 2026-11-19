import { mock } from "bun:test";
import * as mtcute from "@mtcute/bun";

class FakeEmitter<T> {
  handlers: Array<(value: T) => void> = [];
  add(handler: (value: T) => void) {
    this.handlers.push(handler);
  }
  remove(handler: (value: T) => void) {
    this.handlers = this.handlers.filter((entry) => entry !== handler);
  }
  emit(value: T) {
    for (const handler of this.handlers) handler(value);
  }
}

export interface FakeTelegramOptions {
  /** What `start` throws for an account the test gave no client */
  connectError?: () => Error;
  /** Called when the daemon closes an account's client */
  onDestroy?: (accountId: number) => void;
}

/**
 * Replace mtcute's `TelegramClient`, the MTProto network boundary, with a
 * fake. The client for `session_<id>.db` is the one the test put in
 * `clients` for account `id`, completed with what the daemon calls on every
 * client; an account without one fails to connect.
 */
export function fakeTelegramClients(options: FakeTelegramOptions = {}) {
  const created: number[] = [];
  const clients = new Map<number, object>();

  function FakeTelegramClient(clientOptions: { storage: string }) {
    const accountId = Number(/session_(\d+)\.db$/.exec(clientOptions.storage)?.[1]);
    created.push(accountId);
    const given = clients.get(accountId);
    return Object.assign(
      {
        log: { mgr: { level: 0, handler: () => {} } },
        onError: new FakeEmitter<Error>(),
        onNewMessage: new FakeEmitter<unknown>(),
        onEditMessage: new FakeEmitter<unknown>(),
        onDeleteMessage: new FakeEmitter<unknown>(),
        onRawUpdate: new FakeEmitter<unknown>(),
        onConnectionState: new FakeEmitter<string>(),
        async start() {
          if (!given) throw options.connectError?.() ?? new Error("Connection timed out");
        },
        async getMe() {
          return { id: 5_550_000 + accountId, username: null };
        },
        async startUpdatesLoop() {},
        async destroy() {
          options.onDestroy?.(accountId);
        },
      },
      given,
    );
  }

  mock.module("@mtcute/bun", () => ({ ...mtcute, TelegramClient: FakeTelegramClient }));

  return { created, clients };
}
