const timeoutPatchKey = Symbol.for("tgcli.timeoutPatch");
if (!(globalThis as Record<symbol, boolean>)[timeoutPatchKey]) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    handler: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ): ReturnType<typeof originalSetTimeout> => {
    const safeDelay = Math.max(0, Number.isFinite(delay) ? delay! : 0);
    return originalSetTimeout(handler, safeDelay, ...args);
  }) as typeof setTimeout;
  (globalThis as Record<symbol, boolean>)[timeoutPatchKey] = true;
}

import { join } from "node:path";
import {
  type FloodWaiterOptions,
  networkMiddlewares,
  proxyTransportFromUrl,
  TelegramClient,
} from "@mtcute/bun";

import { ConfigError } from "../config";
import { getDataDir } from "../db";
import { wrapClientCallWithRecordReplay } from "../utils/telegram-record-replay";

const clients = new Map<number, TelegramClient>();

/**
 * Configuration for telegram service
 */
export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  logLevel: number;
  transport?: ReturnType<typeof proxyTransportFromUrl>;
  /** FloodWaiter middleware options */
  floodWaiter?: FloodWaiterOptions;
}

const DEFAULT_FLOOD_WAITER_OPTIONS: FloodWaiterOptions = {
  maxRetries: 5,
  maxWait: 60000,
  store: true,
  onBeforeWait: (ctx, seconds) => {
    const method = ctx.request._;
    const quietMethods = [
      "messages.getDialogs",
      "messages.getHistory",
      "contacts.getContacts",
      "upload.getFile",
      "upload.saveFilePart",
      "upload.saveBigFilePart",
    ];
    if (!quietMethods.includes(method)) {
      console.error(`[flood-wait] ${method}: waiting ${seconds}s before retry`);
    }
  },
};

/**
 * Get default configuration from environment
 */
export function getDefaultConfig(): TelegramConfig {
  const config: TelegramConfig = {
    apiId: parseInt(process.env.TELEGRAM_API_ID ?? "0", 10),
    apiHash: process.env.TELEGRAM_API_HASH ?? "",
    logLevel: parseInt(
      process.env.MTCUTE_LOG_LEVEL ?? (process.env.VERBOSE === "1" ? "5" : "2"),
      10,
    ),
  };
  if (process.env.TELEGRAM_PROXY !== undefined) {
    try {
      config.transport = proxyTransportFromUrl(process.env.TELEGRAM_PROXY);
    } catch {
      throw new ConfigError("Invalid TELEGRAM_PROXY URL", [
        { path: "TELEGRAM_PROXY", message: "Expected a supported proxy URL" },
      ]);
    }
  }
  return config;
}

/**
 * Validate API credentials
 */
export function validateConfig(config: TelegramConfig): {
  valid: boolean;
  error?: string;
} {
  if (!config.apiId || config.apiId <= 0) {
    return {
      valid: false,
      error: "TELEGRAM_API_ID environment variable is required",
    };
  }
  if (!config.apiHash) {
    return {
      valid: false,
      error: "TELEGRAM_API_HASH environment variable is required",
    };
  }
  return { valid: true };
}

export const CREDENTIALS_HELP_URL = "https://my.telegram.org/apps";

/**
 * Thrown when a command needs Telegram but API credentials are not set
 */
export class MissingCredentialsError extends ConfigError {
  constructor(message: string) {
    super(`${message}. Get credentials at ${CREDENTIALS_HELP_URL}`, [{ path: "env", message }]);
    this.name = "MissingCredentialsError";
  }
}

/**
 * Get config from environment, throwing if credentials are missing
 */
export function requireDefaultConfig(): TelegramConfig {
  const config = getDefaultConfig();
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new MissingCredentialsError(validation.error ?? "Invalid config");
  }
  return config;
}

/**
 * Get session storage path for an account
 */
export function getSessionPath(accountId: number, dataDir?: string): string {
  return join(dataDir ?? getDataDir(), `session_${accountId}.db`);
}

/**
 * Client factory interface for dependency injection
 */
export interface ClientFactory {
  create(accountId: number): TelegramClient;
}

/**
 * Default client factory using mtcute
 */
export function createDefaultClientFactory(
  config: TelegramConfig,
  dataDir?: string,
): ClientFactory {
  const floodWaiterOpts = config.floodWaiter ?? DEFAULT_FLOOD_WAITER_OPTIONS;
  const middlewares = [networkMiddlewares.floodWaiter(floodWaiterOpts)];

  return {
    create(accountId: number): TelegramClient {
      const client = new TelegramClient({
        apiId: config.apiId,
        apiHash: config.apiHash,
        storage: getSessionPath(accountId, dataDir),
        logLevel: config.logLevel,
        ...(config.transport && { transport: config.transport }),
        network: {
          middlewares,
        },
      });
      wrapClientCallWithRecordReplay(client, { accountId, dataDir });
      return client;
    },
  };
}

/**
 * Check if a client is connected and authorized
 */
export async function isAuthorized(client: TelegramClient): Promise<boolean> {
  try {
    await client.getMe();
    return true;
  } catch {
    return false;
  }
}

let defaultFactory: ClientFactory | null = null;

function getDefaultFactory(): ClientFactory {
  defaultFactory ??= createDefaultClientFactory(requireDefaultConfig());
  return defaultFactory;
}

/**
 * Create a new Telegram client for an account (uses global clients map)
 */
export function createClient(accountId: number): TelegramClient {
  const client = getDefaultFactory().create(accountId);
  clients.set(accountId, client);
  return client;
}

/**
 * Get or create the client for an account the command already resolved
 */
export function getClientForAccount(accountId: number): TelegramClient {
  return clients.get(accountId) ?? createClient(accountId);
}
