/**
 * E2E tests for usage stats: the notice, what a run sends, the off switches
 * and tg telemetry. TELEGRAM_SYNC_CLI_TELEMETRY=debug prints each event to
 * stderr instead of sending it, so nothing leaves the machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli, runCliSuccess } from './helpers/cli'

interface Event {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
}

const NO_AGENT = {
  AI_AGENT: undefined,
  CLAUDECODE: undefined,
  CODEX_SANDBOX: undefined,
  CODEX_THREAD_ID: undefined,
  CURSOR_AGENT: undefined,
  GEMINI_CLI: undefined,
  DO_NOT_TRACK: undefined,
}

const NOTICE = 'telegram-sync-cli shares usage stats with its author'

/** The events a run printed in debug mode */
function events(stderr: string): Event[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('[telemetry] '))
    .map((line) => JSON.parse(line.slice('[telemetry] '.length)) as Event)
}

describe('usage stats', () => {
  let dataDir: string
  let stateFile: string
  /** An agent runs tg; events are printed, not sent */
  let debug: Record<string, string | undefined>

  const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'))
  /** As if an earlier run had shown the notice */
  const noticeSeen = () =>
    writeFileSync(
      stateFile,
      '{"id":null,"enabled":null,"notice":1,"installed":false,"daily":{}}\n',
    )

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-e2e-telemetry-'))
    stateFile = join(dataDir, 'telemetry.json')
    debug = {
      ...NO_AGENT,
      AI_AGENT: 'e2e',
      TELEGRAM_SYNC_CLI_DATA_DIR: dataDir,
      TELEGRAM_SYNC_CLI_TELEMETRY: 'debug',
    }
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('are off in a source checkout, and tg telemetry status says why', async () => {
    const result = await runCliSuccess(['telemetry', 'status', '--json'], {
      env: { TELEGRAM_SYNC_CLI_DATA_DIR: dataDir },
    })
    expect(result.json).toMatchObject({
      success: true,
      data: {
        enabled: false,
        reason: 'no-endpoint',
        endpoint: '',
        id: null,
        stateFile,
        channel: 'source',
      },
    })
    expect(existsSync(stateFile)).toBe(false)
  })

  it('show the notice once, in a run that sends nothing', async () => {
    const first = await runCli(['chats', 'list'], { env: debug })
    expect(first.exitCode).toBe(2)
    expect(first.stderr).toContain(NOTICE)
    expect(first.stderr).toContain('`tg telemetry off`')
    expect(events(first.stderr)).toEqual([])
    expect(readState()).toMatchObject({ notice: 1, installed: false })

    const second = await runCli(['chats', 'list'], { env: debug })
    expect(second.stderr).not.toContain(NOTICE)
    expect(events(second.stderr).length).toBeGreaterThan(0)
  })

  it('send the command path and the error code, never arguments', async () => {
    noticeSeen()
    const result = await runCli(
      ['chats', 'search', '--query', 'Weekend Crew', '--limit', '7'],
      { env: debug },
    )
    // The exit code is the command's, after the events
    expect(result.exitCode).toBe(2)
    const sent = events(result.stderr)
    expect(sent.map((e) => e.event)).toEqual([
      'app_installed',
      'app_started',
      'feature_used',
      'error_occurred',
    ])
    expect(sent[2]?.properties.feature).toBe('chats search')
    expect(sent[3]?.properties.error_type).toBe('AUTH_REQUIRED')
    expect(sent[3]?.properties).not.toHaveProperty('error_message')
    for (const e of sent) {
      expect(e.distinct_id).toBe(readState().id)
      expect(e.properties).toMatchObject({
        product: 'telegram-sync-cli',
        channel: 'source',
        mode: 'agent',
        agent: 'e2e',
      })
    }
    expect(JSON.stringify(sent)).not.toContain('Weekend')
  })

  it("send a config file error's type and message", async () => {
    noticeSeen()
    writeFileSync(join(dataDir, 'config.json'), '{"activeAccount": "Jane"}\n')
    const result = await runCli(['chats', 'list'], { env: debug })
    expect(result.exitCode).toBe(3)
    const errors = events(result.stderr).filter(
      (e) => e.event === 'error_occurred',
    )
    expect(errors.map((e) => e.properties)).toMatchObject([
      {
        error_type: 'ConfigError',
        error_message: 'Config file has invalid values',
      },
    ])
  })

  it('send an unknown subcommand as other', async () => {
    noticeSeen()
    const result = await runCli(['chats', 'secret-name'], { env: debug })
    const features = events(result.stderr)
      .filter((e) => e.event === 'feature_used')
      .map((e) => e.properties.feature)
    expect(features).toEqual(['other'])
  })

  it('report the daemon as a daemon, once a day', async () => {
    noticeSeen()
    const result = await runCli(['daemon', 'start'], {
      env: { ...debug, TELEGRAM_API_ID: undefined },
    })
    expect(result.exitCode).toBe(1)
    const sent = events(result.stderr)
    expect(sent.every((e) => e.properties.mode === 'daemon')).toBe(true)
    expect(
      sent.find((e) => e.event === 'feature_used')?.properties.feature,
    ).toBe('daemon start')
    expect(
      sent.find((e) => e.event === 'error_occurred')?.properties.error_type,
    ).toBe('MissingCredentialsError')
    expect(Object.keys(readState().daily)).toContain('app_started')
  })

  it('stay quiet without a terminal or an agent, and with -q', async () => {
    for (const args of [
      ['chats', 'list'],
      ['-q', 'chats', 'list'],
    ]) {
      const env = args[0] === '-q' ? debug : { ...debug, AI_AGENT: undefined }
      const result = await runCli(args, { env })
      expect(result.stderr).not.toContain(NOTICE)
      expect(events(result.stderr)).toEqual([])
    }
    expect(existsSync(stateFile)).toBe(false)
  })

  it('stop with DO_NOT_TRACK=1', async () => {
    noticeSeen()
    const result = await runCli(['chats', 'list'], {
      env: { ...debug, DO_NOT_TRACK: '1' },
    })
    expect(events(result.stderr)).toEqual([])
  })

  it('are not recorded by tg telemetry itself', async () => {
    noticeSeen()
    const result = await runCliSuccess(['telemetry', 'status'], { env: debug })
    expect(events(result.stderr)).toEqual([])
    expect(result.json).toMatchObject({
      data: { enabled: true, debug: true, reason: 'env' },
    })
  })

  it('turn off and on with tg telemetry off/on', async () => {
    const env = { TELEGRAM_SYNC_CLI_DATA_DIR: dataDir }
    const on = await runCliSuccess(['telemetry', 'on'], { env })
    expect(readState()).toMatchObject({ enabled: true, notice: 1 })
    expect(readState().id).toMatch(/^[0-9a-f-]{36}$/)
    expect((on.json as { data: { id: string } }).data.id).toBe(readState().id)

    await runCliSuccess(['telemetry', 'off'], { env })
    expect(readState()).toEqual({
      id: null,
      enabled: false,
      notice: 1,
      installed: false,
      daily: {},
    })
  })
})
