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

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Return a live PID, preserving filesystem errors for callers that report them. */
export function readLivePid(path: string) {
  const content = readFileSync(path, "utf-8").trim();
  const pid = Number(content);
  return /^\d+$/.test(content) && Number.isSafeInteger(pid) && pid > 0 && processExists(pid)
    ? pid
    : null;
}

function removePidFile(path: string) {
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function writePidFile(path: string, pid: number) {
  try {
    writeFileSync(path, pid.toString(), { mode: 0o600 });
  } catch (err) {
    throw new PidFileError(`Failed to write PID file: ${err}`, "IO_ERROR");
  }
}

class PidFileManager implements PidFile {
  constructor(private readonly path: string) {}

  acquire() {
    const existingPid = this.read();
    if (existingPid !== null) {
      throw new PidFileError(
        `Daemon already running with PID ${existingPid}`,
        "ALREADY_RUNNING",
        existingPid,
      );
    }

    if (existsSync(this.path)) {
      removePidFile(this.path);
    }

    writePidFile(this.path, process.pid);
  }

  release() {
    removePidFile(this.path);
  }

  read() {
    try {
      return readLivePid(this.path);
    } catch {
      return null;
    }
  }

  isRunning() {
    return this.read() !== null;
  }

  sendSignal(signal: number | NodeJS.Signals) {
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

  getPath() {
    return this.path;
  }
}

/**
 * Create a PID file manager
 */
export function createPidFile(path: string) {
  const result: PidFile = new PidFileManager(path);
  return result;
}
