/**
 * Database maintenance commands
 *
 * Usage:
 *   tg db vacuum [--account <selector>]  Prune and compact an account's cache
 */

import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { ConfigError, ConfigReadError, getResolvedCacheConfig } from '../config'
import { createPidFile } from '../daemon/pid-file'
import {
  ensureCacheLayout,
  getAccountCachePath,
  getDataDir,
  openExistingAccountCacheDb,
} from '../db'
import {
  type PruneResult,
  pruneCache,
  readAutoVacuum,
  VacuumNeedsStoppedDaemonError,
  vacuumCache,
} from '../db/cache-maintenance'
import { ErrorCodes } from '../types'
import { reportCacheError } from '../utils/account-cache'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccount,
} from '../utils/account-selector'
import { error, success } from '../utils/output'

const STOP_DAEMON_SUGGESTION =
  'tg daemon stop && tg db vacuum && tg daemon start'

function sqliteCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

/** The retention the other commands use; a bad config.json fails as there */
async function loadRetention() {
  try {
    return (await getResolvedCacheConfig()).retention
  } catch (err) {
    if (err instanceof ConfigError) {
      error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
    }
    if (err instanceof ConfigReadError) {
      error(ErrorCodes.GENERAL_ERROR, err.message, { path: err.path })
    }
    throw err
  }
}

function openCache(accountId: number): Database | null {
  try {
    ensureCacheLayout({ mode: 'strict' })
    return openExistingAccountCacheDb(accountId)
  } catch (err) {
    reportCacheError(err, accountId)
  }
}

function needsStoppedDaemon(accountId: number): never {
  error(
    ErrorCodes.DAEMON_ALREADY_RUNNING,
    `The cache of account ${accountId} has no incremental auto_vacuum yet: only a full VACUUM can compact it, and that needs the daemon stopped`,
    { account_id: accountId, auto_vacuum: 'none' },
    STOP_DAEMON_SUGGESTION,
  )
}

const vacuumCommand = defineCommand({
  meta: {
    name: 'vacuum',
    description:
      "Prune an account's cache and give its free space back to the disk",
  },
  args: {
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    json: {
      type: 'boolean',
      description: 'Force JSON output',
      alias: 'j',
      default: false,
    },
  },
  async run({ args }) {
    const account = resolveAccount(args.account)
    const retention = await loadRetention()
    const daemonRunning = createPidFile(
      join(getDataDir(), 'daemon.pid'),
    ).isRunning()

    const db = openCache(account.id)
    const empty: PruneResult = {
      api_activity: 0,
      rate_limits: 0,
      completed_jobs: 0,
      failed_jobs: 0,
    }
    if (!db) {
      success({
        account_id: account.id,
        mode: 'skipped',
        bytes_before: 0,
        bytes_after: 0,
        freed_bytes: 0,
        free_pages_after: 0,
        auto_vacuum: null,
        pruned: empty,
        checkpointed: false,
      })
      return
    }

    // Refuse before writing anything
    if (daemonRunning && readAutoVacuum(db) === 'none') {
      needsStoppedDaemon(account.id)
    }

    // Each prune batch commits on its own, so a later failure keeps it
    let pruned: PruneResult | null = null
    try {
      pruned = pruneCache(db, retention)
      const result = vacuumCache(db, getAccountCachePath(account.id), {
        daemonRunning,
      })
      success({
        account_id: account.id,
        mode: result.mode,
        bytes_before: result.bytes_before,
        bytes_after: result.bytes_after,
        freed_bytes: result.freed_bytes,
        free_pages_after: result.free_pages_after,
        auto_vacuum: result.auto_vacuum,
        pruned,
        checkpointed: result.checkpointed,
      })
    } catch (err) {
      if (err instanceof VacuumNeedsStoppedDaemonError) {
        needsStoppedDaemon(account.id)
      }
      const code = sqliteCode(err)
      const message = err instanceof Error ? err.message : String(err)
      if (code.startsWith('SQLITE_BUSY')) {
        error(
          ErrorCodes.GENERAL_ERROR,
          `The cache of account ${account.id} is busy: ${message}`,
          { account_id: account.id, reason: 'cache_busy', pruned },
          'Another tg process holds the cache; try again in a moment',
        )
      }
      if (code.startsWith('SQLITE_FULL')) {
        error(
          ErrorCodes.GENERAL_ERROR,
          `Not enough disk space to vacuum the cache of account ${account.id}: a full VACUUM needs free space of about twice the cache. The VACUUM was rolled back and the messages are intact; rows past their retention may already be pruned.`,
          { account_id: account.id, reason: 'disk_full', pruned },
          'Free some disk space, then run tg db vacuum again',
        )
      }
      error(
        ErrorCodes.GENERAL_ERROR,
        `Failed to vacuum the cache of account ${account.id}: ${message}`,
        { account_id: account.id, pruned },
      )
    }
  },
})

export const dbCommand = defineCommand({
  meta: {
    name: 'db',
    description: 'Maintain the account caches',
  },
  subCommands: {
    vacuum: vacuumCommand,
  },
})
