/**
 * CLI execution helper for E2E tests
 *
 * Provides utilities to run the CLI binary and capture output/exit codes.
 */

export interface CliOptions {
  /** Environment variables to pass to the CLI */
  env?: Record<string, string | undefined>
  /** Timeout in milliseconds (default: 10000) */
  timeout?: number
  /** Working directory */
  cwd?: string
}

export interface CliResult {
  /** Standard output */
  stdout: string
  /** Standard error output */
  stderr: string
  /** Exit code */
  exitCode: number
  /** Parsed JSON from stdout (if valid JSON) */
  json?: unknown
  /** Execution duration in milliseconds */
  duration: number
}

/**
 * Unset Telegram API credentials. Children otherwise inherit the dummy ones
 * from test-setup.ts, so a command that needs Telegram fails fast with
 * INVALID_ARGS instead of trying the network.
 */
export const NO_CREDENTIALS = {
  TELEGRAM_API_ID: undefined,
  TELEGRAM_API_HASH: undefined,
}

/** Path to the CLI entry point */
const CLI_PATH = `${import.meta.dir}/../../index.ts`

/**
 * Start the CLI without waiting for it to exit (for long-running commands
 * such as `daemon start`)
 */
export function spawnCli(
  args: string[],
  options: Omit<CliOptions, 'timeout'> = {},
) {
  const { env = {}, cwd } = options

  // --no-env-file: never pick up a developer's .env from the working directory
  return Bun.spawn(['bun', '--no-env-file', 'run', CLI_PATH, ...args], {
    env: {
      ...process.env,
      // Don't throw on errors - let the CLI handle them and exit with codes
      BUN_ENV: undefined,
      NODE_ENV: undefined,
      ...env,
    },
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/**
 * Run the CLI with given arguments
 */
export async function runCli(
  args: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const { timeout = 10000 } = options

  const startTime = performance.now()

  const proc = spawnCli(args, options)

  // Set up timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill()
      reject(new Error(`CLI command timed out after ${timeout}ms`))
    }, timeout)
  })

  // Wait for process to complete or timeout
  const exitCode = await Promise.race([proc.exited, timeoutPromise])

  const duration = performance.now() - startTime

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  // Try to parse stdout as JSON, fall back to stderr (error output)
  let json: unknown
  try {
    json = JSON.parse(stdout.trim())
  } catch {
    // stdout not valid JSON, try stderr (error responses go there)
    try {
      json = JSON.parse(stderr.trim())
    } catch {
      // Neither is valid JSON, that's fine
    }
  }

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode,
    json,
    duration,
  }
}

/**
 * Run CLI and expect success (exit code 0)
 * Throws if exit code is non-zero
 */
export async function runCliSuccess(
  args: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const result = await runCli(args, options)

  if (result.exitCode !== 0) {
    throw new Error(
      `Expected CLI to succeed but got exit code ${result.exitCode}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    )
  }

  return result
}

/**
 * Run CLI and expect failure (non-zero exit code)
 * Throws if exit code is 0
 */
export async function runCliFailure(
  args: string[],
  expectedExitCode?: number,
  options: CliOptions = {},
): Promise<CliResult> {
  const result = await runCli(args, options)

  if (result.exitCode === 0) {
    throw new Error(
      `Expected CLI to fail but got exit code 0\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    )
  }

  if (expectedExitCode !== undefined && result.exitCode !== expectedExitCode) {
    throw new Error(
      `Expected exit code ${expectedExitCode} but got ${result.exitCode}\n` +
        `stdout: ${result.stdout}\n` +
        `stderr: ${result.stderr}`,
    )
  }

  return result
}
