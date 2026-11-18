import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * Error thrown when PID file operations fail
 */
export class PidFileError extends Error {
  constructor(
    message: string,
    public readonly code: "ALREADY_RUNNING" | "NOT_RUNNING" | "IO_ERROR",
    public readonly pid?: number,
  ) {
    super(message);
    this.name = "PidFileError";
  }
}

/**
 * PID file interface
 */
export interface PidFile {
  /** Acquire PID file (fails if daemon already running) */
  acquire(): void;
  /** Release PID file */
  release(): void;
  /** Read PID from file (null if not running) */
  read(): number | null;
  /** Check if daemon is running */
  isRunning(): boolean;
  /** Send signal to daemon process */
  sendSignal(signal: number | NodeJS.Signals): boolean;
  /** Get PID file path */
  getPath(): string;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFromFile(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = readFileSync(path, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (Number.isNaN(pid)) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

function removePidFile(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function writePidFile(path: string, pid: number): void {
  try {
    writeFileSync(path, pid.toString(), { mode: 0o600 });
  } catch (err) {
    throw new PidFileError(`Failed to write PID file: ${err}`, "IO_ERROR");
  }
}

class PidFileManager implements PidFile {
  constructor(private readonly path: string) {}

  acquire(): void {
    const existingPid = readPidFromFile(this.path);
    if (existingPid && processExists(existingPid)) {
      throw new PidFileError(
        `Daemon already running with PID ${existingPid}`,
        "ALREADY_RUNNING",
        existingPid,
      );
    }

    if (existingPid || existsSync(this.path)) {
      removePidFile(this.path);
    }

    writePidFile(this.path, process.pid);
  }

  release(): void {
    removePidFile(this.path);
  }

  read(): number | null {
    const pid = readPidFromFile(this.path);
    if (!pid) {
      return null;
    }
    if (!processExists(pid)) {
      return null;
    }
    return pid;
  }

  isRunning(): boolean {
    return this.read() !== null;
  }

  sendSignal(signal: number | NodeJS.Signals): boolean {
    const pid = this.read();
    if (pid === null) {
      return false;
    }

    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  getPath(): string {
    return this.path;
  }
}

/**
 * Create a PID file manager
 */
export function createPidFile(path: string): PidFile {
  return new PidFileManager(path);
}
