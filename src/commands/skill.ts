import { homedir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";

import { getErrorMessage } from "../daemon/daemon-utils";
import { ErrorCodes } from "../types";
import { error, success } from "../utils/output";
import { VERSION } from "../version";

export interface SkillManifest {
  name: string;
  description: string;
  install_command: string;
  entrypoint: string;
  version: string;
  output: "json";
}

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

export interface SkillValidationResult {
  valid: boolean;
  env: SkillEnvStatus;
  data_dir: SkillDataDirStatus;
  issues: string[];
}

export interface SkillInstallResult {
  path: string;
  bytes: number;
  overwritten: boolean;
  manifest: SkillManifest;
}

function resolveDataDir() {
  return process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? join(homedir(), ".telegram-sync-cli");
}

export function buildSkillManifest() {
  const result: SkillManifest = {
    name: "@goodit/telegram-sync-cli",
    description: "Agent-friendly Telegram Sync CLI",
    install_command: "bun install -g @goodit/telegram-sync-cli",
    entrypoint: "tg",
    version: VERSION,
    output: "json",
  };
  return result;
}

export function getSkillManifestPath() {
  return join(resolveDataDir(), "skill.json");
}

function buildEnvStatus() {
  const apiIdRaw = process.env.TELEGRAM_API_ID ?? "";
  const apiHashRaw = process.env.TELEGRAM_API_HASH ?? "";
  const apiId = Number.parseInt(apiIdRaw, 10);

  return {
    telegram_api_id: {
      present: apiIdRaw.length > 0,
      valid: Number.isFinite(apiId) && apiId > 0,
    },
    telegram_api_hash: {
      present: apiHashRaw.length > 0,
      valid: apiHashRaw.length > 0,
    },
  };
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
    const code = typeof err === "object" && err && "code" in err ? err.code : null;
    if (code === "ENOENT") {
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

export async function validateSkillEnvironment() {
  const envStatus = buildEnvStatus();
  const dataDirStatus = await checkDataDirAccess(resolveDataDir());

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

  const result: SkillValidationResult = {
    valid: issues.length === 0,
    env: envStatus,
    data_dir: dataDirStatus,
    issues,
  };
  return result;
}

export async function installSkillManifest(targetPath = getSkillManifestPath()) {
  const manifest = buildSkillManifest();
  const payload = `${JSON.stringify(manifest, null, 2)}\n`;
  const existed = await Bun.file(targetPath).exists();

  await Bun.write(targetPath, payload, { createPath: true });

  const result: SkillInstallResult = {
    path: targetPath,
    bytes: payload.length,
    overwritten: existed,
    manifest,
  };
  return result;
}

export const skillManifestCommand = defineCommand({
  meta: {
    name: "manifest",
    description: "Print the skill manifest JSON",
  },
  async run() {
    success(buildSkillManifest());
  },
});

export const skillValidateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate environment and data directory access",
  },
  async run() {
    const result = await validateSkillEnvironment();
    success(result);
  },
});

export const skillInstallCommand = defineCommand({
  meta: {
    name: "install",
    description: "Write the skill manifest to the default location",
  },
  async run() {
    try {
      const result = await installSkillManifest();
      success(result);
    } catch (err) {
      error(ErrorCodes.GENERAL_ERROR, "Failed to write skill manifest", {
        reason: getErrorMessage(err),
      });
    }
  },
});

export const skillCommand = defineCommand({
  meta: {
    name: "skill",
    description: "AI skill helpers (manifest, validate, install)",
  },
  subCommands: {
    manifest: skillManifestCommand,
    validate: skillValidateCommand,
    install: skillInstallCommand,
  },
});
