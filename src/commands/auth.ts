import { stdin as input, stdout as output } from "node:process";
import type { Interface as ReadlineInterface } from "node:readline";
import * as readline from "node:readline/promises";
import type { TelegramClient, User } from "@mtcute/bun";
import { defineCommand } from "citty";

import { ConfigError } from "../config";
import { type AccountsDbInterface, accountsDb as defaultAccountsDb } from "../db";
import {
  createClient,
  getClientForAccount,
  isAuthorized,
  requireDefaultConfig,
} from "../services/telegram";
import { type Account, ErrorCodes } from "../types";
import { settleCacheLayoutBeforeAccountChange } from "../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION, resolveAccountSelector } from "../utils/account-selector";
import { keepActiveAccountInConfig } from "../utils/active-account";
import { error, info, success } from "../utils/output";
import { renderQr } from "../utils/qr";

/**
 * Prompt user for input
 */
export async function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompt user for password input (hidden for privacy)
 * Falls back to regular prompt for non-TTY environments
 */
export async function promptPassword(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return prompt(message);
  }

  const syncReadline = await import("node:readline");

  const rl = syncReadline.createInterface({
    input,
    output,
    terminal: true,
  });

  let stdoutMuted = false;
  const rlWithWrite = rl as ReadlineInterface & {
    _writeToOutput: (stringToWrite: string) => void;
  };
  const originalWriteToOutput = rlWithWrite._writeToOutput;
  rlWithWrite._writeToOutput = (stringToWrite: string) => {
    if (!stdoutMuted) {
      originalWriteToOutput.call(rl, stringToWrite);
    }
  };

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    stdoutMuted = true;
  });
}

/**
 * Authentication dependencies for dependency injection
 */
export interface AuthDependencies {
  accountsDb: AccountsDbInterface;
  createClient: (accountId: number) => TelegramClient;
  getClient: (accountId: number) => TelegramClient;
  isAuthorized: (client: TelegramClient) => Promise<boolean>;
  prompt: (message: string) => Promise<string>;
  promptPassword: (message: string) => Promise<string>;
  /** Render a login URL as a QR code for the terminal */
  renderQr: (url: string) => string;
  /**
   * Write a logged-in account to activeAccount in config.json when the key
   * is set and names another account; fail the command when it can't
   */
  keepActiveAccountInConfig: (accountId: number) => Promise<void>;
}

/**
 * Get default auth dependencies
 */
export function getDefaultDependencies(): AuthDependencies {
  return {
    accountsDb: defaultAccountsDb,
    createClient,
    getClient: getClientForAccount,
    isAuthorized,
    prompt,
    promptPassword,
    renderQr,
    keepActiveAccountInConfig: (accountId) =>
      keepActiveAccountInConfig(accountId, {
        context: `Logged in as account ${accountId}`,
        details: { account_id: accountId },
        suggestion: `Make config.json writable or remove activeAccount from it, then run tg accounts switch --id ${accountId}`,
      }),
  };
}

async function activateLoggedInAccount(accountId: number, deps: AuthDependencies): Promise<void> {
  await deps.keepActiveAccountInConfig(accountId);
  deps.accountsDb.setActive(accountId);
}

/** The account a phone login signed in */
interface PhoneLoginAccount {
  id: number;
  phone: string;
  name?: string;
  username?: string;
  label?: string | null;
}

/** The account a QR login signed in */
interface QrLoginAccount {
  id: number;
  name?: string;
  username?: string;
  userId?: number;
  label?: string | null;
}

function saveLoggedInUser(
  accountsDb: AccountsDbInterface,
  account: Account,
  user: User,
  fields: { phone?: string; label?: string },
): Account {
  const existing = accountsDb.getByUserId(user.id);
  const finalAccount = existing && existing.id !== account.id ? existing : account;
  accountsDb.update(finalAccount.id, {
    ...fields,
    user_id: user.id,
    name: `${user.firstName}${user.lastName ? ` ${user.lastName}` : ""}`,
    username: user.username ?? null,
  });
  if (finalAccount !== account) accountsDb.delete(account.id);
  return finalAccount;
}

/**
 * Login with phone number - core logic
 */
