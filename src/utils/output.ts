import { ExitPending, exitAfterFlush, isExiting, reportCliError } from "../telemetry";
import {
  type ErrorCode,
  ErrorCodes,
  type NextCommand,
  type Output,
  type OutputFormat,
} from "../types";

let currentFormat: OutputFormat = "json";

/**
 * Set the output format
 */
export function setOutputFormat(format: OutputFormat) {
  currentFormat = format;
}

/**
 * Get current output format
 */
export function getOutputFormat() {
  return currentFormat;
}

/**
 * Output success result
 * Note: In production mode, this exits the process to close any active connections.
 * In test mode, this just logs and returns.
 */
export function success<T>(data: T, next: NextCommand[] = []) {
  if (isExiting()) return;
  const result: Output<T> =
    next.length > 0 ? { success: true, data, next } : { success: true, data };

  switch (currentFormat) {
    case "json":
      console.log(JSON.stringify(result, null, 2));
      break;
    case "pretty":
      console.log(JSON.stringify(data, null, 2));
      for (const { command, why } of next) {
        console.error(`Next: ${why}\n  ${command}`);
      }
      break;
    case "quiet":
      break;
  }

  exitAfterSuccess();
}

/**
 * Output text as is, without the success wrapper or the output format
 * (`tg api --raw`). Exits in production, as success() does.
 */
export function raw(text: string) {
  if (isExiting()) return;
  console.log(text);
  exitAfterSuccess();
}

/**
 * Write a file's bytes to stdout as they are, without JSON (`tg media
 * download --out -`). Exits in production, as success() does.
 */
export async function rawFile(path: string) {
  await Bun.write(Bun.stdout, Bun.file(path));
  exitAfterSuccess();
}

function exitAfterSuccess() {
  if (process.env.BUN_ENV !== "test" && process.env.NODE_ENV !== "test") {
    void exitAfterFlush(0);
  }
}

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCodes.RATE_LIMITED,
  ErrorCodes.NETWORK_ERROR,
]);

/** Whether an error of this code is retryable unless its caller says otherwise */
export function isRetryableCode(code: ErrorCode) {
  return RETRYABLE_CODES.has(code);
}

/**
 * Output error result
 * Note: In test mode, this throws instead of calling process.exit
 */
export function error(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  suggestion?: string,
  retryable = isRetryableCode(code),
): never {
  if (isExiting()) throw new ExitPending();
  const result: Output<never> = {
    success: false,
    error: { code, message, details, suggestion, retryable },
  };

  if (currentFormat !== "quiet") {
    console.error(JSON.stringify(result, null, 2));
  }

  if (process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test") {
    const err = new Error(message) as Error & {
      code: ErrorCode;
      details?: Record<string, unknown>;
      suggestion?: string;
      retryable: boolean;
    };
    err.code = code;
    err.details = details;
    err.suggestion = suggestion;
    err.retryable = retryable;
    throw err;
  }

  reportCliError(code, message);
  void exitAfterFlush(getExitCode(code));
  throw new ExitPending();
}

/**
 * Map error code to exit code
 */
export function getExitCode(code: ErrorCode) {
  const exitCodes: Record<ErrorCode, number> = {
    AUTH_REQUIRED: 2,
    INVALID_ARGS: 3,
    NETWORK_ERROR: 4,
    TELEGRAM_ERROR: 5,
    RATE_LIMITED: 5,
    ACCOUNT_NOT_FOUND: 6,
    NO_ACTIVE_ACCOUNT: 1,
    CACHE_UNAVAILABLE: 1,
    PHONE_CODE_INVALID: 1,
    SESSION_PASSWORD_NEEDED: 1,
    DAEMON_NOT_RUNNING: 1,
    DAEMON_ALREADY_RUNNING: 1,
    DAEMON_SIGNAL_FAILED: 1,
    DAEMON_SHUTDOWN_TIMEOUT: 1,
    DAEMON_FORCE_KILL_FAILED: 1,
    GENERAL_ERROR: 1,
    SQL_WRITE_NOT_ALLOWED: 1,
    SQL_SYNTAX_ERROR: 1,
    SQL_TABLE_NOT_FOUND: 1,
    SQL_OPERATION_BLOCKED: 1,
    NO_MEDIA: 1,
    MESSAGE_NOT_FOUND: 1,
    CONTENT_PROTECTED: 1,
    MEDIA_UNSUPPORTED: 1,
    FILE_EXISTS: 1,
    TRANSCRIBER_NOT_FOUND: 1,
    READ_ONLY: 1,
    CHAT_NOT_ALLOWED: 1,
  };

  return exitCodes[code] ?? 1;
}

/**
 * Log verbose output (only in verbose mode)
 */
export function verbose(message: string) {
  if (process.env.VERBOSE === "1") {
    console.error(`[verbose] ${message}`);
  }
}

/**
 * Log info message (not in quiet mode)
 */
export function info(message: string) {
  if (currentFormat !== "quiet" && !isExiting()) {
    console.error(message);
  }
}
