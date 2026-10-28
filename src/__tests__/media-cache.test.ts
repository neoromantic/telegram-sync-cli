/**
 * The media cache on disk: names, paths, cache hits, the download lock,
 * usage and clean. Temp dirs and made-up files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AttachmentInfo, MediaThumb } from '../utils/attachment'
import {
  acquireDownloadLock,
  cachedFileName,
  cleanMedia,
  DownloadLockTimeoutError,
  findCachedFile,
  LOCK_STALE_MS,
  mediaPaths,
  PARTIAL_MAX_AGE_MS,
  readMediaUsage,
  sanitizeFileName,
  thumbPaths,
  touch,
} from '../utils/media-cache'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)

function attachment(overrides: Partial<AttachmentInfo> = {}): AttachmentInfo {
  return {
    kind: 'document',
    source: 'message',
    fileName: 'report.pdf',
    mimeType: 'application/pdf',
    size: 4,
    duration: null,
    width: null,
    height: null,
    uniqueFileId: 'AgADBAADexample',
    groupedId: null,
    ...overrides,
  }
}

const thumb: MediaThumb = {
  type: 'm',
  width: 320,
  height: 240,
  size: 3,
  uniqueFileId: 'AQADBAADexamplem',
}

let mediaDir: string

beforeEach(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'tg-media-cache-'))
})

afterEach(() => {
  rmSync(mediaDir, { recursive: true, force: true })
})

/** Write a file with `size` bytes and its mtime `ageMs` before NOW */
function place(path: string, size: number, ageMs = 0): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(size, 7))
  const at = new Date(NOW - ageMs)
  utimesSync(path, at, at)
  return path
}

/** A pid no process has: the check is injected */
const DEAD_PID = 999_999

/** A download lock that `pid` holds, last refreshed `ageMs` ago */
function writeLock(folder: string, pid: number, ageMs = 0): string {
  mkdirSync(join(mediaDir, folder), { recursive: true })
  const path = join(mediaDir, folder, '.lock')
  writeFileSync(path, String(pid))
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs)
    utimesSync(path, at, at)
  }
  return path
}

describe('sanitizeFileName', () => {
  it('keeps only the base name', () => {
    expect(sanitizeFileName('../../x.txt')).toBe('x.txt')
    expect(sanitizeFileName('folder\\sub\\notes.txt')).toBe('notes.txt')
  })

  it('replaces control and reserved characters', () => {
    expect(sanitizeFileName('a\u0000b\u001fc\u007f.txt')).toBe('a_b_c_.txt')
    expect(sanitizeFileName('what?*:<>|".txt')).toBe('what_______.txt')
  })

  it('prefixes Windows device names', () => {
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt')
    expect(sanitizeFileName('lpt1')).toBe('_lpt1')
    expect(sanitizeFileName('console.txt')).toBe('console.txt')
  })

  it('drops leading dots and trailing dots and spaces', () => {
    expect(sanitizeFileName('.hidden')).toBe('hidden')
    expect(sanitizeFileName('  notes. . ')).toBe('notes')
    expect(sanitizeFileName('...')).toBeNull()
    expect(sanitizeFileName('   ')).toBeNull()
  })

  it('cuts a long name to 200 bytes and keeps the extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(300)}.pdf`)!
    expect(new TextEncoder().encode(name).length).toBe(200)
    expect(name.endsWith('.pdf')).toBe(true)

    const cyrillic = sanitizeFileName(`${'я'.repeat(150)}.txt`)!
    expect(new TextEncoder().encode(cyrillic).length).toBeLessThanOrEqual(200)
    expect(cyrillic.endsWith('я.txt')).toBe(true)
  })

  it('normalizes to NFC', () => {
    expect(sanitizeFileName('йод.txt'.normalize('NFD'))).toBe(
      'йод.txt'.normalize('NFC'),
    )
  })
})