export async function loginWithPhone(
  phone: string,
  deps: AuthDependencies,
  options: { label?: string } = {},
): Promise<{
  success: boolean;
  account?: PhoneLoginAccount;
  error?: string;
}> {
  const { accountsDb, createClient, prompt, promptPassword } = deps;
  const label = options.label?.trim();
  const labelValue = label ? label : undefined;

  const account = accountsDb.getByPhone(phone) ?? accountsDb.create({ phone, label: labelValue });

  const client = createClient(account.id);
  let loggedIn: PhoneLoginAccount;

  try {
    const user = await client.start({
      phone: () => Promise.resolve(phone),
      code: async () => prompt("Enter the verification code: "),
      password: async () => promptPassword("Enter 2FA password: "),
    });

    const finalAccount = saveLoggedInUser(accountsDb, account, user, {
      phone,
      label: labelValue,
    });

    await client.destroy();

    loggedIn = {
      id: finalAccount.id,
      phone: phone,
      name: user.firstName,
      username: user.username ?? undefined,
      label: labelValue ?? finalAccount.label ?? null,
    };
  } catch (err) {
    await client.destroy().catch(() => {});
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }

  await activateLoggedInAccount(loggedIn.id, deps);
  return { success: true, account: loggedIn };
}

/**
 * Login via QR code - core logic
 */
export async function loginWithQr(
  accountName: string | undefined,
  deps: AuthDependencies,
): Promise<{
  success: boolean;
  account?: QrLoginAccount;
  error?: string;
}> {
  const { accountsDb, createClient } = deps;

  const label = accountName?.trim();
  const name = label && label.length > 0 ? label : `qr_account_${Date.now()}`;
  const account = accountsDb.create({
    phone: `qr:${name}`,
    name,
    label: label && label.length > 0 ? label : undefined,
  });

  const client = createClient(account.id);
  let loggedIn: QrLoginAccount;

  try {
    const user = await client.signInQr({
      onUrlUpdated: (url: string, expires: Date) => {
        console.error(deps.renderQr(url));
        console.error(`\nExpires: ${expires.toLocaleTimeString()}`);
        console.error("Waiting for scan...\n");
      },
      onQrScanned: () => {
        console.error("✓ QR code scanned! Completing authentication...");
      },
      password: async () => deps.promptPassword("\nEnter 2FA password: "),
      invalidPasswordCallback: () => {
        console.error("Invalid password, please try again.");
      },
    });

    const finalAccount = saveLoggedInUser(accountsDb, account, user, {
      label: label && label.length > 0 ? label : undefined,
    });
    if (finalAccount.id === account.id) {
      accountsDb.update(account.id, { phone: `user:${user.id}` });
    }

    await client.destroy();

    loggedIn = {
      id: finalAccount.id,
      name: user.firstName,
      username: user.username ?? undefined,
      userId: user.id,
      label: label ?? finalAccount.label ?? null,
    };
  } catch (err) {
    await client.destroy().catch(() => {});
    accountsDb.delete(account.id);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }

  await activateLoggedInAccount(loggedIn.id, deps);
  return { success: true, account: loggedIn };
}

/**
 * Logout from account - core logic
 */
export async function logout(
  accountId: number | undefined,
  deps: AuthDependencies,
): Promise<{
  success: boolean;
  accountId?: number;
  phone?: string;
  error?: string;
}> {
  const { accountsDb, getClient } = deps;

  const account = accountId ? accountsDb.getById(accountId) : accountsDb.getActive();

  if (!account) {
    return { success: false, error: "No account found to logout" };
  }

  const client = getClient(account.id);

  try {
    await client.call({ _: "auth.logOut" });

    await client.destroy();

    accountsDb.delete(account.id);

    return {
      success: true,
      accountId: account.id,
      phone: account.phone,
    };
  } catch (err) {
    await client.destroy().catch(() => {});
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: message };
  }
}

/**
 * Get authentication status - core logic
 */
export async function getAuthStatus(
  accountId: number | undefined,
  deps: AuthDependencies,
): Promise<{
  authenticated: boolean;
  account?: {
    id: number;
    phone: string;
    name?: string;
    username?: string;
    userId?: number;
  };
  message?: string;
}> {
  const { accountsDb, getClient, isAuthorized } = deps;

  const account = accountId ? accountsDb.getById(accountId) : accountsDb.getActive();

  if (!account) {
    return {
      authenticated: false,
      message: "No account configured",
    };
  }

  const client = getClient(account.id);

  try {
    const authorized = await isAuthorized(client);

    if (authorized) {
      const me = await client.getMe();
      await client.destroy();
      return {
        authenticated: true,
        account: {
          id: account.id,
          phone: account.phone,
          name: me.firstName,
          username: me.username ?? undefined,
          userId: me.id,
        },
      };
    }

    await client.destroy();
    return {
      authenticated: false,
      account: {
        id: account.id,
        phone: account.phone,
      },
      message: 'Account exists but not authenticated. Run "tg auth login" to authenticate.',
    };
  } catch {
    await client.destroy().catch(() => {});
    return {
      authenticated: false,
      account: {
        id: account.id,
        phone: account.phone,
      },
      message: "Could not verify authentication status",
    };
  }
}

