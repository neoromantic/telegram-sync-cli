/**
 * CLI version, read from package.json (single source of truth)
 */
import packageJson from '../package.json' with { type: 'json' }

export const VERSION: string = packageJson.version
