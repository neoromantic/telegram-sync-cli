/**
 * test-setup.ts must point the data dir at a temp dir before any module
 * reads it: src/db/index opens data.db as it loads, and some tests clear
 * tables in the file-backed cache database.
 */
import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { getDataDir } from '../db'

describe('test data dir', () => {
  it('is a temp dir, never the real one', () => {
    expect(getDataDir()).toBe(process.env.TELEGRAM_SYNC_CLI_DATA_DIR!)
    expect(getDataDir()).toContain(`${sep}.tmp${sep}test-data-`)
    expect(getDataDir()).not.toBe(join(homedir(), '.telegram-sync-cli'))
  })
})
