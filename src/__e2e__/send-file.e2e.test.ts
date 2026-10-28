/**
 * E2E tests for the arguments of `tg send --file`: every mistake is
 * INVALID_ARGS (exit 3) before an account cache or Telegram is needed,
 * so they run without credentials. Made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { NO_CREDENTIALS, runCli } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: send --file arguments', () => {
  let env: TestEnvironment
  let filesDir: string

  beforeEach(() => {
    env = createTestEnvironment('send-file')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000000', user_id: 5_550_001, is_active: true },
    ])
    filesDir = join(env.dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    writeFileSync(join(filesDir, 'report.pdf'), 'made-up report')
    writeFileSync(join(filesDir, 'lake.jpg'), 'made-up photo')
    writeFileSync(join(filesDir, 'empty.txt'), '')
  })

  afterEach(() => {
    env.cleanup()
  })

  async function send(args: string[]) {
    return runCli(['send', '--to', 'me', ...args], {
      env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
    })
  }

  async function expectInvalid(
    args: string[],
    message: string,
    details?: Record<string, unknown>,
  ) {
    const result = await send(args)
    expect(result.exitCode).toBe(3)
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: 'INVALID_ARGS',
        message: expect.stringContaining(message),
        ...(details ? { details } : {}),
      },
    })
  }

  it('needs --message or --file', async () => {
    await expectInvalid([], 'Pass --message <text> or --file <path>')
  })

  it('refuses --message with --file', async () => {
    await expectInvalid(
      ['--message', 'hi', '--file', join(filesDir, 'report.pdf')],
      'Use --caption for the text sent with --file',
    )
  })

  it('refuses --caption and --force-document without --file', async () => {
    await expectInvalid(
      ['--message', 'hi', '--caption', 'Q3'],
      '--caption needs --file',
    )
    await expectInvalid(
      ['--message', 'hi', '--force-document'],
      '--force-document needs --file',
    )
  })

  it('refuses two files: albums are not supported yet', async () => {
    const pdf = join(filesDir, 'report.pdf')
    const jpg = join(filesDir, 'lake.jpg')
    await expectInvalid(
      ['--file', pdf, `--file=${jpg}`],
      "albums aren't supported yet",
      { files: [pdf, jpg] },
    )
  })

  it('refuses a missing path, a directory and an empty file', async () => {
    const missing = join(filesDir, 'missing.pdf')
    await expectInvalid(['--file', missing], 'Not a readable file', {
      file: missing,
    })
    await expectInvalid(['--file', filesDir], 'Not a readable file', {
      file: filesDir,
    })
    const empty = join(filesDir, 'empty.txt')
    await expectInvalid(['--file', empty], 'File is empty', { file: empty })
  })

  it('keeps refusing empty message text', async () => {
    await expectInvalid(['--message', '  '], 'Message text cannot be empty')
  })

  it('accepts a readable file and only then needs credentials', async () => {
    const result = await send([
      '--file',
      join(filesDir, 'report.pdf'),
      '--caption',
      'Q3',
    ])
    expect(result.exitCode).toBe(3)
    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS', details: { issues: expect.any(Array) } },
    })
  })
})
