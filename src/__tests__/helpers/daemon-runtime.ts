import type { Database } from "bun:sqlite";
import { type Mock, mock } from "bun:test";
import {
  type AccountRuntime,
  createDaemonRuntime,
  type DaemonContext,
} from "../../daemon/daemon-context";
import { createSyncPacer } from "../../daemon/sync-pacing";
import { createDaemonStatusService } from "../../db/daemon-status";
import { createAccountCacheDb } from "./cache-db";
import { createFakeAccountsDb } from "./db-mock";

type LogFn = Mock<(message: string) => void>;

/** A daemon context with no accounts, mock loggers and a no-op PID file */
export function testDaemonContext(
  overrides: Partial<Omit<DaemonContext, "logger">> = {},
): DaemonContext & {
  logger: { info: LogFn; debug: LogFn; warn: LogFn; error: LogFn };
} {
  return {
    dataDir: "/tmp/tgcli",
    pidPath: "/tmp/tgcli/daemon.pid",
    verbosity: "normal",
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 3,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: {
      info: mock((_message: string) => {}),
      debug: mock((_message: string) => {}),
      warn: mock((_message: string) => {}),
      error: mock((_message: string) => {}),
    },
    pidFile: {
      acquire: () => {},
      release: () => {},
      read: () => null,
      isRunning: () => false,
      sendSignal: () => false,
      getPath: () => "/tmp/tgcli/daemon.pid",
    },
    state: { running: true, accounts: new Map(), shutdownRequested: false },
    accountsDb: createFakeAccountsDb([]),
    runtime: createDaemonRuntime(),
    ...overrides,
  };
}

/** Give the context a runtime for the account, on its own cache */
export function addAccountRuntime(
  ctx: DaemonContext,
  accountId: number,
  db: Database = createAccountCacheDb(),
  overrides: Partial<AccountRuntime> = {},
): AccountRuntime {
  const rt: AccountRuntime = {
    accountId,
    db,
    statusService: createDaemonStatusService(db),
    scheduler: null,
    worker: null,
    pacer: createSyncPacer(),
    messagesSynced: 0,
    ...overrides,
  };
  ctx.runtime.accounts.set(accountId, rt);
  return rt;
}
