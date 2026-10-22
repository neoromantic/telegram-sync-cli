import {
  ConfigError,
  getConfigPath,
  getConfigValue,
  setConfigValue,
} from '../config'
import { ErrorCodes } from '../types'
import { error } from './output'

/**
 * Every start makes the account that activeAccount in config.json names
 * active again (src/index.ts setup), so a command that makes another account
 * active writes its ID there too, or the change lasts one command (#61). It
 * writes only when the key is set and names another account, and never
 * creates config.json. Call it before changing data.db: when config.json
 * can't be read or written it fails with INVALID_ARGS or GENERAL_ERROR
 * (`details.path`).
 *
 * `context` says what already happened when the write fails (a login), and
 * `details` and `suggestion` replace the defaults of the GENERAL_ERROR.
 */
export async function keepActiveAccountInConfig(
  accountId: number,
  options: {
    dataDir?: string
    context?: string
    details?: Record<string, unknown>
    suggestion?: string
  } = {},
): Promise<void> {
  const { dataDir, context, details, suggestion } = options
  try {
    const configured = await getConfigValue('activeAccount', { dataDir })
    if (configured !== undefined && configured !== accountId) {
      await setConfigValue('activeAccount', accountId, { dataDir })
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      error(ErrorCodes.INVALID_ARGS, err.message, {
        issues: err.issues,
        ...details,
      })
    }
    const path = getConfigPath(dataDir)
    const failure = `write activeAccount to ${path}: ${(err as Error).message}`
    error(
      ErrorCodes.GENERAL_ERROR,
      context ? `${context}, but could not ${failure}` : `Could not ${failure}`,
      { path, ...details },
      suggestion ?? 'Make config.json writable or remove activeAccount from it',
    )
  }
}
