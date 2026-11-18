/**
 * Skill commands for AI integration
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineCommand } from 'citty'

// Embedded in the compiled binary, so `tg skill install` writes the file the
// repo ships, never a copy that can drift
import skillMarkdown from '../../skills/telegram-sync-cli/SKILL.md' with {
  type: 'text',
}
import { getErrorMessage } from '../daemon/daemon-utils'
import { ErrorCodes } from '../types'
import { error, success } from '../utils/output'

export const SKILL_NAME = 'telegram-sync-cli'

export const SKILL_MARKDOWN: string = skillMarkdown

export interface SkillEnvStatus {
  telegram_api_id: {
    present: boolean
    valid: boolean
  }
  telegram_api_hash: {
    present: boolean
    valid: boolean
  }
}

export interface SkillDataDirStatus {
  path: string
  exists: boolean
  is_directory: boolean
  writable: boolean
  error?: string
}

export interface SkillAccountStatus {
  id: number
  username: string | null
  label: string | null
}

export interface SkillDaemonStatus {
  status: 'running' | 'stopped'
  pid: number | null
}

export interface SkillValidationResult {
  valid: boolean
  env: SkillEnvStatus
  data_dir: SkillDataDirStatus
  /** The account commands use without --account, or null */
  account: SkillAccountStatus | null
  accounts_total: number
  daemon: SkillDaemonStatus
  issues: string[]
}

export interface SkillInstallResult {
  path: string
  bytes: number
  overwritten: boolean
}

function resolveDataDir(): string {
  return (
    process.env.TELEGRAM_SYNC_CLI_DATA_DIR ??
    join(homedir(), '.telegram-sync-cli')
  )
}

function buildEnvStatus(): SkillEnvStatus {
  const apiIdRaw = process.env.TELEGRAM_API_ID ?? ''
  const apiHashRaw = process.env.TELEGRAM_API_HASH ?? ''
  const apiId = Number.parseInt(apiIdRaw, 10)

  return {
    telegram_api_id: {
      present: apiIdRaw.length > 0,
      valid: Number.isFinite(apiId) && apiId > 0,
    },
    telegram_api_hash: {
      present: apiHashRaw.length > 0,
      valid: apiHashRaw.length > 0,
    },
  }
}

/** @internal exported for testing */
export async function tryStat(path: string): Promise<
  | {
      exists: true
      isDirectory: boolean
    }
  | {
      exists: false
      error?: string
    }
> {
  try {
    const stat = await Bun.file(path).stat()
    return { exists: true, isDirectory: stat.isDirectory() }
  } catch (err) {
    const code =
      typeof err === 'object' && err && 'code' in err ? err.code : null
    if (code === 'ENOENT') {
      return { exists: false }
    }
    return { exists: false, error: getErrorMessage(err) }
  }
}

export async function checkDataDirAccess(
  dataDir: string,
): Promise<SkillDataDirStatus> {
  const initialStat = await tryStat(dataDir)
  if (initialStat.exists && !initialStat.isDirectory) {
    return {
      path: dataDir,
      exists: true,
      is_directory: false,
      writable: false,
      error: 'Path exists but is not a directory',
    }
  }

  const probeName = `.tg-skill-probe-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`
  const probePath = join(dataDir, probeName)

  let writable = false
  let errorMessage: string | undefined

  try {
    await Bun.write(probePath, 'probe', { createPath: true })
    writable = true
  } catch (err) {
    errorMessage = getErrorMessage(err)
  }

  if (writable) {
    try {
      await Bun.file(probePath).delete()
    } catch {
      // Ignore cleanup errors
    }
  }

  const finalStat = await tryStat(dataDir)

  return {
    path: dataDir,
    exists: finalStat.exists,
    is_directory: finalStat.exists ? finalStat.isDirectory : false,
    writable,
    ...(errorMessage ? { error: errorMessage } : {}),
  }
}

interface AccountAndDaemon {
  account: SkillAccountStatus | null
  accountsTotal: number
  daemon: SkillDaemonStatus
  issues: string[]
}

