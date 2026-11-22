import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CliOptions {
  /** Environment variables to pass to the CLI */
  env?: Record<string, string | undefined>;
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Working directory */
  cwd?: string;
  /** Script to run instead of src/index.ts, such as a wrapper that mocks a module */
  entry?: string;
}

export interface CliResult {
  /** Standard output */
  stdout: string;
  /** Standard error output */
  stderr: string;
  /** Exit code */
  exitCode: number;
  /** Parsed JSON from stdout (if valid JSON) */
  json?: unknown;
  /** Execution duration in milliseconds */
  duration: number;
}

/**
 * Unset Telegram API credentials. Children otherwise inherit the dummy ones
 * from test-setup.ts, so a command that needs Telegram fails fast with
 * INVALID_ARGS instead of trying the network.
 */
export const NO_CREDENTIALS = {
  TELEGRAM_API_ID: undefined,
  TELEGRAM_API_HASH: undefined,
};

const CLI_PATH = `${import.meta.dir}/../index.ts`;

/**
 * Start the CLI without waiting for it to exit (for long-running commands
 * such as `daemon start`)
 */
export function spawnCli(args: string[], options: Omit<CliOptions, "timeout"> = {}) {
  const { env = {}, cwd, entry = CLI_PATH } = options;

  return Bun.spawn([process.execPath, "--no-env-file", "run", entry, ...args], {
    env: {
      ...process.env,
      BUN_ENV: undefined,
      NODE_ENV: undefined,
      ...env,
    },
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Run the CLI with given arguments
 */
export async function runCli(args: string[], options: CliOptions = {}) {
  const { timeout = 10000 } = options;

  const startTime = performance.now();

  const proc = spawnCli(args, options);

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI command timed out after ${timeout}ms`));
    }, timeout);
  });

  const exitCode = await Promise.race([proc.exited, timeoutPromise]);

  const duration = performance.now() - startTime;

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    try {
      json = JSON.parse(stderr.trim());
    } catch {}
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    json,
    duration,
  };
}

/**
 * Run CLI and expect success (exit code 0)
 * Throws if exit code is non-zero
 */
export async function runCliSuccess(args: string[], options: CliOptions = {}) {
  const result = await runCli(args, options);

  if (result.exitCode !== 0) {
    throw new Error(
      `Expected CLI to succeed but got exit code ${result.exitCode}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }

  return result;
}

/**
 * Run CLI and expect failure (non-zero exit code)
 * Throws if exit code is 0
 */
export async function runCliFailure(
  args: string[],
  expectedExitCode?: number,
  options: CliOptions = {},
) {
  const result = await runCli(args, options);

  if (result.exitCode === 0) {
    throw new Error(
      `Expected CLI to fail but got exit code 0\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }

  if (expectedExitCode !== undefined && result.exitCode !== expectedExitCode) {
    throw new Error(
      `Expected exit code ${expectedExitCode} but got ${result.exitCode}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    );
  }

  return result;
}

/**
 * Run a command line as a POSIX shell reads it, with `tg` on PATH running
 * this checkout's CLI: the way an agent runs a `next` command it copied
 */
export async function runShellCommand(command: string, options: CliOptions = {}) {
  const { env = {}, timeout = 10000, entry = CLI_PATH } = options;
  const shimDir = join(process.cwd(), ".tmp", `tg-shim-${process.pid}-${Bun.hash(entry)}`);
  const shim = join(shimDir, "tg");
  if (!existsSync(shim)) {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shim, `#!/bin/sh\nexec bun --no-env-file run '${entry}' "$@"\n`, {
      mode: 0o755,
    });
  }
  const startTime = performance.now();
  const proc = Bun.spawn(["sh", "-c", command], {
    env: {
      ...process.env,
      BUN_ENV: undefined,
      NODE_ENV: undefined,
      ...env,
      PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    },
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeout);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  let json: unknown;
  try {
    json = JSON.parse(stdout || stderr);
  } catch {}
  return {
    stdout,
    stderr,
    exitCode,
    json,
    duration: performance.now() - startTime,
  };
}
