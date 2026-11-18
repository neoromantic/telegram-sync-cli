/**
 * Tests for daemon lifecycle (no module mocks)
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, createDaemon } from "../daemon/daemon";
import { createLogger } from "../daemon/daemon-logger";
import { DaemonExitCode } from "../daemon/types";
import { getDefaultRetentionConfig } from "../db/types";
import { createFakeAccountsDb, testAccount } from "./helpers/db-mock";

const tempDir = join(process.cwd(), ".tmp", "daemon-tests");
const pidPath = join(tempDir, `daemon-${process.pid}.pid`);

const originalCredentials = {
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
};

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function withCredentials(apiId: string | undefined, apiHash: string | undefined): void {
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
      createFakeAccountsDb([testAccount({ id: 1, phone: "+1", is_active: 0 })]),
    );

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.AlreadyRunning);
  });

  it("returns NoAccounts when credentials are set but no accounts configured", async () => {
    // Credentials come from test-setup.ts; set them explicitly so this test
    // does not depend on preload order or the developer's .env
    withCredentials("12345", "test-api-hash");
    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createFakeAccountsDb([]),
    );

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.NoAccounts);
  });

  it("returns Error when Telegram API credentials are missing", async () => {
    withCredentials(undefined, undefined);
    const daemon = createDaemon(
      { pidPath, shutdownTimeoutMs: 1_000_000 },
      createFakeAccountsDb([testAccount({ id: 1, phone: "+1", is_active: 0 })]),
    );

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.Error);
  });
});

describe("daemon status", () => {
  it("returns baseline status when not running", () => {
    const daemon = createDaemon({}, createFakeAccountsDb([]));

    const status = daemon.getStatus();

    expect(status.running).toBe(false);
    expect(status.totalAccounts).toBe(0);
    expect(status.connectedAccounts).toBe(0);
  });

  it("stop requests shutdown", () => {
    const daemon = createDaemon({}, createFakeAccountsDb([]));

    daemon.stop();

    const status = daemon.getStatus();
    expect(status.running).toBe(false);
  });
});

describe("daemon context", () => {
  const accountsDb = createFakeAccountsDb([]);
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