/**
 * The account a command picks without --account (the active one, else the
 * only one) and whether the daemon runs. Opening data.db creates the data
 * directory, so this runs only after it proved writable.
 */
async function readAccountAndDaemon(
  dataDir: string,
): Promise<AccountAndDaemon> {
  const [{ accountsDb }, { createPidFile }] = await Promise.all([
    import('../db'),
    import('../daemon/pid-file'),
  ])
  const pid = createPidFile(join(dataDir, 'daemon.pid')).read()
  const daemon: SkillDaemonStatus = {
    status: pid === null ? 'stopped' : 'running',
    pid,
  }
  const accounts = accountsDb.getAll()
  const selected =
    accountsDb.getActive() ?? (accounts.length === 1 ? accounts[0] : null)
  const issues: string[] = []
  if (accounts.length === 0) {
    issues.push('No account: log in with tg auth login')
  } else if (!selected) {
    issues.push(
      `${accounts.length} accounts and none is active: pass --account or run tg accounts switch --id <id>`,
    )
  }
  return {
    account: selected
      ? {
          id: selected.id,
          username: selected.username ?? null,
          label: selected.label ?? null,
        }
      : null,
    accountsTotal: accounts.length,
    daemon,
    issues,
  }
}

export async function validateSkillEnvironment(): Promise<SkillValidationResult> {
  const envStatus = buildEnvStatus()
  const dataDir = resolveDataDir()
  const dataDirStatus = await checkDataDirAccess(dataDir)

  const issues: string[] = []
  if (!envStatus.telegram_api_id.valid) {
    issues.push('TELEGRAM_API_ID is missing or invalid')
  }
  if (!envStatus.telegram_api_hash.valid) {
    issues.push('TELEGRAM_API_HASH is missing or invalid')
  }
  if (!dataDirStatus.writable) {
    issues.push('Data directory is not writable')
  }
  if (dataDirStatus.exists && !dataDirStatus.is_directory) {
    issues.push('Data directory path is not a directory')
  }

  const state: AccountAndDaemon = dataDirStatus.writable
    ? await readAccountAndDaemon(dataDir)
    : {
        account: null,
        accountsTotal: 0,
        daemon: { status: 'stopped', pid: null },
        issues: [],
      }
  issues.push(...state.issues)

  return {
    valid: issues.length === 0,
    env: envStatus,
    data_dir: dataDirStatus,
    account: state.account,
    accounts_total: state.accountsTotal,
    daemon: state.daemon,
    issues,
  }
}

/** Writes SKILL.md to `<dir>/telegram-sync-cli/SKILL.md` */
export async function installSkill(dir: string): Promise<SkillInstallResult> {
  const path = join(dir, SKILL_NAME, 'SKILL.md')
  const existed = await Bun.file(path).exists()
  const bytes = await Bun.write(path, SKILL_MARKDOWN, { createPath: true })
  return { path, bytes, overwritten: existed }
}

export const skillValidateCommand = defineCommand({
  meta: {
    name: 'validate',
    description:
      'Check the credentials, the data directory, the active account and whether the daemon runs',
  },
  async run() {
    success(await validateSkillEnvironment())
  },
})

export const skillInstallCommand = defineCommand({
  meta: {
    name: 'install',
    description:
      "Write the agent skill to <dir>/telegram-sync-cli/SKILL.md, such as an agent's skills directory",
  },
  args: {
    dir: {
      type: 'string',
      description: 'Skills directory, such as ~/.claude/skills',
      required: true,
    },
  },
  async run({ args }) {
    try {
      success(await installSkill(args.dir))
    } catch (err) {
      error(ErrorCodes.GENERAL_ERROR, 'Failed to write the skill', {
        reason: getErrorMessage(err),
      })
    }
  },
})

export const skillCommand = defineCommand({
  meta: {
    name: 'skill',
    description: 'The agent skill: install it, check the setup it needs',
  },
  subCommands: {
    validate: skillValidateCommand,
    install: skillInstallCommand,
  },
})
