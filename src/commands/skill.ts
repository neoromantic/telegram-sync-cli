import { constants } from "node:fs";
import { access, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";

import skillMarkdown from "../../skills/telegram-sync-cli/SKILL.md" with { type: "text" };
import {
  ConfigError,
  type ConfigFile,
  ConfigReadError,
  configuredActiveAccount,
  getConfigPath,
  loadConfig,
} from "../config";
import { getErrorMessage } from "../daemon/daemon-utils";
import { type Account, ErrorCodes } from "../types";
import { findDefaultAccount } from "../utils/account-selector";
import { error, success } from "../utils/output";

export const SKILL_NAME = "telegram-sync-cli";

export const SKILL_MARKDOWN: string = skillMarkdown;

export interface SkillEnvStatus {
  telegram_api_id: {
    present: boolean;
    valid: boolean;
  };
  telegram_api_hash: {
    present: boolean;
    valid: boolean;
  };
}

export interface SkillDataDirStatus {
  path: string;
  exists: boolean;
  is_directory: boolean;
  writable: boolean;
  error?: string;
}

export interface SkillAccountStatus {
  id: number;
  username: string | null;
  label: string | null;
}

export interface SkillDaemonStatus {
  /** `unknown`: daemon.pid exists but can't be read */
  status: "running" | "stopped" | "unknown";
  pid: number | null;
  error?: string;
}

export interface SkillValidationResult {
  valid: boolean;
  env: SkillEnvStatus;
  data_dir: SkillDataDirStatus;
  /** The account record the next command uses without --account, or null */
  account: SkillAccountStatus | null;
  /** null: data.db can't be read */
  accounts_total: number | null;
  daemon: SkillDaemonStatus;
  issues: string[];
}

export interface SkillInstallResult {
  path: string;
  bytes: number;
  overwritten: boolean;
}

function resolveDataDir() {
  return process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? join(homedir(), ".telegram-sync-cli");
}

function buildEnvStatus() {
  const apiIdRaw = process.env.TELEGRAM_API_ID ?? "";
  const apiHashRaw = process.env.TELEGRAM_API_HASH ?? "";
  const apiId = Number.parseInt(apiIdRaw, 10);

  const result: SkillEnvStatus = {
    telegram_api_id: {
      present: apiIdRaw.length > 0,
      valid: Number.isFinite(apiId) && apiId > 0,
    },
    telegram_api_hash: {
      present: apiHashRaw.length > 0,
      valid: apiHashRaw.length > 0,
    },
  };
  return result;
}

function errorCode(err: unknown) {
  return typeof err === "object" && err && "code" in err ? err.code : null;
}

export async function tryStat(path: string) {
  try {
    const stat = await Bun.file(path).stat();
    const result:
      | {
          exists: true;
          isDirectory: boolean;
        }
      | {
          exists: false;
          error?: string;
        } = { exists: true, isDirectory: stat.isDirectory() };
    return result;
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      const result:
        | {
            exists: true;
            isDirectory: boolean;
          }
        | {
            exists: false;
            error?: string;
          } = { exists: false };
      return result;
    }
    const result:
      | {
          exists: true;
          isDirectory: boolean;
        }
      | {
          exists: false;
          error?: string;
        } = { exists: false, error: getErrorMessage(err) };
    return result;
  }
}

