import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createDaemon } from "./daemon";
import { DaemonExitCode } from "./types";
import { createTestDatabase } from "../db";

const tempDir = join(process.cwd(), ".tmp", "daemon-start-tests");
const pidPath = join(tempDir, `daemon-${process.pid}.pid`);

const originalEnv = {
  TELEGRAM_API_ID: process.env.TELEGRAM_API_ID,
  TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH,
  TELEGRAM_SYNC_CLI_DATA_DIR: process.env.TELEGRAM_SYNC_CLI_DATA_DIR,
};

beforeEach(() => {
  mkdirSync(tempDir, { recursive: true });
  rmSync(pidPath, { force: true });
  process.env.TELEGRAM_SYNC_CLI_DATA_DIR = tempDir;
});

afterEach(() => {
  rmSync(pidPath, { force: true });
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.TELEGRAM_API_ID = originalEnv.TELEGRAM_API_ID;
  process.env.TELEGRAM_API_HASH = originalEnv.TELEGRAM_API_HASH;
  process.env.TELEGRAM_SYNC_CLI_DATA_DIR = originalEnv.TELEGRAM_SYNC_CLI_DATA_DIR;
});

describe("daemon start config/pid failures", () => {
  it("returns Error when PID file cannot be acquired", async () => {
    process.env.TELEGRAM_API_ID = "123";
    process.env.TELEGRAM_API_HASH = "hash";

    const { accountsDb } = createTestDatabase();
    accountsDb.create({ phone: "+1", is_active: true });

    const badPidPath = join(tempDir, "missing-dir", "daemon.pid");
    const daemon = createDaemon({ pidPath: badPidPath }, accountsDb);

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.Error);
  });
});