describe('cache names and paths', () => {
  it("uses the sender's name, else <kind>.<ext>", () => {
    expect(cachedFileName(attachment())).toBe('report.pdf')
    expect(cachedFileName(attachment({ fileName: '...' }))).toBe('file.pdf')
    expect(
      cachedFileName(
        attachment({ kind: 'photo', fileName: null, mimeType: 'image/jpeg' }),
      ),
    ).toBe('photo.jpg')
  })

  it("never gives a file a preview's name", () => {
    expect(cachedFileName(attachment({ fileName: 'thumb-m.jpg' }))).toBe(
      '_thumb-m.jpg',
    )
  })

  it('keeps the file, its partial download and the lock in one folder', () => {
    const paths = mediaPaths(mediaDir, attachment())
    const dir = join(mediaDir, 'AgADBAADexample')
    expect(paths).toEqual({
      dir,
      file: join(dir, 'report.pdf'),
      part: join(dir, '.report.pdf.part'),
      lock: join(dir, '.lock'),
    })
  })

  it("puts a preview in its file's folder", () => {
    expect(thumbPaths(mediaDir, attachment(), thumb).file).toBe(
      join(mediaDir, 'AgADBAADexample', 'thumb-m.jpg'),
    )
    expect(
      thumbPaths(mediaDir, attachment({ kind: 'sticker' }), thumb).file,
    ).toBe(join(mediaDir, 'AgADBAADexample', 'thumb-m.webp'))
  })

  it('refuses a unique file ID that is not a safe folder name', () => {
    expect(() =>
      mediaPaths(mediaDir, attachment({ uniqueFileId: '../x' })),
    ).toThrow('Invalid unique file ID')
  })
})

describe('findCachedFile and touch', () => {
  it('finds a file of the expected size, or of any size when unknown', () => {
    const path = place(join(mediaDir, 'u1', 'a.bin'), 4)
    expect(findCachedFile(path, 4)).toEqual({ path, size: 4 })
    expect(findCachedFile(path, null)).toEqual({ path, size: 4 })
  })

  it('misses a file of another size, a missing file and a folder', () => {
    const path = place(join(mediaDir, 'u1', 'a.bin'), 3)
    expect(findCachedFile(path, 4)).toBeNull()
    expect(findCachedFile(join(mediaDir, 'u1', 'none'), null)).toBeNull()
    expect(findCachedFile(join(mediaDir, 'u1'), null)).toBeNull()
  })

  it('touch moves the mtime to now', () => {
    const path = place(join(mediaDir, 'u1', 'a.bin'), 1, 10 * DAY)
    touch(path)
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(60_000)
    expect(() => touch(join(mediaDir, 'missing'))).not.toThrow()
  })
})

