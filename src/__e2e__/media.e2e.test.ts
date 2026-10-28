/**
 * E2E tests for tg media: the media cache under accounts/<id>/media, read
 * and cleaned offline, without Telegram credentials. Made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { pdfDocumentMessage } from '../__tests__/helpers/media-messages'
import { fakeBytes, photoMessage } from '../__tests__/helpers/photo-message'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createChatProtectionStore } from '../db/chat-protection'
import { createMessagesCache } from '../db/messages-cache'
import { createUsersCache } from '../db/users-cache'
import { extractAttachment, pickThumb } from '../utils/attachment'
import { mediaPaths, thumbPaths } from '../utils/media-cache'
import { NO_CREDENTIALS, runCli, runCliSuccess, spawnCli } from './helpers/cli'
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

interface DownloadOutput {
  success: boolean
  data: {
    path: string
    cachePath: string
    fileName: string
    mimeType: string | null
    size: number
    kind: string
    chatId: number
    messageId: number
    uniqueFileId: string
    groupedId: string | null
    cached: boolean
    resumedFrom: number | null
    thumb: { type: string; width: number; height: number } | null
  }
}

describe('E2E: media download', () => {
  const ALICE_ID = 5_550_003
  const PHOTO_SIZE = 60_000
  let env: TestEnvironment
  let mediaDir: string
  let offline: { env: Record<string, string | undefined> }

  beforeEach(() => {
    env = createTestEnvironment('media-download')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000000', user_id: SELF_ID, is_active: true },
    ])
    env.openCacheDb(1)
    mediaDir = join(env.dataDir, 'accounts', '1', 'media')
    offline = { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
  })

  afterEach(() => {
    env.cleanup()
  })

  function cache(chatId: number, raw: unknown) {
    createMessagesCache(env.openCacheDb(1)).upsert(
      parseRawMessage(raw, chatId)!,
    )
  }

  /** A cached photo in Saved Messages, and its file in the media cache */
  function cachedPhoto(id = 1, extra: Record<string, unknown> = {}) {
    const photo = {
      ...photoMessage({ _: 'peerUser', userId: SELF_ID }, id),
      ...extra,
    }
    cache(SELF_ID, photo)
    const { file } = mediaPaths(mediaDir, extractAttachment(photo)!)
    mkdirSync(join(file, '..'), { recursive: true })
    const bytes = fakeBytes(PHOTO_SIZE, 3)
    writeFileSync(file, bytes)
    return { photo, file, bytes }
  }

  async function download(args: string[]) {
    const result = await runCliSuccess(['media', 'download', ...args], offline)
    return result.json as DownloadOutput
  }

  it('serves a cached file without network or credentials', async () => {
    const { photo, file } = cachedPhoto()

    const output = await download(['--chat', 'me', '--id', '1'])

    expect(output).toEqual({
      success: true,
      data: {
        path: file,
        cachePath: file,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        size: PHOTO_SIZE,
        kind: 'photo',
        chatId: SELF_ID,
        messageId: 1,
        uniqueFileId: extractAttachment(photo)!.uniqueFileId,
        groupedId: null,
        cached: true,
        resumedFrom: null,
        thumb: null,
      },
    })
  })

  it('reports NO_MEDIA for a cached message without a file', async () => {
    cache(SELF_ID, {
      _: 'message',
      id: 3,
      peerId: { _: 'peerUser', userId: SELF_ID },
      date: 1_760_000_003,
      message: 'Just text',
    })

    const result = await runCli(
      ['media', 'download', '--chat', 'me', '--id', '3'],
      offline,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: 'NO_MEDIA',
        details: { chatId: SELF_ID, messageId: 3, messageType: 'text' },
      },
    })
  })

  it('needs credentials for a file the cache lacks', async () => {
    const result = await runCli(
      ['media', 'download', '--chat', 'me', '--id', '42'],
      offline,
    )
    expect(result.exitCode).toBe(3)
    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS' },
    })
  })

  it('copies into an --out directory, never over an existing file unless asked', async () => {
    const { file, bytes } = cachedPhoto()
    const outDir = join(env.dataDir, 'exports')
    mkdirSync(outDir)
    const args = ['--chat', 'me', '--id', '1', '--out', outDir]

    const output = await download(args)
    const target = join(outDir, 'photo.jpg')
    expect(output.data).toMatchObject({ path: target, cachePath: file })
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0)

    writeFileSync(target, 'edited copy')
    const again = await runCli(['media', 'download', ...args], offline)
    expect(again.exitCode).toBe(1)
    expect(again.json).toMatchObject({
      success: false,
      error: { code: 'FILE_EXISTS', details: { path: target } },
    })
    expect(readFileSync(target, 'utf-8')).toBe('edited copy')

    await download([...args, '--overwrite'])
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0)
    expect(readdirSync(outDir)).toEqual(['photo.jpg'])
  })

  it('writes an --out file path, creating its folders', async () => {
    const { bytes } = cachedPhoto()
    const target = join(env.dataDir, 'exports', 'lake', 'example-lake.jpg')

    const output = await download([
      '--chat',
      'me',
      '--id',
      '1',
      '--out',
      target,
    ])

    expect(output.data.path).toBe(target)
    expect(Buffer.compare(readFileSync(target), bytes)).toBe(0)
  })

  it('writes the bytes alone to stdout with --out -', async () => {
    const { bytes } = cachedPhoto()

    const proc = spawnCli(
      ['media', 'download', '--chat', 'me', '--id', '1', '--out', '-'],
      offline,
    )
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).arrayBuffer(),
    ])

    expect(exitCode).toBe(0)
    expect(Buffer.compare(new Uint8Array(stdout), bytes)).toBe(0)
  })

  it('serves a cached preview of its own size with --thumb', async () => {
    const pdf = pdfDocumentMessage({ _: 'peerUser', userId: SELF_ID }, 5)
    cache(SELF_ID, pdf)
    const thumb = pickThumb(pdf)!
    const { file } = thumbPaths(mediaDir, extractAttachment(pdf)!, thumb)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, fakeBytes(thumb.size))

    const output = await download(['--chat', 'me', '--id', '5', '--thumb'])

    expect(output.data).toMatchObject({
      path: file,
      fileName: 'thumb-m.jpg',
      size: 3_000,
      kind: 'thumbnail',
      uniqueFileId: thumb.uniqueFileId,
      cached: true,
      thumb: { type: 'm', width: 320, height: 180 },
    })
  })

  it('refuses a cached message with content protection', async () => {
    const { file } = cachedPhoto(1, { noforwards: true })

    const result = await runCli(
      ['media', 'download', '--chat', 'me', '--id', '1'],
      offline,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: 'CONTENT_PROTECTED',
        details: { chatId: SELF_ID, messageId: 1, reason: 'message' },
      },
    })
    expect(existsSync(file)).toBe(true)
  })

  it('refuses the cached file of a chat an online check found protected', async () => {
    const db = env.openCacheDb(1)
    createUsersCache(db).upsert({
      user_id: String(ALICE_ID),
      first_name: 'Alice',
      last_name: 'Example',
      access_hash: '1111',
      fetched_at: Date.now(),
      raw_json: '{}',
    })
    const photo = photoMessage({ _: 'peerUser', userId: ALICE_ID }, 2)
    cache(ALICE_ID, photo)
    const { file } = mediaPaths(mediaDir, extractAttachment(photo)!)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, fakeBytes(PHOTO_SIZE))
    createChatProtectionStore(db).record(
      ALICE_ID,
      { protected: true, reason: 'private_chat' },
      Date.now(),
    )

    const result = await runCli(
      ['media', 'download', '--chat', String(ALICE_ID), '--id', '2'],
      offline,
    )
    expect(result.exitCode).toBe(1)
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: 'CONTENT_PROTECTED',
        details: { chatId: ALICE_ID, messageId: 2, reason: 'private_chat' },
      },
    })
  })
})
