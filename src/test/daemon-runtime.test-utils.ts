import type { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import {
  type AccountRuntime,
  createDaemonRuntime,
  type DaemonContext,
} from "../daemon/daemon-context";
import { createLogger } from "../daemon/daemon-logger";
import { createPidFile } from "../daemon/pid-file";
import { createSyncPacer } from "../daemon/sync-pacing";
import { createDaemonStatusService } from "../db/daemon-status";
import { createSeededAccountsDb } from "./accounts.test-utils";
import { createAccountCacheDb } from "./cache-db.test-utils";

/**
 * The daemon's quiet logger, each level watched by a spy that records the
 * message and still runs the logger: only warnings and errors are printed
 */
export function watchedLogger() {
  const logger = createLogger("quiet");
  return {
    info: spyOn(logger, "info"),
    debug: spyOn(logger, "debug"),
    warn: spyOn(logger, "warn"),
    error: spyOn(logger, "error"),
  };
}

/** A daemon context with no accounts, a watched logger and an unused PID file */
export function testDaemonContext(overrides: Partial<Omit<DaemonContext, "logger">> = {}) {
  const result: DaemonContext & { logger: ReturnType<typeof watchedLogger> } = {
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
    logger: watchedLogger(),
    pidFile: createPidFile("/tmp/tgcli/daemon.pid"),
    state: { running: true, accounts: new Map(), shutdownRequested: false },
    accountsDb: createSeededAccountsDb([]),
    runtime: createDaemonRuntime(),
    ...overrides,
  };
  return result;
}

/** Give the context a runtime for the account, on its own cache */
export function addAccountRuntime(
  ctx: DaemonContext,
  accountId: number,
  db: Database = createAccountCacheDb(),
  overrides: Partial<AccountRuntime> = {},
) {
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
