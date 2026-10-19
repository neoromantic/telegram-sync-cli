/**
 * E2E tests for help commands
 *
 * Tests --help, --version, subcommand help, and invalid commands.
 * These tests don't require any API access or database seeding.
 */

import { describe, expect, it } from 'bun:test'
import packageJson from '../../package.json' with { type: 'json' }
import { runCli, runCliSuccess } from './helpers/cli'

describe('E2E: Help Commands', () => {
  describe('--help flag', () => {
    it('should show main help with exit code 0', async () => {
      const result = await runCliSuccess(['--help'])

      expect(result.stdout).toContain('tg')
      expect(result.stdout).toContain('Telegram Sync CLI')
      expect(result.stdout).toContain('auth')
      expect(result.stdout).toContain('accounts')
    })

    it('should show help when no command given', async () => {
      const result = await runCli([])

      // citty shows help when no command is given
      expect(result.stdout).toContain('tg')
    })
  })

  describe('--version flag', () => {
    it('should show version with exit code 0', async () => {
      const result = await runCliSuccess(['--version'])

      expect(result.stdout.trim()).toBe(packageJson.version)
    })
  })

  describe('subcommand help', () => {
    it('should show auth help', async () => {
      const result = await runCliSuccess(['auth', '--help'])

      expect(result.stdout).toContain('auth')
      expect(result.stdout).toContain('login')
      expect(result.stdout).toContain('logout')
      expect(result.stdout).toContain('status')
    })

    it('should show accounts help', async () => {
      const result = await runCliSuccess(['accounts', '--help'])

      expect(result.stdout).toContain('accounts')
      expect(result.stdout).toContain('list')
      expect(result.stdout).toContain('switch')
      expect(result.stdout).toContain('remove')
      expect(result.stdout).toContain('info')
    })

    it('should show contacts help', async () => {
      const result = await runCliSuccess(['contacts', '--help'])

      expect(result.stdout).toContain('contacts')
    })
  })

  describe('invalid commands', () => {
    it('should fail for nonexistent command', async () => {
      const result = await runCli(['nonexistent'])

      // citty returns non-zero for unknown commands
      expect(result.exitCode).not.toBe(0)
    })

    it('should fail for invalid subcommand', async () => {
      const result = await runCli(['auth', 'nonexistent'])

      expect(result.exitCode).not.toBe(0)
    })
  })
})
