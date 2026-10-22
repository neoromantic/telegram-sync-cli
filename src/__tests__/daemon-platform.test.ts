/**
 * The daemon's mtcute platform keeps session files open until the daemon
 * closes its clients (#56). Each case runs a real mtcute client on a temp
 * session file in a child process, because the signal and the exit are
 * process-wide. No network: prepare() only opens the session file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHILD = join(import.meta.dir, 'helpers', 'session-exit-child.ts')

function runChild(
  mode: 'signal' | 'exit' | 'read',
  dir: string,
): { exitCode: number; output: string; json: Record<string, unknown> } {
  const result = Bun.spawnSync(['bun', '--no-env-file', CHILD, mode, dir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString()
  const output = `${stdout}${result.stderr.toString()}`
  const line = stdout.trim().split('\n').at(-1) ?? ''
  let json: Record<string, unknown>
  try {
    json = JSON.parse(line)
  } catch {
    throw new Error(`The ${mode} child printed no result:\n${output}`)
  }
  return { exitCode: result.exitCode, output, json }
}

describe('daemon platform', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-daemon-platform-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a session write after SIGTERM is saved when the client closes', () => {
    const signal = runChild('signal', dir)
    expect(signal.json).toEqual({
      // mtcute adds no signal listeners of its own
      mtcuteListeners: { SIGTERM: 0, SIGINT: 0 },
      // The signal isn't sent a second time
      handlerRuns: 1,
      errors: [],
    })
    expect(signal.exitCode).toBe(0)

    const read = runChild('read', dir)
    expect(read.json).toEqual({ pts: 31337, selfUserId: 4242 })

    for (const output of [signal.output, read.output]) {
      expect(output).not.toContain('Database has closed')
    }
  })

  it('an exit without closing the client saves the queued session writes', () => {
    const exit = runChild('exit', dir)
    expect(exit.json).toEqual({ queued: true })
    expect(exit.exitCode).toBe(1)
    expect(exit.output).not.toContain('Failed to save a session file')

    expect(runChild('read', dir).json).toEqual({ pts: 4242, selfUserId: null })
  })
})
