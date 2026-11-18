/**
 * E2E tests for skill commands
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { runCli, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const SKILL_PATH = join(
  import.meta.dir,
  '../../skills/telegram-sync-cli/SKILL.md',
)

const VALID_ENV = {
  TELEGRAM_API_ID: '12345',
  TELEGRAM_API_HASH: 'test-hash',
}

interface ValidateData {
  valid: boolean
  account: { id: number; username: string | null; label: string | null } | null
  accounts_total: number
  daemon: { status: 'running' | 'stopped'; pid: number | null }
  issues: string[]
}

describe('E2E: Skill Commands', () => {
  let env: TestEnvironment

  afterEach(() => env.cleanup())

  const validate = async () => {
    const result = await runCliSuccess(['skill', 'validate'], {
      env: { ...env.getCliOptions().env, ...VALID_ENV },
    })
    return (result.json as { data: ValidateData }).data
  }

  it('install writes the repo SKILL.md into <dir>/telegram-sync-cli', async () => {
    env = createTestEnvironment('skill-install')
    const dir = join(env.dataDir, 'agent-skills')

    const first = await runCliSuccess(
      ['skill', 'install', '--dir', dir],
      env.getCliOptions(),
    )
    const path = join(dir, 'telegram-sync-cli', 'SKILL.md')
    const expected = await Bun.file(SKILL_PATH).text()

    expect(first.json).toMatchObject({
      success: true,
      data: { path, overwritten: false },
    })
    expect(await Bun.file(path).text()).toBe(expected)

    const second = await runCliSuccess(
      ['skill', 'install', '--dir', dir],
      env.getCliOptions(),
    )
    expect(second.json).toMatchObject({ data: { overwritten: true } })
  })

  it('install needs --dir', async () => {
    env = createTestEnvironment('skill-install-no-dir')

    const result = await runCli(['skill', 'install'], env.getCliOptions())

    expect(result.exitCode).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('--dir')
  })

  it('validate reports the active account and a stopped daemon', async () => {
    env = createTestEnvironment('skill-validate')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000001', username: 'example_one', label: 'home' },
      {
        phone: '+15550000002',
        username: 'example_two',
        label: 'work',
        is_active: true,
      },
    ])

    const data = await validate()

    expect(data).toMatchObject({
      valid: true,
      account: { id: 2, username: 'example_two', label: 'work' },
      accounts_total: 2,
      daemon: { status: 'stopped', pid: null },
      issues: [],
    })
  })

  it('validate reports a running daemon', async () => {
    env = createTestEnvironment('skill-validate-daemon')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000001' }])
    // A live PID stands in for the daemon: validate only reads the PID file
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))

    const data = await validate()

    expect(data.account?.id).toBe(1)
    expect(data.daemon).toEqual({ status: 'running', pid: process.pid })
  })

  it('validate names a missing or ambiguous account as an issue', async () => {
    env = createTestEnvironment('skill-validate-accounts')
    env.initDatabase()

    const none = await validate()
    expect(none).toMatchObject({
      valid: false,
      account: null,
      accounts_total: 0,
      issues: ['No account: log in with tg auth login'],
    })

    env.seedAccounts([{ phone: '+15550000001' }, { phone: '+15550000002' }])
    const two = await validate()
    expect(two.valid).toBe(false)
    expect(two.account).toBeNull()
    expect(two.issues).toEqual([
      '2 accounts and none is active: pass --account or run tg accounts switch --id <id>',
    ])
  })
})
