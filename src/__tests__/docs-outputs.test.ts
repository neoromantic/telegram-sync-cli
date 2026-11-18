import { describe, expect, it } from 'bun:test'

import { DOC_PATH, updateDoc } from '../../scripts/docs-outputs'

describe('docs:outputs', () => {
  it('docs/cli-commands.md matches the output declarations (run `bun run docs:outputs`)', async () => {
    const doc = await Bun.file(DOC_PATH).text()
    expect(doc).toContain('<!-- output: chats list -->')
    expect(updateDoc(doc)).toBe(doc)
  })
})
