import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, runCliSuccess } from "./cli.test-utils";

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
    it("shows stopped without a PID file or with a dead process's", async () => {
      for (const pid of [null, "999999999"]) {
        if (pid !== null) writeFileSync(join(testDir, "daemon.pid"), pid);

        const result = await runCliSuccess(["daemon", "status"], { env });

        expect(result.json).toMatchObject({
          success: true,
          data: { status: "stopped", pid: null },
        });
      }
    });

    it("shows running when PID file exists with live process", async () => {
      const pidPath = join(testDir, "daemon.pid");
      writeFileSync(pidPath, process.pid.toString());

      const result = await runCliSuccess(["daemon", "status"], { env });
      const json = result.json as JsonResult;

      expect(json?.success).toBe(true);
      expect(json?.data?.status).toBe("running");
      expect(json?.data?.pid).toBe(process.pid);
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
});
