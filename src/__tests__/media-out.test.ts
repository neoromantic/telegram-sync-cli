/**
 * Publishing a --out copy (src/commands/media/out.ts): no-clobber without
 * --overwrite, on filesystems with and without hard links, and the advice a
 * collision gets. Made-up bytes in temp dirs only.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DownloadResult } from '../commands/media/download-media'
import { MediaError } from '../commands/media/errors'
import { copyOut } from '../commands/media/out'
import { ErrorCodes } from '../types'
import { fakeBytes } from './helpers/photo-message'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'tg-media-out-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** A downloaded file in the media cache */
function cached(bytes: Uint8Array, messageId = 1): DownloadResult {
  const path = join(root, `cache-${messageId}.bin`)
  fs.writeFileSync(path, bytes)
  return {
    path,
    fileName: 'example-notes.txt',
    mimeType: 'text/plain',
    size: bytes.length,
    kind: 'document',
    chatId: 5_550_001,
    messageId,
    uniqueFileId: `unique-${messageId}`,
    groupedId: null,
    cached: true,
    resumedFrom: null,
    thumb: null,
  }
}

async function refusal(promise: Promise<unknown>): Promise<MediaError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the copy to be refused')
    },
    (reason: unknown) => reason,
  )
  expect(err).toBeInstanceOf(MediaError)
  return err as MediaError
}

/** Leftover temporary copies next to the target */
function parts(): string[] {
  return fs.readdirSync(join(root, 'out')).filter((n) => n.endsWith('.part'))
}

describe('copyOut on a filesystem without hard links', () => {
  for (const code of ['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV']) {
    it(`writes a new file when link fails with ${code}`, async () => {
      const link = spyOn(fs, 'linkSync').mockImplementation(() => {
        throw Object.assign(new Error(`${code}: link`), { code })
      })
      try {
        const bytes = fakeBytes(70_000)
        const target = join(root, 'out', 'notes.txt')
        expect(await copyOut(cached(bytes), target, false)).toBe(target)
        expect(link).toHaveBeenCalled()
        expect(Buffer.compare(fs.readFileSync(target), bytes)).toBe(0)
        expect(parts()).toEqual([])
      } finally {
        link.mockRestore()
      }
    })
  }

  it('still refuses to replace a file that appears before the copy', async () => {
    const target = join(root, 'out', 'notes.txt')
    const link = spyOn(fs, 'linkSync').mockImplementation(() => {
      // Another writer wins the race between the existence check and publish
      fs.writeFileSync(target, 'edited copy')
      throw Object.assign(new Error('EPERM: link'), { code: 'EPERM' })
    })
    try {
      const err = await refusal(copyOut(cached(fakeBytes(70_000)), target, false))
      expect(err.code).toBe(ErrorCodes.FILE_EXISTS)
      expect(fs.readFileSync(target, 'utf-8')).toBe('edited copy')
      expect(parts()).toEqual([])
    } finally {
      link.mockRestore()
    }
  })
})

describe('copyOut collisions in a batch', () => {
  it('points at --overwrite for a file an earlier run left', async () => {
    const target = join(root, 'out', 'notes.txt')
    fs.mkdirSync(join(root, 'out'))
    fs.writeFileSync(target, 'edited copy')
    const err = await refusal(
      copyOut(cached(fakeBytes(70_000)), target, false, new Set()),
    )
    expect(err.code).toBe(ErrorCodes.FILE_EXISTS)
    expect(err.suggestion).toContain('--overwrite')
  })

  it.each([false, true])(
    'asks for distinct paths when another file of the batch took it (overwrite %s)',
    async (overwrite) => {
      const target = join(root, 'out', 'notes.txt')
      const published = new Set<string>()
      await copyOut(cached(fakeBytes(70_000), 1), target, overwrite, published)
      const err = await refusal(
        copyOut(cached(fakeBytes(70_000, 3), 2), target, overwrite, published),
      )
      expect(err.code).toBe(ErrorCodes.FILE_EXISTS)
      expect(err.suggestion).toBe('use a distinct output path for each file')
    },
  )
})