describe('acquireDownloadLock', () => {
  it('writes this pid and removes the lock on release', async () => {
    const lock = join(mediaDir, 'u1', '.lock')
    const release = await acquireDownloadLock(lock)
    expect(await Bun.file(lock).text()).toBe(String(process.pid))
    release()
    expect(existsSync(lock)).toBe(false)
    release()
  })

  it("takes over a dead holder's lock", async () => {
    const lock = writeLock('u1', DEAD_PID)
    const release = await acquireDownloadLock(lock, {
      isAlive: (pid) => pid !== DEAD_PID,
    })
    expect(await Bun.file(lock).text()).toBe(String(process.pid))
    release()
  })

  it('waits while a live holder has it', async () => {
    const lock = writeLock('u1', 4242)
    let alive = true
    let acquired = false
    const pending = acquireDownloadLock(lock, {
      isAlive: () => alive,
      pollMs: 5,
    }).then((release) => {
      acquired = true
      return release
    })
    await Bun.sleep(20)
    expect(acquired).toBe(false)

    alive = false
    const release = await pending
    expect(acquired).toBe(true)
    release()
  })

  it('ends with the abort reason', async () => {
    const lock = writeLock('u1', 4242)
    const controller = new AbortController()
    const pending = acquireDownloadLock(lock, {
      isAlive: () => true,
      pollMs: 5,
      signal: controller.signal,
    })
    controller.abort(new Error('interrupted'))
    await expect(pending).rejects.toThrow('interrupted')
    expect(await Bun.file(lock).text()).toBe('4242')
  })

  it('takes over a lock its holder stopped refreshing, even with a live pid', async () => {
    const lock = writeLock('u1', 4242, LOCK_STALE_MS + 1_000)
    const release = await acquireDownloadLock(lock, {
      isAlive: () => true,
      waitMs: 0,
    })
    expect(await Bun.file(lock).text()).toBe(String(process.pid))
    expect(readdirSync(join(mediaDir, 'u1'))).toEqual(['.lock'])
    release()
  })

  it('refreshes the lock while it holds it', async () => {
    const lock = join(mediaDir, 'u1', '.lock')
    const release = await acquireDownloadLock(lock, { refreshMs: 5 })
    const old = new Date(Date.now() - LOCK_STALE_MS)
    utimesSync(lock, old, old)
    await Bun.sleep(30)
    expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(LOCK_STALE_MS / 2)
    release()
  })

  it('gives up waiting after waitMs with the lock and its holder', async () => {
    const lock = writeLock('u1', 4242)
    const err = await acquireDownloadLock(lock, {
      isAlive: () => true,
      waitMs: 0,
    }).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(err).toBeInstanceOf(DownloadLockTimeoutError)
    expect(err).toMatchObject({ lockPath: lock, holder: 4242 })
    expect(await Bun.file(lock).text()).toBe('4242')
  })

  it('never removes a live lock another process took over meanwhile', async () => {
    const lock = writeLock('u1', DEAD_PID)
    let tookOver = false
    // Another process replaces the dead lock right after this one read it
    const isAlive = (pid: number) => {
      if (pid === DEAD_PID && !tookOver) {
        tookOver = true
        writeFileSync(lock, '4242')
      }
      return pid === 4242
    }
    const err = await acquireDownloadLock(lock, { isAlive, waitMs: 0 }).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(err).toBeInstanceOf(DownloadLockTimeoutError)
    expect(await Bun.file(lock).text()).toBe('4242')
    expect(readdirSync(join(mediaDir, 'u1'))).toEqual(['.lock'])
  })

  it("leaves a lock that is no longer this process's on release", async () => {
    const lock = join(mediaDir, 'u1', '.lock')
    const release = await acquireDownloadLock(lock)
    writeFileSync(lock, '4242')
    release()
    expect(existsSync(lock)).toBe(true)
  })
})

describe('readMediaUsage', () => {
  it('is all zeros for a missing cache', () => {
    expect(readMediaUsage(join(mediaDir, 'missing'))).toEqual({
      bytes: 0,
      files: 0,
      partial_bytes: 0,
      partial_files: 0,
    })
  })

  it('counts files and previews, partial downloads apart, and no lock', () => {
    place(join(mediaDir, 'u1', 'report.pdf'), 10)
    place(join(mediaDir, 'u1', 'thumb-m.jpg'), 3)
    place(join(mediaDir, 'u2', '.video.mp4.part'), 7)
    writeLock('u2', process.pid)
    // A file named like a partial download, without the dot, is complete
    place(join(mediaDir, 'u3', 'backup.part'), 5)

    expect(readMediaUsage(mediaDir)).toEqual({
      bytes: 18,
      files: 3,
      partial_bytes: 7,
      partial_files: 1,
    })
  })
})

