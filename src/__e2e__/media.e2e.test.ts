/**
 * E2E tests for tg media: the media cache under accounts/<id>/media, read
 * and cleaned offline, without Telegram credentials. Made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { pdfDocumentMessage } from '../__tests__/helpers/media-messages'
import { photoMessage } from '../__tests__/helpers/photo-message'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createMessagesCache } from '../db/messages-cache'
import { extractAttachment } from '../utils/attachment'
import { NO_CREDENTIALS, runCli, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const SELF_ID = 5_550_001
const OTHER_CHAT_ID = 5_550_002
const DAY = 24 * 60 * 60 * 1000

interface CleanResult {
  success: boolean
  data: {
    accountId: number
    removedFiles: number
    removedPartialFiles: number
    freedBytes: number
    keptFiles: number
    sharedFiles: number
    filters: { all: boolean; olderThan: string | null; chat: number | null }
  }
}

describe('E2E: media clean', () => {
  let env: TestEnvironment
  let mediaDir: string

  beforeEach(() => {
    env = createTestEnvironment('media-clean')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000000', user_id: SELF_ID, is_active: true },
    ])
    env.openCacheDb(1)
    mediaDir = join(env.dataDir, 'accounts', '1', 'media')
  })

  afterEach(() => {
    env.cleanup()
  })

  /** A cached file of `size` bytes last used `ageMs` ago */
  function place(folder: string, name: string, size: number, ageMs = 0) {
    const path = join(mediaDir, folder, name)
    mkdirSync(join(mediaDir, folder), { recursive: true })
    writeFileSync(path, Buffer.alloc(size, 1))
    const at = new Date(Date.now() - ageMs)
    utimesSync(path, at, at)
    return path
  }

  async function clean(args: string[] = []) {
    const result = await runCliSuccess(['media', 'clean', ...args], {
      env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
    })
    return (result.json as CleanResult).data
  }

  it('bare: keeps complete files and removes stale partial downloads', async () => {
    const file = place('AgADexample1', 'report.pdf', 10, 90 * DAY)
    const stale = place('AgADexample2', '.video.mp4.part', 6, 2 * DAY)
    const fresh = place('AgADexample3', '.big.zip.part', 4, 60_000)

    expect(await clean()).toEqual({
      accountId: 1,
      removedFiles: 0,
      removedPartialFiles: 1,
      freedBytes: 6,
      keptFiles: 1,
      sharedFiles: 0,
      filters: { all: false, olderThan: null, chat: null },
    })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('reports nothing removed for an account without a media cache', async () => {
    const data = await clean(['--all'])
    expect(data).toMatchObject({ removedFiles: 0, freedBytes: 0 })
    expect(existsSync(mediaDir)).toBe(false)
  })

  it('--older-than removes files not used since then', async () => {
    const old = place('AgADexample1', 'old.pdf', 10, 3 * DAY)
    const recent = place('AgADexample2', 'new.pdf', 5, 60_000)

    const data = await clean(['--older-than', '1d'])
    expect(data).toMatchObject({
      removedFiles: 1,
      freedBytes: 10,
      keptFiles: 1,
    })
    expect(Date.parse(data.filters.olderThan!)).toBeLessThan(
      Date.now() - DAY + 60_000,
    )
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('--all removes every file and partial download', async () => {
    place('AgADexample1', 'a.pdf', 10)
    place('AgADexample1', 'thumb-m.jpg', 3)
    place('AgADexample2', '.b.zip.part', 4, 60_000)

    expect(await clean(['--all'])).toMatchObject({
      removedFiles: 2,
      removedPartialFiles: 1,
      freedBytes: 17,
      keptFiles: 0,
    })
    expect(readdirSync(mediaDir)).toEqual([])
  })

  it("--chat removes a chat's files and keeps one another chat holds", async () => {
    const self = { _: 'peerUser' as const, userId: SELF_ID }
    const photo = photoMessage(self, 1)
    const pdf = pdfDocumentMessage(self, 2)
    // The same photo forwarded to another chat
    const forwarded = photoMessage({ _: 'peerUser', userId: OTHER_CHAT_ID }, 7)
    createMessagesCache(env.openCacheDb(1)).upsertBatch([
      parseRawMessage(photo, SELF_ID)!,
      parseRawMessage(pdf, SELF_ID)!,
      parseRawMessage(forwarded, OTHER_CHAT_ID)!,
    ])
    const photoId = extractAttachment(photo)!.uniqueFileId
    const pdfId = extractAttachment(pdf)!.uniqueFileId
    const sharedPhoto = place(photoId, 'photo.jpg', 60)
    const pdfFile = place(pdfId, 'example-report.pdf', 12)
    const unrelated = place('AgADunrelated', 'other.bin', 5)

    expect(await clean(['--chat', 'me'])).toEqual({
      accountId: 1,
      removedFiles: 1,
      removedPartialFiles: 0,
      freedBytes: 12,
      keptFiles: 2,
      sharedFiles: 1,
      filters: { all: false, olderThan: null, chat: SELF_ID },
    })
    expect(existsSync(pdfFile)).toBe(false)
    expect(existsSync(sharedPhoto)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
  })

  it('refuses --all with --chat or --older-than', async () => {
    for (const args of [
      ['--all', '--chat', 'me'],
      ['--all', '--older-than', '7d'],
    ]) {
      const result = await runCli(['media', 'clean', ...args], {
        env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
      })
      expect(result.exitCode).toBe(3)
      expect(result.json).toMatchObject({
        success: false,
        error: { code: 'INVALID_ARGS' },
      })
    }
  })

  it('refuses an --older-than that is no duration, date or time', async () => {
    const result = await runCli(
      ['media', 'clean', '--older-than', 'nonsense'],
      { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } },
    )
    expect(result.exitCode).toBe(3)
    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS', details: { older_than: 'nonsense' } },
    })
  })
})
