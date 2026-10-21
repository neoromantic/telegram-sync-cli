/**
 * Test setup file for Bun test runner
 * This file is preloaded before tests to ensure proper module initialization
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Ensure test environment is set before any imports
process.env.BUN_ENV = 'test'
process.env.NODE_ENV = 'test'

// Always use a temp data dir. Some tests write and clear the file-backed
// cache database, so a data dir exported in the shell or set in .env (a copy
// of a real one, say) must never reach them.
const testDataDir = join(process.cwd(), '.tmp', `test-data-${process.pid}`)
process.env.TELEGRAM_SYNC_CLI_DATA_DIR = testDataDir
mkdirSync(testDataDir, { recursive: true })

// Always use dummy Telegram API credentials. Bun auto-loads the developer's
// .env before this preload runs, so overwrite (never fall back to) real values
// to keep tests deterministic and offline. The real values are stashed for the
// opt-in integration suite, which passes them to the CLI explicitly.
for (const key of ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH'] as const) {
  const stashKey = key.replace('TELEGRAM_', 'TELEGRAM_TEST_')
  const real = process.env[key]
  if (real && !process.env[stashKey]) {
    process.env[stashKey] = real
  }
}
process.env.TELEGRAM_API_ID = '12345'
process.env.TELEGRAM_API_HASH = 'test-api-hash'
delete process.env.TELEGRAM_PROXY

// Pre-import modules with barrel exports to ensure they're properly resolved
// This helps prevent race conditions during parallel test loading
// Import order matters - import modules without side effects first.
// Dynamic imports, because static ones are hoisted above the code that sets
// the environment: src/db/index reads the data dir and opens data.db as it
// loads, so a static import would open the real ~/.telegram-sync-cli.
await import('./src/types/index')
await import('./src/db/index')
await import('./src/utils/output')
await import('./src/services/telegram')
