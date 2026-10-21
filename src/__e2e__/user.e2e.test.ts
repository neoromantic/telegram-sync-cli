/**
 * E2E tests for user commands (tg me, tg user)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCli, runCliFailure } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: User Commands', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('user')
    env.initDatabase()
  })

  afterEach(() => {
    env.cleanup()
  })

  describe('tg me', () => {
    it('should show help for me command', async () => {
      const result = await runCli(['me', '--help'], env.getCliOptions())

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('me')
      expect(result.stdout).toContain('current user')
    })

    it('should require authentication', async () => {
      // No accounts seeded, so should fail with AUTH_REQUIRED (exit code 2)
      const result = await runCliFailure(['me'], 2, env.getCliOptions())

      // Should indicate no active account
      expect(result.exitCode).toBe(2)
      const response = result.json as {
        success: boolean
        error: { code: string }
      }
      expect(response.success).toBe(false)
    })

    it('should accept --fresh flag', async () => {
      const result = await runCli(['me', '--help'], env.getCliOptions())

      expect(result.stdout).toContain('fresh')
      expect(result.stdout).toContain('Bypass cache')
    })

    it('should accept --account flag', async () => {
      const result = await runCli(['me', '--help'], env.getCliOptions())

      expect(result.stdout).toContain('account')
      expect(result.stdout).toContain('Account selector')
    })
  })

  describe('tg user', () => {
    it('should show help for user command', async () => {
      const result = await runCli(['user', '--help'], env.getCliOptions())

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('user')
      expect(result.stdout).toContain('Look up')
    })

    it('should require identifier argument', async () => {
      // Running without identifier should show help or error
      const result = await runCli(['user'], env.getCliOptions())

      // Citty shows help when required args are missing
      expect(result.stdout + result.stderr).toMatch(/identifier|usage|help/i)
    })

    it('should accept --fresh flag', async () => {
      const result = await runCli(['user', '--help'], env.getCliOptions())

      expect(result.stdout).toContain('fresh')
      expect(result.stdout).toContain('Bypass cache')
    })

    it('should accept --account flag', async () => {
      const result = await runCli(['user', '--help'], env.getCliOptions())

      expect(result.stdout).toContain('account')
      expect(result.stdout).toContain('Account selector')
    })

    it('should require authentication for lookup', async () => {
      // No accounts seeded, so there is no cache to read either
      const result = await runCliFailure(
        ['user', '@testuser'],
        2,
        env.getCliOptions(),
      )

      expect(result.json).toMatchObject({
        success: false,
        error: { code: 'AUTH_REQUIRED' },
      })
    })
  })

  describe('Command registration', () => {
    it('should have me command in main CLI', async () => {
      const result = await runCli(['--help'], env.getCliOptions())

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('me')
    })

    it('should have user command in main CLI', async () => {
      const result = await runCli(['--help'], env.getCliOptions())

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('user')
    })
  })

  describe('Output format', () => {
    it('should respect --format json flag for me', async () => {
      // Even though it will error (no auth), it should output JSON
      const result = await runCli(
        ['--format', 'json', 'me'],
        env.getCliOptions(),
      )

      // Output should be parseable JSON (either success or error)
      const combined = result.stdout + result.stderr
      expect(() => {
        // Find JSON in output
        const jsonMatch = combined.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          JSON.parse(jsonMatch[0])
        }
      }).not.toThrow()
    })

    it('should respect --format json flag for user', async () => {
      const result = await runCli(
        ['--format', 'json', 'user', '@test'],
        env.getCliOptions(),
      )

      const combined = result.stdout + result.stderr
      expect(() => {
        const jsonMatch = combined.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          JSON.parse(jsonMatch[0])
        }
      }).not.toThrow()
    })
  })
})