describe('cleanMedia', () => {
  const base = {
    now: NOW,
    partialMaxAgeMs: PARTIAL_MAX_AGE_MS,
    isAlive: (pid: number) => pid !== DEAD_PID,
  }

  it('bare: removes only stale partial downloads', () => {
    const file = place(join(mediaDir, 'u1', 'old.pdf'), 10, 90 * DAY)
    const stale = place(join(mediaDir, 'u1', '.big.zip.part'), 6, 2 * DAY)
    const fresh = place(join(mediaDir, 'u2', '.new.zip.part'), 4, 60_000)

    expect(cleanMedia(mediaDir, base)).toEqual({
      removedFiles: 0,
      removedPartialFiles: 1,
      freedBytes: 6,
      keptFiles: 1,
      sharedFiles: 0,
    })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('all: removes every file and partial download and the folders', () => {
    place(join(mediaDir, 'u1', 'a.pdf'), 10)
    place(join(mediaDir, 'u1', 'thumb-m.jpg'), 3)
    place(join(mediaDir, 'u2', '.b.zip.part'), 4, 60_000)

    expect(cleanMedia(mediaDir, { ...base, all: true })).toEqual({
      removedFiles: 2,
      removedPartialFiles: 1,
      freedBytes: 17,
      keptFiles: 0,
      sharedFiles: 0,
    })
    expect(readdirSync(mediaDir)).toEqual([])
  })

  it('olderThan: removes files last used before it', () => {
    const old = place(join(mediaDir, 'u1', 'old.pdf'), 10, 40 * DAY)
    const recent = place(join(mediaDir, 'u2', 'new.pdf'), 5, DAY)

    const result = cleanMedia(mediaDir, { ...base, olderThan: NOW - 30 * DAY })
    expect(result).toMatchObject({
      removedFiles: 1,
      freedBytes: 10,
      keptFiles: 1,
    })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(join(mediaDir, 'u1'))).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it("uniqueFileIds: removes a chat's files, keeps shared ones", () => {
    place(join(mediaDir, 'mine', 'a.pdf'), 10)
    place(join(mediaDir, 'mine', 'thumb-m.jpg'), 2)
    const shared = place(join(mediaDir, 'shared', 'b.pdf'), 5)
    const other = place(join(mediaDir, 'other', 'c.pdf'), 7)
    const asked: string[] = []

    const result = cleanMedia(mediaDir, {
      ...base,
      uniqueFileIds: new Set(['mine', 'shared']),
      isShared: (id) => {
        asked.push(id)
        return id === 'shared'
      },
    })
    expect(result).toEqual({
      removedFiles: 2,
      removedPartialFiles: 0,
      freedBytes: 12,
      keptFiles: 2,
      sharedFiles: 1,
    })
    expect(existsSync(shared)).toBe(true)
    expect(existsSync(other)).toBe(true)
    // Asked once per folder
    expect(asked.sort()).toEqual(['mine', 'shared'])
  })

  it('combines uniqueFileIds with olderThan', () => {
    const old = place(join(mediaDir, 'mine', 'old.pdf'), 10, 40 * DAY)
    const recent = place(join(mediaDir, 'mine2', 'new.pdf'), 5, DAY)

    cleanMedia(mediaDir, {
      ...base,
      olderThan: NOW - 30 * DAY,
      uniqueFileIds: new Set(['mine', 'mine2']),
    })
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it("skips a folder a live download holds, takes a dead one's lock", () => {
    const busy = place(join(mediaDir, 'busy', 'a.pdf'), 10)
    const busyPart = place(join(mediaDir, 'busy', '.b.zip.part'), 4, 2 * DAY)
    writeLock('busy', process.pid)
    place(join(mediaDir, 'dead', 'c.pdf'), 3)
    writeLock('dead', DEAD_PID)

    const result = cleanMedia(mediaDir, { ...base, all: true })
    expect(result).toMatchObject({
      removedFiles: 1,
      removedPartialFiles: 0,
      keptFiles: 1,
    })
    expect(existsSync(busy)).toBe(true)
    expect(existsSync(busyPart)).toBe(true)
    expect(existsSync(join(mediaDir, 'dead'))).toBe(false)
  })

  it('cleans a folder whose lock its holder stopped refreshing', () => {
    place(join(mediaDir, 'gone', 'a.pdf'), 10)
    writeLock('gone', process.pid, LOCK_STALE_MS + 1_000)

    const result = cleanMedia(mediaDir, { ...base, all: true })
    expect(result).toMatchObject({ removedFiles: 1, keptFiles: 0 })
    expect(existsSync(join(mediaDir, 'gone'))).toBe(false)
  })

  it('removes empty folders and does nothing to a missing cache', () => {
    mkdirSync(join(mediaDir, 'empty'))
    cleanMedia(mediaDir, base)
    expect(existsSync(join(mediaDir, 'empty'))).toBe(false)
    expect(cleanMedia(join(mediaDir, 'missing'), base).freedBytes).toBe(0)
  })
})
