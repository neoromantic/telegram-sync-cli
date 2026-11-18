/**
 * Skill command helper tests
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  it('validates environment and data directory', async () => {
    const result = await skillModule.validateSkillEnvironment()

    expect(result.env.telegram_api_id.valid).toBe(true)
    expect(result.env.telegram_api_hash.valid).toBe(true)
    expect(result.data_dir.path).toBe(dataDir)
    expect(result.data_dir.writable).toBe(true)
    // No account is logged in to this data dir
    expect(result.valid).toBe(false)
    expect(result.account).toBeNull()
    expect(result.daemon).toEqual({ status: 'stopped', pid: null })
    expect(result.issues).toEqual(['No account: log in with tg auth login'])
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

  it('installs SKILL.md under <dir>/telegram-sync-cli and reports overwrites', async () => {
    const dir = join(dataDir, 'skills')

    try {
      const first = await skillModule.installSkill(dir)
      const path = join(dir, 'telegram-sync-cli', 'SKILL.md')

      expect(first).toEqual({
        path,
        bytes: Buffer.byteLength(skillModule.SKILL_MARKDOWN),
        overwritten: false,
      })
      expect(await Bun.file(path).text()).toBe(skillModule.SKILL_MARKDOWN)

      const second = await skillModule.installSkill(dir)
      expect(second.overwritten).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

      await expect(skillModule.installSkill(readOnlyDir)).rejects.toThrow()
    } finally {
      // Restore permissions before cleanup
      chmodSync(readOnlyDir, 0o755)
      rmSync(readOnlyDir, { recursive: true, force: true })
    }
  })

  it('installSkill throws on ENOTDIR path', async () => {
    // Create a file that blocks the path
    const blockingFile = join(dataDir, 'blocking-install-file.txt')
    await Bun.write(blockingFile, 'block')

    // Try to write to a path through the file
    try {
      await expect(
        skillModule.installSkill(join(blockingFile, 'subdir')),
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

    const readOnlyDir = join(dataDir, 'readonly-skills')
    mkdirSync(readOnlyDir, { recursive: true })

    try {
      chmodSync(readOnlyDir, 0o444)

      await expect(
        skillModule.skillInstallCommand.run?.({
          args: { dir: readOnlyDir },
        } as never),
      ).rejects.toThrow('Failed to write the skill')
    } finally {
      chmodSync(readOnlyDir, 0o755)
      rmSync(readOnlyDir, { recursive: true, force: true })
    }
  })
})
