import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPidFile, PidFileError } from "./pid-file";

describe("PidFile", () => {
  let testDir: string;
  let pidPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `tg-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    pidPath = join(testDir, "daemon.pid");
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("acquire", () => {
    it("creates PID file with current process ID", () => {
      const pidFile = createPidFile(pidPath);
      pidFile.acquire();

      expect(existsSync(pidPath)).toBe(true);
      const content = Bun.file(pidPath).text();
      expect(content).resolves.toBe(process.pid.toString());

      pidFile.release();
    });

    it("throws if PID file already exists with live process", () => {
      writeFileSync(pidPath, process.pid.toString());

      const pidFile = createPidFile(pidPath);
      expect(() => pidFile.acquire()).toThrow(PidFileError);
    });

    it("removes stale PID file and acquires", () => {
      writeFileSync(pidPath, "999999999");

      const pidFile = createPidFile(pidPath);
      pidFile.acquire();

      expect(existsSync(pidPath)).toBe(true);
      const content = Bun.file(pidPath).text();
      expect(content).resolves.toBe(process.pid.toString());

      pidFile.release();
    });
  });

  describe("release", () => {
    it("removes PID file", () => {
      const pidFile = createPidFile(pidPath);
      pidFile.acquire();
      expect(existsSync(pidPath)).toBe(true);

      pidFile.release();
      expect(existsSync(pidPath)).toBe(false);
    });

    it("is idempotent", () => {
      const pidFile = createPidFile(pidPath);
      pidFile.acquire();

      pidFile.release();
      pidFile.release();
      expect(existsSync(pidPath)).toBe(false);
    });
  });

  describe("read", () => {
    it("returns PID when file exists with live process", () => {
      writeFileSync(pidPath, process.pid.toString());

      const pidFile = createPidFile(pidPath);
      expect(pidFile.read()).toBe(process.pid);
    });

    it("returns null when file does not exist", () => {
      const pidFile = createPidFile(pidPath);
      expect(pidFile.read()).toBeNull();
    });

    it("returns null when file contains dead process", () => {
      writeFileSync(pidPath, "999999999");

      const pidFile = createPidFile(pidPath);
      expect(pidFile.read()).toBeNull();
    });

    it("returns null when file contains invalid content", () => {
      writeFileSync(pidPath, "not a number");

      const pidFile = createPidFile(pidPath);
      expect(pidFile.read()).toBeNull();
    });
  });

  describe("isRunning", () => {
    it("returns true when PID file has live process", () => {
      writeFileSync(pidPath, process.pid.toString());

      const pidFile = createPidFile(pidPath);
      expect(pidFile.isRunning()).toBe(true);
    });

    it("returns false when PID file does not exist", () => {
      const pidFile = createPidFile(pidPath);
      expect(pidFile.isRunning()).toBe(false);
    });

    it("returns false when PID file has dead process", () => {
      writeFileSync(pidPath, "999999999");

      const pidFile = createPidFile(pidPath);
      expect(pidFile.isRunning()).toBe(false);
    });
  });

  describe("sendSignal", () => {
    it("returns true when process exists", () => {
      writeFileSync(pidPath, process.pid.toString());

      const pidFile = createPidFile(pidPath);
      expect(pidFile.sendSignal(0)).toBe(true);
    });

    it("returns false when process does not exist", () => {
      writeFileSync(pidPath, "999999999");

      const pidFile = createPidFile(pidPath);
      expect(pidFile.sendSignal(0)).toBe(false);
    });

    it("returns false when PID file does not exist", () => {
      const pidFile = createPidFile(pidPath);
      expect(pidFile.sendSignal(0)).toBe(false);
    });
  });
});