export async function checkDataDirAccess(dataDir: string) {
  const initialStat = await tryStat(dataDir);
  if (initialStat.exists && !initialStat.isDirectory) {
    const result: SkillDataDirStatus = {
      path: dataDir,
      exists: true,
      is_directory: false,
      writable: false,
      error: "Path exists but is not a directory",
    };
    return result;
  }

  const probeName = `.tg-skill-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const probePath = join(dataDir, probeName);

  let writable = false;
  let errorMessage: string | undefined;

  try {
    await Bun.write(probePath, "probe", { createPath: true });
    writable = true;
  } catch (err) {
    errorMessage = getErrorMessage(err);
  }

  if (writable) {
    try {
      await Bun.file(probePath).delete();
    } catch {}
  }

  const finalStat = await tryStat(dataDir);

  const result: SkillDataDirStatus = {
    path: dataDir,
    exists: finalStat.exists,
    is_directory: finalStat.exists ? finalStat.isDirectory : false,
    writable,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  return result;
}

async function readConfig() {
  try {
    const { config } = await loadConfig({ strict: true });
    const result: { config: ConfigFile; issue: null } | { config: null; issue: string } = {
      config,
      issue: null,
    };
    return result;
  } catch (err) {
    if (err instanceof ConfigError) {
      const details = err.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
      return {
        config: null,
        issue: `${getConfigPath()}: ${err.message} (${details}); fix it with tg config set or edit the file`,
      };
    }
    if (err instanceof ConfigReadError) {
      return { config: null, issue: err.message };
    }
    throw err;
  }
}

function accountStatus(account: Account) {
  const result: SkillAccountStatus = {
    id: account.id,
    username: account.username ?? null,
    label: account.label ?? null,
  };
  return result;
}

async function readAccounts(config: ConfigFile | null) {
  const { accountsDb, getDatabasePath } = await import("../db");
  if (!(await Bun.file(getDatabasePath()).exists())) {
    return {
      account: null,
      accountsTotal: 0,
      issues: ["No account: log in with tg auth login"],
    };
  }
  let found: ReturnType<typeof findDefaultAccount>;
  let configured: Account | null;
  try {
    found = findDefaultAccount(accountsDb);
    configured = config ? configuredActiveAccount(config, accountsDb) : null;
  } catch (err) {
    return {
      account: null,
      accountsTotal: null,
      issues: [`Could not read the accounts in ${getDatabasePath()}: ${getErrorMessage(err)}`],
    };
  }
  const total = found.accounts.length;
  if (total === 0) {
    return {
      account: null,
      accountsTotal: 0,
      issues: ["No account: log in with tg auth login"],
    };
  }
  if (!config) return { account: null, accountsTotal: total, issues: [] };
  const selected = configured ?? found.account;
  return {
    account: selected ? accountStatus(selected) : null,
    accountsTotal: total,
    issues: selected
      ? []
      : [
          `${total} accounts and none is active: pass --account or run tg accounts switch --id <id>`,
        ],
  };
}

async function readDaemon(dataDir: string) {
  const path = join(dataDir, "daemon.pid");
  let status: SkillDaemonStatus;
  try {
    await access(path, constants.R_OK);
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      status = { status: "stopped", pid: null };
      return status;
    }
    status = { status: "unknown", pid: null, error: getErrorMessage(err) };
    return status;
  }
  const { createPidFile } = await import("../daemon/pid-file");
  const pid = createPidFile(path).read();
  status = pid === null ? { status: "stopped", pid } : { status: "running", pid };
  return status;
}

export async function validateSkillEnvironment() {
  const envStatus = buildEnvStatus();
  const dataDir = resolveDataDir();
  const dataDirStatus = await checkDataDirAccess(dataDir);
  const { config, issue: configIssue } = await readConfig();
  const accounts = await readAccounts(config);
  const daemon = await readDaemon(dataDir);

  const issues: string[] = [];
  if (!envStatus.telegram_api_id.valid) {
    issues.push("TELEGRAM_API_ID is missing or invalid");
  }
  if (!envStatus.telegram_api_hash.valid) {
    issues.push("TELEGRAM_API_HASH is missing or invalid");
  }
  if (!dataDirStatus.writable) {
    issues.push("Data directory is not writable");
  }
  if (dataDirStatus.exists && !dataDirStatus.is_directory) {
    issues.push("Data directory path is not a directory");
  }
  if (configIssue) issues.push(configIssue);
  issues.push(...accounts.issues);

  const result: SkillValidationResult = {
    valid: issues.length === 0,
    env: envStatus,
    data_dir: dataDirStatus,
    account: accounts.account,
    accounts_total: accounts.accountsTotal,
    daemon,
    issues,
  };
  return result;
}

/** A destination install won't write through */
export class SkillInstallRefused extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "SkillInstallRefused";
  }
}

async function existsNotLink(path: string) {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return false;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new SkillInstallRefused(`${path} is a symbolic link`, path);
  }
  return true;
}

/**
 * Writes SKILL.md to `<dir>/telegram-sync-cli/SKILL.md`, replacing the file
 * there. `dir` itself may be a link; the skill directory and the file in it
 * may not.
 */
export async function installSkill(dir: string) {
  const skillDir = join(dir, SKILL_NAME);
  const path = join(skillDir, "SKILL.md");
  await existsNotLink(skillDir);
  const existed = await existsNotLink(path);
  if (existed && !(await lstat(path)).isFile()) {
    throw new SkillInstallRefused(`${path} is not a regular file`, path);
  }
  await mkdir(skillDir, { recursive: true });
  const temp = join(skillDir, `.SKILL.md.${crypto.randomUUID()}.tmp`);
  const file = await open(temp, "wx");
  try {
    try {
      await file.writeFile(SKILL_MARKDOWN);
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  const result: SkillInstallResult = {
    path,
    bytes: Buffer.byteLength(SKILL_MARKDOWN),
    overwritten: existed,
  };
  return result;
}

export const skillValidateCommand = defineCommand({
  meta: {
    name: "validate",
    description:
      "Check locally: the credentials in the environment, the data directory, config.json, the account record the next command uses and whether a live process holds daemon.pid",
  },
  async run() {
    success(await validateSkillEnvironment());
  },
});

export const skillInstallCommand = defineCommand({
  meta: {
    name: "install",
    description:
      "Write the agent skill to <dir>/telegram-sync-cli/SKILL.md, replacing the file there, local edits included. <dir> is an agent's skills directory",
  },
  args: {
    dir: {
      type: "string",
      description: "Skills directory, such as ~/.claude/skills",
      required: true,
    },
  },
  async run({ args }) {
    const dir = typeof args.dir === "string" ? args.dir.trim() : "";
    if (!dir) {
      error(
        ErrorCodes.INVALID_ARGS,
        "--dir needs a directory",
        undefined,
        "Pass the agent's skills directory, such as --dir ~/.claude/skills",
      );
    }
    try {
      success(await installSkill(dir));
    } catch (err) {
      error(
        ErrorCodes.GENERAL_ERROR,
        "Failed to write the skill",
        {
          reason: getErrorMessage(err),
          ...(err instanceof SkillInstallRefused ? { path: err.path } : {}),
        },
        err instanceof SkillInstallRefused
          ? "Remove it or pass another --dir: install never writes through a link inside the skills directory"
          : undefined,
      );
    }
  },
});

export const skillCommand = defineCommand({
  meta: {
    name: "skill",
    description: "The agent skill: install it, check the setup it needs",
  },
  subCommands: {
    validate: skillValidateCommand,
    install: skillInstallCommand,
  },
});
