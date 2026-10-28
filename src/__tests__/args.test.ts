/**
 * Tests for reading `tg api` method arguments written as `--name value`,
 * and every value of a repeated flag (`tg send --file`)
 */
import { describe, expect, it } from 'bun:test'
import { type ArgsDef, parseArgs } from 'citty'

import { apiCommand } from '../commands/api'
import { sendCommand } from '../commands/send'
import { flagValues, spacedFlagValues } from '../utils/args'

/** The values spacedFlagValues pairs for `tg api <argv>`, from citty's own parse */
function spaced(...argv: string[]): Record<string, string> {
  const args = parseArgs(argv, apiCommand.args as ArgsDef) as Record<
    string,
    unknown
  >
  return Object.fromEntries(spacedFlagValues(argv, args.method as string, args))
}

describe('spacedFlagValues', () => {
  it('pairs a flag with the value after it', () => {
    expect(spaced('account.checkUsername', '--username', 'myuser')).toEqual({
      username: 'myuser',
    })
  })

  it('pairs a dotted name', () => {
    expect(spaced('messages.getHistory', '--peer._', 'inputPeerSelf')).toEqual({
      'peer._': 'inputPeerSelf',
    })
  })

  it.each([
    ['--username=myuser', ['--username=myuser']],
    ['--no-silent x', ['--no-silent', 'x']],
    ['--account 2', ['--account', '2']],
    ['-a 2', ['-a', '2']],
    ['--json x', ['--json', 'x']],
    ['-j x', ['-j', 'x']],
    ['-r', ['-r']],
  ])('leaves %s alone', (_form, argv) => {
    expect(spaced('messages.sendMessage', ...argv)).toEqual({})
  })

  it('keeps a flag followed by another option as true', () => {
    expect(
      spaced('messages.getDialogs', '--excludePinned', '--limit', '10'),
    ).toEqual({ limit: '10' })
  })

  it('keeps a flag at the end as true', () => {
    expect(spaced('messages.sendMessage', '--silent')).toEqual({})
  })

  it.each(['-10', '-1.5'])('takes the negative number %s as a value', (n) => {
    expect(spaced('messages.getHistory', '--addOffset', n)).toEqual({
      addOffset: n,
    })
  })

  it('does not take another value that starts with -', () => {
    expect(spaced('messages.sendMessage', '--message', '-hi')).toEqual({})
  })

  it('pairs only flags after the method', () => {
    expect(
      spaced('--silent', 'messages.sendMessage', '--message', 'hi'),
    ).toEqual({ message: 'hi' })
  })

  it('stops at --', () => {
    // citty reads the --username before -- as true, so only the break stops
    // the pairing with the value after --
    expect(
      spaced(
        'account.checkUsername',
        '--username',
        '--',
        '--username',
        'myuser',
      ),
    ).toEqual({})
  })
})

describe('flagValues', () => {
  it('collects --name value and --name=value', () => {
    expect(
      flagValues(
        ['--to', 'me', '--file', 'a.pdf', '--caption', 'x', '--file=b.png'],
        'file',
      ),
    ).toEqual(['a.pdf', 'b.png'])
  })

  it('stops at a bare --', () => {
    expect(
      flagValues(['--file', 'a.pdf', '--', '--file', 'b'], 'file'),
    ).toEqual(['a.pdf'])
  })

  it('takes the next argument as the value, and counts a flag without one', () => {
    expect(flagValues(['--file', '--file'], 'file')).toEqual(['--file'])
    expect(flagValues(['--to', 'me', '--file'], 'file')).toEqual([''])
  })

  it('ignores other flags with the same prefix', () => {
    expect(flagValues(['--files', 'a', '--file-name=b'], 'file')).toEqual([])
  })

  it('finds the values citty drops: it keeps only the last one', () => {
    const argv = ['--to', 'me', '--file', 'a.pdf', '--file', 'b.png']
    const args = parseArgs(argv, sendCommand.args as ArgsDef) as Record<
      string,
      unknown
    >
    expect(args.file).toBe('b.png')
    expect(flagValues(argv, 'file')).toEqual(['a.pdf', 'b.png'])
  })
})