function exitOnConfigError(err: unknown): void {
  if (err instanceof ConfigError) {
    error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues });
  }
}

function ensureCredentials(): void {
  try {
    requireDefaultConfig();
  } catch (err) {
    exitOnConfigError(err);
    throw err;
  }
}

/**
 * Login command - authenticate a new or existing account
 */
export const loginCommand = defineCommand({
  meta: {
    name: "login",
    description: "Login to a Telegram account",
  },
  args: {
    phone: {
      type: "string",
      description: "Phone number in international format (e.g., +15551234567)",
      required: true,
    },
    label: {
      type: "string",
      description: "Custom label for this account",
    },
  },
  async run({ args }) {
    const phone = args.phone;
    const label = args.label;

    settleCacheLayoutBeforeAccountChange();
    ensureCredentials();
    info(`Logging in with phone: ${phone}`);
    const result = await loginWithPhone(phone, getDefaultDependencies(), {
      label,
    });

    if (result.success && result.account) {
      success({
        message: "Successfully logged in",
        account: result.account,
      });
    } else {
      error(ErrorCodes.TELEGRAM_ERROR, `Login failed: ${result.error}`, {
        phone,
      });
    }
  },
});

/**
 * Login via QR code - scan with Telegram mobile app
 */
export const loginQrCommand = defineCommand({
  meta: {
    name: "login-qr",
    description: "Login via QR code (scan with Telegram mobile app)",
  },
  args: {
    name: {
      type: "string",
      description: "Account label for this session",
    },
  },
  async run({ args }) {
    settleCacheLayoutBeforeAccountChange();
    ensureCredentials();
    console.error("\n=== QR Code Login ===\n");
    console.error("Scan this QR code with your Telegram mobile app:");
    console.error("(Settings → Devices → Link Desktop Device)\n");

    const result = await loginWithQr(args.name, getDefaultDependencies());

    if (result.success && result.account) {
      success({
        message: "Successfully logged in via QR code",
        account: result.account,
      });
    } else {
      error(ErrorCodes.TELEGRAM_ERROR, `QR login failed: ${result.error}`);
    }
  },
});

/**
 * Logout command - sign out from an account
 */
export const logoutCommand = defineCommand({
  meta: {
    name: "logout",
    description: "Logout from a Telegram account",
  },
  args: {
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const accountId = resolveAccountSelector(args.account);
    settleCacheLayoutBeforeAccountChange();

    let result: Awaited<ReturnType<typeof logout>>;
    try {
      result = await logout(accountId, getDefaultDependencies());
    } catch (err) {
      exitOnConfigError(err);
      throw err;
    }

    if (result.success) {
      success({
        message: "Successfully logged out",
        accountId: result.accountId,
        phone: result.phone,
      });
    } else {
      if (result.error === "No account found to logout") {
        error(ErrorCodes.ACCOUNT_NOT_FOUND, result.error);
      } else {
        error(ErrorCodes.TELEGRAM_ERROR, `Logout failed: ${result.error}`);
      }
    }
  },
});

/**
 * Status command - check authentication status
 */
export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Check authentication status",
  },
  args: {
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const accountId = resolveAccountSelector(args.account);

    let result: Awaited<ReturnType<typeof getAuthStatus>>;
    try {
      result = await getAuthStatus(accountId, getDefaultDependencies());
    } catch (err) {
      exitOnConfigError(err);
      throw err;
    }

    success(result);
  },
});

/**
 * Auth subcommand group
 */
export const authCommand = defineCommand({
  meta: {
    name: "auth",
    description: "Authentication commands",
  },
  subCommands: {
    login: loginCommand,
    "login-qr": loginQrCommand,
    logout: logoutCommand,
    status: statusCommand,
  },
});
