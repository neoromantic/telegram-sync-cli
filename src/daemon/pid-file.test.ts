import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPidFile, PidFileError } from "./pid-file";

const DEAD_PID = "999999999";

describe("PidFile", () => {
  let testDir: string;
  let pidPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "tg-pid-file-"));
    pidPath = join(testDir, "daemon.pid");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("acquire replaces a dead process's PID file with its own PID", () => {
    writeFileSync(pidPath, DEAD_PID);

    createPidFile(pidPath).acquire();

    expect(readFileSync(pidPath, "utf-8")).toBe(String(process.pid));
  });

  it("acquire throws while the PID file names a live process", () => {
    writeFileSync(pidPath, String(process.pid));

    expect(() => createPidFile(pidPath).acquire()).toThrow(PidFileError);
  });

  it("release removes the PID file, and again does nothing", () => {
    const pidFile = createPidFile(pidPath);
    pidFile.acquire();

    pidFile.release();
    pidFile.release();

    expect(existsSync(pidPath)).toBe(false);
  });

  it("reads no PID from a file that holds no number", () => {
    writeFileSync(pidPath, "not a number");

    expect(createPidFile(pidPath).read()).toBeNull();
  });

  it("signals only a live process", () => {
    writeFileSync(pidPath, String(process.pid));
    expect(createPidFile(pidPath).sendSignal(0)).toBe(true);

    writeFileSync(pidPath, DEAD_PID);
    expect(createPidFile(pidPath).sendSignal(0)).toBe(false);
  });
});
