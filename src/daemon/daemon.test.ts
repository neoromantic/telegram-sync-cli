import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, createDaemon } from "./daemon";
import { createLogger } from "./daemon-logger";
import { DaemonExitCode } from "./types";
import { createSeededAccountsDb } from "../test/accounts.test-utils";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tg-daemon-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("daemon start", () => {
  it("returns AlreadyRunning when the PID file names a live process", async () => {
    const pidPath = join(tempDir, "daemon.pid");
    writeFileSync(pidPath, String(process.pid));

    const daemon = createDaemon({ pidPath }, createSeededAccountsDb());

    expect(await daemon.start()).toBe(DaemonExitCode.AlreadyRunning);
  });

  it("returns Error when the PID file cannot be written", async () => {
    const pidPath = join(tempDir, "missing-dir", "daemon.pid");

    const daemon = createDaemon({ pidPath }, createSeededAccountsDb());

    expect(await daemon.start()).toBe(DaemonExitCode.Error);
  });
});

describe("daemon context", () => {
  it("keeps the retention it is given", () => {
    const retention = {
      apiActivity: 30 * 24 * 60 * 60 * 1000,
      rateLimits: 2 * 60 * 60 * 1000,
      completedJobs: 60 * 60 * 1000,
      failedJobs: 3 * 24 * 60 * 60 * 1000,
    };

    const ctx = createContext({ retention }, createSeededAccountsDb([]), createLogger("quiet"));

    expect(ctx.retention).toEqual(retention);
  });
});
