/**
 * Tests for reading `tg api` method arguments written as `--name value`
 */
import { describe, expect, it } from 'bun:test'
import { type ArgsDef, parseArgs } from 'citty'

import { apiCommand } from '../commands/api'
import { spacedFlagValues } from '../utils/args'

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
    expect(
      spaced('account.checkUsername', '--', '--username', 'myuser'),
    ).toEqual({})
  })
})
