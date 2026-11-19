import type { TelegramClient } from "@mtcute/bun";
import { getErrorMessage } from "./daemon-utils";
import type { DaemonLogger, DaemonVerbosity } from "./types";

export function createLogger(verbosity: DaemonVerbosity) {
  const shouldLog = {
    info: verbosity !== "quiet",
    debug: verbosity === "verbose",
    warn: true,
    error: true,
  };

  const timestamp = () => new Date().toISOString();

  return {
    info(message: string) {
      if (shouldLog.info) console.log(`[${timestamp()}] [INFO] ${message}`);
    },
    debug(message: string) {
      if (shouldLog.debug) console.log(`[${timestamp()}] [DEBUG] ${message}`);
    },
    warn(message: string) {
      if (shouldLog.warn) console.warn(`[${timestamp()}] [WARN] ${message}`);
    },
    error(message: string) {
      if (shouldLog.error) console.error(`[${timestamp()}] [ERROR] ${message}`);
    },
  };
}

/**
 * A phone number with only its first two and last two digits shown:
 * `+15550000000` is `+15*******00`. Logs get pasted into issues (#128).
 */
export function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "***";
  return `+${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/**
 * How the daemon names an account in its log: `#1 (@username)`, else
 * `#1 (+15*******00)`. Never the full phone number or the name (#128).
 */
export function accountLabel(account: {
  accountId: number;
  phone: string;
  username?: string | null;
}) {
  if (account.username) return `#${account.accountId} (@${account.username})`;
  if (!account.phone || account.phone.startsWith("user:")) {
    return `#${account.accountId}`;
  }
  return `#${account.accountId} (${maskPhone(account.phone)})`;
}

const MTCUTE_ERROR = 1;
const MTCUTE_WARN = 2;

const REPEATED_ERROR_WINDOW_MS = 5 * 60 * 1000;

function stripPayloadsAndStacks(text: string) {
  return text
    .replace(/\n\s*at\s[^\n]*/g, "")
    .replace(/(\[\s*)?\{"_":"([\w.]+)"[\s\S]*$/, (_m, _arr, type) => `<${type}>`)
    .replace(/\[?\s*[{[]"[\s\S]*$/, "<payload>");
}

/**
 * One line of mtcute's log: its format filled in, an error by its message,
 * a Telegram object by its type, never a stack or a payload (#128)
 */
export function formatClientLog(fmt: string, args: unknown[]) {
  const rest = [...args];
  const text = stripPayloadsAndStacks(fmt.replace(/^\[USER [^\]]*\] /, "")).replace(
    /%[sdifo]/gi,
    () => {
      if (rest.length === 0) return "";
      return describeArg(rest.shift());
    },
  );
  const extra = rest.map(describeArg).filter((part) => part.length > 0);
  return [text.trim(), ...extra].join(" ").replace(/\s+/g, " ").trim();
}

function describeArg(value: unknown) {
  if (value instanceof Error) return getErrorMessage(value);
  if (typeof value === "object" && value !== null) {
    const type = (value as { _?: unknown })._;
    return typeof type === "string" ? `<${type}>` : "<object>";
  }
  return String(value);
}

/**
 * Route the client's own log and errors through the daemon's logger, one
 * line each, never a dumped error object (Bun prints the compiled binary's
 * source with one). mtcute's warnings show only with `--verbose`, its update
 * gap chatter at debug level; its errors always do (#128).
 */
export function routeClientLogs(
  client: TelegramClient,
  logger: DaemonLogger,
  verbosity: DaemonVerbosity,
  tag: string,
  now: () => number = Date.now,
) {
  const mgr = client.log.mgr;
  mgr.level = verbosity === "verbose" ? MTCUTE_WARN : MTCUTE_ERROR;
  mgr.handler = (_color, level, logTag, fmt, args) => {
    const line = `${tag} [mtcute ${logTag}] ${formatClientLog(fmt, args)}`;
    if (level <= MTCUTE_ERROR) logger.error(line);
    else if (level === MTCUTE_WARN && logTag !== "updates") logger.warn(line);
    else logger.debug(line);
  };

  let lastError: { message: string; at: number } | undefined;
  client.onError.add((err) => {
    const message = getErrorMessage(err).replace(/\s+/g, " ").trim();
    const at = now();
    const repeated = lastError?.message === message && at - lastError.at < REPEATED_ERROR_WINDOW_MS;
    if (!repeated) lastError = { message, at };
    const line = `${tag} Telegram client error: ${message}`;
    if (repeated) logger.debug(line);
    else logger.warn(line);
  });
}
