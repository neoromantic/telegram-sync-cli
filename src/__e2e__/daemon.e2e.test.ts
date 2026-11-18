/**
 * E2E tests for daemon commands
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, runCliSuccess } from "./helpers/cli";

interface JsonResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

describe("daemon commands", () => {
  let testDir: string;
  let env: { TELEGRAM_SYNC_CLI_DATA_DIR: string };

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `tg-cli-e2e-daemon-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    env = { TELEGRAM_SYNC_CLI_DATA_DIR: testDir };
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("tg daemon status", () => {
    it("shows stopped when daemon is not running", async () => {
      const result = await runCliSuccess(["daemon", "status"], { env });
      const json = result.json as JsonResult;

      expect(json?.success).toBe(true);
      expect(json?.data?.status).toBe("stopped");
      expect(json?.data?.pid).toBeNull();
    });

    it("shows running when PID file exists with live process", async () => {
      // Create a PID file with the current process (which is alive)
      const pidPath = join(testDir, "daemon.pid");
      writeFileSync(pidPath, process.pid.toString());

      const result = await runCliSuccess(["daemon", "status"], { env });
      const json = result.json as JsonResult;

      expect(json?.success).toBe(true);
      expect(json?.data?.status).toBe("running");
      expect(json?.data?.pid).toBe(process.pid);
    });

    it("shows stopped when PID file has dead process", async () => {
      // Create a PID file with a non-existent process
      const pidPath = join(testDir, "daemon.pid");
      writeFileSync(pidPath, "999999999");

      const result = await runCliSuccess(["daemon", "status"], { env });
      const json = result.json as JsonResult;

      expect(json?.success).toBe(true);
      expect(json?.data?.status).toBe("stopped");
    });
  });

  describe("tg daemon stop", () => {
    it("returns error when daemon is not running", async () => {
      const result = await runCli(["daemon", "stop"], { env });
      const json = result.json as JsonResult;

      expect(result.exitCode).toBe(1);
      expect(json?.success).toBe(false);
      expect(json?.error?.code).toBe("DAEMON_NOT_RUNNING");
    });
  });

  describe("tg daemon help", () => {
    it("shows daemon help", async () => {
      const result = await runCliSuccess(["daemon", "--help"], { env });

      expect(result.stdout).toContain("daemon");
      expect(result.stdout).toContain("start");
      expect(result.stdout).toContain("stop");
      expect(result.stdout).toContain("status");
    });
  });
});
