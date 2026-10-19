/**
 * Skill command helper tests
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../../package.json' with { type: 'json' }

let skillModule: typeof import('../commands/skill')
let dataDir: string

const originalEnv = {
  apiId: process.env.TELEGRAM_API_ID,
  apiHash: process.env.TELEGRAM_API_HASH,
  dataDir: process.env.TELEGRAM_SYNC_CLI_DATA_DIR,
}

beforeAll(async () => {
  dataDir = join(
    tmpdir(),
    `telegram-sync-cli-skill-test-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  )

  process.env.TELEGRAM_SYNC_CLI_DATA_DIR = dataDir
  process.env.TELEGRAM_API_ID = '12345'
  process.env.TELEGRAM_API_HASH = 'test-hash'

  mkdirSync(dataDir, { recursive: true })

  skillModule = await import('../commands/skill')
})

afterAll(() => {
  if (originalEnv.apiId === undefined) {
    delete process.env.TELEGRAM_API_ID
  } else {
    process.env.TELEGRAM_API_ID = originalEnv.apiId
  }

  if (originalEnv.apiHash === undefined) {
    delete process.env.TELEGRAM_API_HASH
  } else {
    process.env.TELEGRAM_API_HASH = originalEnv.apiHash
  }

  if (originalEnv.dataDir === undefined) {
    delete process.env.TELEGRAM_SYNC_CLI_DATA_DIR
  } else {
    process.env.TELEGRAM_SYNC_CLI_DATA_DIR = originalEnv.dataDir
  }

  rmSync(dataDir, { recursive: true, force: true })
})

describe('Skill Command Helpers', () => {
  it('builds a stable manifest', () => {
    const manifest = skillModule.buildSkillManifest()

    expect(manifest).toMatchObject({
      name: '@goodit/telegram-sync-cli',
      description: 'Agent-friendly Telegram Sync CLI',
      install_command: 'bun install -g @goodit/telegram-sync-cli',
      entrypoint: 'tg',
      version: packageJson.version,
      output: 'json',
    })
  })

  it('validates environment and data directory', async () => {
    const result = await skillModule.validateSkillEnvironment()

    expect(result.valid).toBe(true)
    expect(result.env.telegram_api_id.valid).toBe(true)
    expect(result.env.telegram_api_hash.valid).toBe(true)
    expect(result.data_dir.path).toBe(dataDir)
    expect(result.data_dir.writable).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  it('reports missing environment variables', async () => {
    const prevApiId = process.env.TELEGRAM_API_ID
    const prevApiHash = process.env.TELEGRAM_API_HASH

    try {
      delete process.env.TELEGRAM_API_ID
      delete process.env.TELEGRAM_API_HASH

      const result = await skillModule.validateSkillEnvironment()

      expect(result.valid).toBe(false)
      expect(result.env.telegram_api_id.valid).toBe(false)
      expect(result.env.telegram_api_hash.valid).toBe(false)
      expect(result.issues).toContain('TELEGRAM_API_ID is missing or invalid')
      expect(result.issues).toContain('TELEGRAM_API_HASH is missing or invalid')
    } finally {
      if (prevApiId === undefined) {
        delete process.env.TELEGRAM_API_ID
      } else {
        process.env.TELEGRAM_API_ID = prevApiId
      }

      if (prevApiHash === undefined) {
        delete process.env.TELEGRAM_API_HASH
      } else {
        process.env.TELEGRAM_API_HASH = prevApiHash
      }
    }
  })

  it('reports non-directory data dir paths', async () => {
    const filePath = join(dataDir, 'not-a-dir.txt')
    await Bun.write(filePath, 'test', { createPath: true })

    const status = await skillModule.checkDataDirAccess(filePath)

    expect(status.exists).toBe(true)
    expect(status.is_directory).toBe(false)
    expect(status.writable).toBe(false)
    expect(status.error).toBe('Path exists but is not a directory')

    await Bun.file(filePath)
      .delete()
      .catch(() => {})
  })

  it('installs the manifest and reports overwrites', async () => {
    const targetPath = join(dataDir, 'skill-test.json')

    try {
      const first = await skillModule.installSkillManifest(targetPath)

      expect(first.path).toBe(targetPath)
      expect(first.overwritten).toBe(false)
      expect(first.bytes).toBeGreaterThan(0)
      expect(first.manifest.name).toBe('@goodit/telegram-sync-cli')

      const second = await skillModule.installSkillManifest(targetPath)

      expect(second.overwritten).toBe(true)

      const manifestText = await Bun.file(targetPath).text()
      const manifest = JSON.parse(manifestText)

      expect(manifest.name).toBe('@goodit/telegram-sync-cli')
      expect(manifest.entrypoint).toBe('tg')
    } finally {
      await Bun.file(targetPath)
        .delete()
        .catch(() => {})
    }
  })
})

describe('getErrorMessage', () => {
  it('returns message for Error instances', () => {
    const err = new Error('Test error message')
    expect(skillModule.getErrorMessage(err)).toBe('Test error message')
  })

  it('returns stringified value for non-Error objects', () => {
    expect(skillModule.getErrorMessage('string error')).toBe('string error')
    expect(skillModule.getErrorMessage(42)).toBe('42')
    expect(skillModule.getErrorMessage(null)).toBe('null')
    expect(skillModule.getErrorMessage(undefined)).toBe('undefined')
  })

  it('returns stringified value for plain objects', () => {
    const obj = { code: 'ERR', message: 'fail' }
    expect(skillModule.getErrorMessage(obj)).toBe('[object Object]')
  })

  it('uses custom toString for objects with it', () => {
    const customObj = {
      toString() {
        return 'custom error string'
      },
    }
    expect(skillModule.getErrorMessage(customObj)).toBe('custom error string')
  })
})

describe('tryStat', () => {
  it('returns exists: true and isDirectory for existing directory', async () => {
    const result = await skillModule.tryStat(dataDir)

    expect(result.exists).toBe(true)
    if (result.exists) {
      expect(result.isDirectory).toBe(true)
    }
  })

  it('returns exists: true and isDirectory: false for existing file', async () => {
    const filePath = join(dataDir, 'trystat-test-file.txt')
    await Bun.write(filePath, 'test content')

    try {
      const result = await skillModule.tryStat(filePath)

      expect(result.exists).toBe(true)
      if (result.exists) {
        expect(result.isDirectory).toBe(false)
      }
    } finally {
      await Bun.file(filePath)
        .delete()
        .catch(() => {})
    }
  })

  it('returns exists: false without error for ENOENT', async () => {
    const nonExistentPath = join(dataDir, 'does-not-exist-abc123')

    const result = await skillModule.tryStat(nonExistentPath)

    expect(result.exists).toBe(false)
    // Type assertion needed since TypeScript can't narrow the union
    const notExistsResult = result as { exists: false; error?: string }
    expect(notExistsResult.error).toBeUndefined()
  })

  it('returns exists: false with error for non-ENOENT errors', async () => {
    // Use a path that causes ENOTDIR error - trying to stat a path
    // through a file as if it were a directory
    const filePath = join(dataDir, 'blocking-file.txt')
    await Bun.write(filePath, 'block')
    const invalidPath = join(filePath, 'subpath', 'child')

    try {
      const result = await skillModule.tryStat(invalidPath)

      expect(result.exists).toBe(false)
      // Type assertion needed since TypeScript can't narrow the union
      const notExistsResult = result as { exists: false; error?: string }
      expect(notExistsResult.error).toBeDefined()
      expect(typeof notExistsResult.error).toBe('string')
    } finally {
      await Bun.file(filePath)
        .delete()
        .catch(() => {})
    }
  })
})

describe('checkDataDirAccess write failure', () => {
  it('reports write failure when directory is not writable', async () => {
    // Skip on Windows where chmod behaves differently
    if (process.platform === 'win32') {
      return
    }

    const readOnlyDir = join(dataDir, 'readonly-dir')
    mkdirSync(readOnlyDir, { recursive: true })

    try {
      // Make directory read-only (remove write permission)
      chmodSync(readOnlyDir, 0o444)

      const status = await skillModule.checkDataDirAccess(readOnlyDir)

      expect(status.exists).toBe(true)
      expect(status.is_directory).toBe(true)
      expect(status.writable).toBe(false)
      expect(status.error).toBeDefined()
      expect(typeof status.error).toBe('string')
    } finally {
      // Restore permissions before cleanup
      chmodSync(readOnlyDir, 0o755)
      rmSync(readOnlyDir, { recursive: true, force: true })
    }
  })

  it('reports write failure for path through a file', async () => {
    const filePath = join(dataDir, 'file-not-dir.txt')
    await Bun.write(filePath, 'content')

    // Try to treat the file as a directory - Bun.write with createPath
    // should fail when trying to create subdirectory under a file
    const invalidPath = join(filePath, 'subdir')

    try {
      const status = await skillModule.checkDataDirAccess(invalidPath)

      // This should fail because filePath is a file, not a directory
      expect(status.writable).toBe(false)
    } finally {
      await Bun.file(filePath)
        .delete()
        .catch(() => {})
    }
  })
})

describe('skillInstallCommand error path', () => {
  it('calls error() when write to invalid path fails', async () => {
    // Skip on Windows where chmod behaves differently
    if (process.platform === 'win32') {
      return
    }

    // Create a read-only directory to cause write failure
    const readOnlyDir = join(dataDir, 'readonly-install-dir')
    mkdirSync(readOnlyDir, { recursive: true })

    try {
      // Make directory read-only
      chmodSync(readOnlyDir, 0o444)

      const targetPath = join(readOnlyDir, 'skill.json')

      // installSkillManifest should throw when it can't write
      await expect(
        skillModule.installSkillManifest(targetPath),
      ).rejects.toThrow()
    } finally {
      // Restore permissions before cleanup
      chmodSync(readOnlyDir, 0o755)
      rmSync(readOnlyDir, { recursive: true, force: true })
    }
  })

  it('installSkillManifest throws on ENOTDIR path', async () => {
    // Create a file that blocks the path
    const blockingFile = join(dataDir, 'blocking-install-file.txt')
    await Bun.write(blockingFile, 'block')

    // Try to write to a path through the file
    const invalidPath = join(blockingFile, 'subdir', 'skill.json')

    try {
      await expect(
        skillModule.installSkillManifest(invalidPath),
      ).rejects.toThrow()
    } finally {
      await Bun.file(blockingFile)
        .delete()
        .catch(() => {})
    }
  })

  it('skillInstallCommand.run catches error and calls error()', async () => {
    // Skip on Windows where chmod behaves differently
    if (process.platform === 'win32') {
      return
    }

    // Make the data dir read-only so skillInstallCommand.run() will fail
    // when it tries to write to the default skill.json path
    const prevDataDir = process.env.TELEGRAM_SYNC_CLI_DATA_DIR
    const readOnlyDataDir = join(dataDir, 'readonly-data')
    mkdirSync(readOnlyDataDir, { recursive: true })

    try {
      // Make directory read-only
      chmodSync(readOnlyDataDir, 0o444)
      process.env.TELEGRAM_SYNC_CLI_DATA_DIR = readOnlyDataDir

      // Re-import the module to pick up the new env
      const freshModule = await import('../commands/skill')

      // The command should throw (via error()) when it can't write
      await expect(
        freshModule.skillInstallCommand.run?.({} as never),
      ).rejects.toThrow('Failed to write skill manifest')
    } finally {
      // Restore permissions and env before cleanup
      chmodSync(readOnlyDataDir, 0o755)
      rmSync(readOnlyDataDir, { recursive: true, force: true })
      if (prevDataDir === undefined) {
        delete process.env.TELEGRAM_SYNC_CLI_DATA_DIR
      } else {
        process.env.TELEGRAM_SYNC_CLI_DATA_DIR = prevDataDir
      }
    }
  })
})
