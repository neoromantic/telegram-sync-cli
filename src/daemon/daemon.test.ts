import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, createDaemon } from "./daemon";
import { createLogger } from "./daemon-logger";
import { DaemonExitCode } from "./types";
import { getDefaultRetentionConfig } from "../db/types";
import { createSeededAccountsDb, testAccount } from "../test/accounts.test-utils";

const tempDir = join(process.cwd(), ".tmp", "daemon-tests");
const pidPath = join(tempDir, `daemon-${process.pid}.pid`);

const originalCredentials = {
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
};

function setEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function withCredentials(apiId: string | undefined, apiHash: string | undefined) {
  setEnv("TELEGRAM_API_ID", apiId);
  setEnv("TELEGRAM_API_HASH", apiHash);
}

afterEach(() => {
  rmSync(pidPath, { force: true });
  withCredentials(originalCredentials.apiId, originalCredentials.apiHash);
});

describe("daemon start", () => {
  it("returns AlreadyRunning when PID file points to current process", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(pidPath, String(process.pid));

    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createSeededAccountsDb([testAccount({ phone: "+1", is_active: false })]),
    );

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.AlreadyRunning);
  });

  it("returns NoAccounts when credentials are set but no accounts configured", async () => {
    withCredentials("12345", "test-api-hash");
    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createSeededAccountsDb([]),
    );

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.NoAccounts);
  });

  it("returns Error when Telegram API credentials are missing", async () => {
    withCredentials(undefined, undefined);
    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createSeededAccountsDb([testAccount({ phone: "+1", is_active: false })]),
    );

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.Error);
  });
});

describe("daemon status", () => {
  it("returns baseline status when not running", () => {
    const daemon = createDaemon({}, createSeededAccountsDb([]));

    const status = daemon.getStatus();

    expect(status.running).toBe(false);
    expect(status.totalAccounts).toBe(0);
    expect(status.connectedAccounts).toBe(0);
  });

  it("stop requests shutdown", () => {
    const daemon = createDaemon({}, createSeededAccountsDb([]));

    daemon.stop();

    const status = daemon.getStatus();
    expect(status.running).toBe(false);
  });
});

describe("daemon context", () => {
  const accountsDb = createSeededAccountsDb([]);
  const logger = createLogger("quiet");

  it("keeps the retention it is given", () => {
    const retention = {
      apiActivity: 30 * 24 * 60 * 60 * 1000,
      rateLimits: 2 * 60 * 60 * 1000,
      completedJobs: 60 * 60 * 1000,
      failedJobs: 3 * 24 * 60 * 60 * 1000,
    };

    const ctx = createContext({ pidPath, retention }, accountsDb, logger);

    expect(ctx.retention).toEqual(retention);
  });

  it("falls back to the default retention", () => {
    const ctx = createContext({ pidPath }, accountsDb, logger);

    expect(ctx.retention).toEqual(getDefaultRetentionConfig());
  });
});
