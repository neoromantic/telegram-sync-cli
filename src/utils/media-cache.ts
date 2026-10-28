/**
 * The account's media cache on disk, `accounts/<id>/media` (filesystem
 * only, no Telegram):
 *
 *   <uniqueFileId>/<name>              the file, one copy per uniqueFileId
 *   <uniqueFileId>/.<name>.part        partial download, resumed next run
 *   <uniqueFileId>/thumb-<type>.jpg    --thumb preview (.webp for stickers)
 *   <uniqueFileId>/.lock               download in progress: holder pid,
 *                                      refreshed while it runs
 *
 * A cached name never starts with a dot, so `.part` and `.lock` files
 * can't be mistaken for a file someone sent.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  type AttachmentInfo,
  attachmentDefaultFileName,
  type MediaThumb,
} from './attachment'

/** A partial download not written to for this long is removed by every clean */
export const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000

const LOCK_FILE = '.lock'
const PARTIAL_SUFFIX = '.part'
const LOCK_POLL_MS = 250
/** A lock file this young may still be empty: its holder is writing the pid */
const LOCK_WRITE_GRACE_MS = 5_000
/** How often a running download refreshes its lock's mtime */
export const LOCK_REFRESH_MS = 10_000
/**
 * A lock not refreshed for this long is stale even when a process has its
 * pid: after a crash or a reboot the pid may be another program's
 */
export const LOCK_STALE_MS = 60_000
/** How long a download waits for another process's download of the file */
export const LOCK_WAIT_MS = 10 * 60 * 1000
/** Longest cached name; the extension is kept when it is cut */
const MAX_NAME_BYTES = 200
/** An extension starts at the last dot within this many final characters */
const MAX_EXTENSION_CHARS = 16
/** uniqueFileId is base64url: safe as a folder name */
const FOLDER_NAME = /^[A-Za-z0-9_-]+$/

export interface MediaCachePaths {
  /** `<uniqueFileId>/`: the file, its partial download, previews, the lock */
  dir: string
  file: string
  part: string
  lock: string
}

function folderPath(mediaDir: string, uniqueFileId: string): string {
  if (!FOLDER_NAME.test(uniqueFileId)) {
    throw new Error(`Invalid unique file ID: ${uniqueFileId}`)
  }
  return join(mediaDir, uniqueFileId)
}

function pathsIn(dir: string, name: string): MediaCachePaths {
  return {
    dir,
    file: join(dir, name),
    part: join(dir, `.${name}${PARTIAL_SUFFIX}`),
    lock: join(dir, LOCK_FILE),
  }
}

/** Where the file of an attachment is cached */
export function mediaPaths(
  mediaDir: string,
  info: AttachmentInfo,
): MediaCachePaths {
  return pathsIn(folderPath(mediaDir, info.uniqueFileId), cachedFileName(info))
}

/** Where a preview of an attachment is cached: next to the file */
export function thumbPaths(
  mediaDir: string,
  info: AttachmentInfo,
  thumb: MediaThumb,
): MediaCachePaths {
  const type = thumb.type.replace(/[^A-Za-z0-9]/g, '_')
  const extension = info.kind === 'sticker' ? 'webp' : 'jpg'
  return pathsIn(
    folderPath(mediaDir, info.uniqueFileId),
    `thumb-${type}.${extension}`,
  )
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g

/** Cut a name to `maxBytes` of UTF-8 without splitting a character */
function cutToBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  let result = ''
  let bytes = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (bytes + size > maxBytes) break
    result += char
    bytes += size
  }
  return result
}

/**
 * A file name that is safe to create in any of the file systems tg runs
 * on: no folders, no control or reserved characters, no leading dot, no
 * Windows device name, at most 200 bytes with the extension kept. Null when
 * nothing usable is left.
 */
export function sanitizeFileName(name: string): string | null {
  let result = (name.split(/[/\\]/).pop() ?? '')
    .normalize('NFC')
    .replace(UNSAFE_CHARS, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (result === '') return null
  if (WINDOWS_RESERVED.test(result)) result = `_${result}`

  if (new TextEncoder().encode(result).length > MAX_NAME_BYTES) {
    const dot = result.lastIndexOf('.')
    const extension =
      dot > 0 && result.length - dot <= MAX_EXTENSION_CHARS
        ? result.slice(dot)
        : ''
    const stem = result.slice(0, result.length - extension.length)
    const extensionBytes = new TextEncoder().encode(extension).length
    result = cutToBytes(stem, MAX_NAME_BYTES - extensionBytes).trimEnd()
    result += extension
  }
  return result
}

/**
 * The cached file's name: the sender's name made safe, else `<kind>.<ext>`.
 * A name like a preview's (`thumb-…`) gets a `_` prefix, so a file and its
 * preview never share a path.
 */
export function cachedFileName(info: AttachmentInfo): string {
  const name =
    (info.fileName !== null && sanitizeFileName(info.fileName)) ||
    attachmentDefaultFileName(info)
  return /^thumb-/i.test(name) ? `_${name}` : name
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** The file if it is complete: it exists and, when the size is known, has it */
export function findCachedFile(
  path: string,
  expectedSize: number | null,
): { path: string; size: number } | null {
  const stats = statOrNull(path)
  if (!stats?.isFile()) return null
  if (expectedSize !== null && stats.size !== expectedSize) return null
  return { path, size: stats.size }
}

/**
 * Mark a cached file as used now, so `tg media clean --older-than` means
 * "not used since". Best effort: a file that can't be touched is still served.
 */
export function touch(path: string): void {
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    // A read-only cache still serves the file
  }
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** Whether a process with this pid runs; one of another user counts */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) === 'EPERM'
  }
}

interface LockState {
  /** The holder's pid, or `pending` while a new lock is still empty */
  holder: number | 'pending'
  /** When the holder last refreshed it */
  mtimeMs: number
}

/** A lock's holder and age; null for no lock or a broken one */
function readLock(lockPath: string): LockState | null {
  let content: string
  let stats: Stats
  try {
    stats = statSync(lockPath)
    content = readFileSync(lockPath, 'utf-8').trim()
  } catch {
    return null
  }
  if (content === '') {
    return Date.now() - stats.mtimeMs < LOCK_WRITE_GRACE_MS
      ? { holder: 'pending', mtimeMs: stats.mtimeMs }
      : null
  }
  const pid = Number(content)
  return Number.isSafeInteger(pid) && pid > 0
    ? { holder: pid, mtimeMs: stats.mtimeMs }
    : null
}

type IsAlive = (pid: number) => boolean

/** Whether a lock holds its folder: its holder runs and keeps refreshing it */
function isLive(lock: LockState | null, isAlive: IsAlive): boolean {
  if (lock === null) return false
  if (Date.now() - lock.mtimeMs >= LOCK_STALE_MS) return false
  return lock.holder === 'pending' || isAlive(lock.holder)
}

function lockIsLive(lockPath: string, isAlive: IsAlive): boolean {
  return isLive(readLock(lockPath), isAlive)
}

/**
 * Remove a stale lock, but never a live one another process took
 * meanwhile: the lock is renamed away first, so only one process gets it,
 * checked again there, and put back when it turned out live. The moved
 * name is a partial download's, so a run that dies in between leaves
 * nothing `tg media clean` misses.
 */
function removeStaleLock(lockPath: string, isAlive: IsAlive): void {
  const moved = join(
    dirname(lockPath),
    `${LOCK_FILE}-${process.pid}-${randomUUID()}${PARTIAL_SUFFIX}`,
  )
  try {
    renameSync(lockPath, moved)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return
    throw err
  }
  if (lockIsLive(moved, isAlive)) {
    try {
      linkSync(moved, lockPath)
    } catch {
      // A newer lock took its place
    }
  }
  rmSync(moved, { force: true })
}

/** Another process held a file's download lock for longer than the wait */
export class DownloadLockTimeoutError extends Error {
  readonly lockPath: string
  /** The holder's pid, when the lock names one */
  readonly holder: number | null
  readonly waitedMs: number

  constructor(lockPath: string, holder: number | null, waitedMs: number) {
    super(`Waited ${waitedMs} ms for the download lock ${lockPath}`)
    this.name = 'DownloadLockTimeoutError'
    this.lockPath = lockPath
    this.holder = holder
    this.waitedMs = waitedMs
  }
}

export interface DownloadLockOptions {
  signal?: AbortSignal
  isAlive?: IsAlive
  pollMs?: number
  /** LOCK_WAIT_MS by default */
  waitMs?: number
  /** LOCK_REFRESH_MS by default */
  refreshMs?: number
}

/**
 * Take the folder's download lock: two processes never write one partial
 * download together. Waits while a live process holds it, up to `waitMs`
 * (then DownloadLockTimeoutError); takes over a lock whose holder is gone
 * or stopped refreshing it; throws the signal's reason on abort. The lock
 * is refreshed until the release, which removes it only while it is still
 * this process's.
 */
export async function acquireDownloadLock(
  lockPath: string,
  options: DownloadLockOptions = {},
): Promise<() => void> {
  const isAlive = options.isAlive ?? processAlive
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const waitMs = options.waitMs ?? LOCK_WAIT_MS
  const { signal } = options
  const started = Date.now()
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })

  for (;;) {
    signal?.throwIfAborted()
    let fd: number | null = null
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
    }
    if (fd !== null) {
      try {
        writeSync(fd, String(process.pid))
      } finally {
        closeSync(fd)
      }
      const ours = () => readLock(lockPath)?.holder === process.pid
      const refresh = setInterval(() => {
        if (ours()) touch(lockPath)
      }, options.refreshMs ?? LOCK_REFRESH_MS)
      refresh.unref()
      let released = false
      return () => {
        if (released) return
        released = true
        clearInterval(refresh)
        if (ours()) rmSync(lockPath, { force: true })
      }
    }

    const lock = readLock(lockPath)
    if (!isLive(lock, isAlive)) {
      removeStaleLock(lockPath, isAlive)
      continue
    }
    const waited = Date.now() - started
    if (waited >= waitMs) {
      const holder = typeof lock?.holder === 'number' ? lock.holder : null
      throw new DownloadLockTimeoutError(lockPath, holder, waited)
    }
    try {
      await delay(pollMs, undefined, { signal })
    } catch (err) {
      signal?.throwIfAborted()
      throw err
    }
  }
}

/** snake_case: tg status prints it as it is */
export interface MediaUsage {
  bytes: number
  files: number
  partial_bytes: number
  partial_files: number
}

function isPartialName(name: string): boolean {
  return name.startsWith('.') && name.endsWith(PARTIAL_SUFFIX)
}

interface CacheEntry {
  name: string
  path: string
  size: number
  mtimeMs: number
}

/** The regular files of a folder; one removed meanwhile is skipped */
function folderFiles(dir: string): CacheEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return []
    throw err
  }
  const entries: CacheEntry[] = []
  for (const name of names) {
    const path = join(dir, name)
    let stats: Stats
    try {
      stats = lstatSync(path)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    entries.push({ name, path, size: stats.size, mtimeMs: stats.mtimeMs })
  }
  return entries
}

/** The `<uniqueFileId>` folders of the media cache; none when it is missing */
function cacheFolders(mediaDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(mediaDir)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return []
    throw err
  }
  return names.filter((name) => {
    try {
      return lstatSync(join(mediaDir, name)).isDirectory()
    } catch {
      return false
    }
  })
}

/**
 * The media cache's size: files and previews, and partial downloads apart.
 * Apparent sizes; a missing cache is all zeros.
 */
export function readMediaUsage(mediaDir: string): MediaUsage {
  const usage: MediaUsage = {
    bytes: 0,
    files: 0,
    partial_bytes: 0,
    partial_files: 0,
  }
  for (const folder of cacheFolders(mediaDir)) {
    for (const entry of folderFiles(join(mediaDir, folder))) {
      if (entry.name === LOCK_FILE) continue
      if (isPartialName(entry.name)) {
        usage.partial_bytes += entry.size
        usage.partial_files++
      } else {
        usage.bytes += entry.size
        usage.files++
      }
    }
  }
  return usage
}

export interface CleanOptions {
  /** Every file, preview and partial download */
  all?: boolean
  /** ms epoch: files and previews last used before it */
  olderThan?: number
  /** Only these folders (`--chat`) */
  uniqueFileIds?: Set<string>
  /** `--chat`: a file a message of another chat holds is kept */
  isShared?: (uniqueFileId: string) => boolean
  now: number
  /** Partial downloads not written to for this long are removed (PARTIAL_MAX_AGE_MS) */
  partialMaxAgeMs: number
  /** Whether a lock's holder runs; defaults to a signal-0 check */
  isAlive?: IsAlive
}

export interface CleanResult {
  removedFiles: number
  removedPartialFiles: number
  freedBytes: number
  /** Files and previews left in the cache */
  keptFiles: number
  /** Files kept because a message of another chat holds them (`--chat`) */
  sharedFiles: number
}

/**
 * Remove cached files. Without `all`, `olderThan` or `uniqueFileIds` no
 * complete file goes, only stale partial downloads; with several filters a
 * file goes when it matches them all. Every run removes partial downloads
 * not written to for `partialMaxAgeMs` (with `all`, every one), skips a
 * folder whose download lock a live process holds, removes a stale lock
 * (its holder gone or no longer refreshing it), and removes folders left
 * empty.
 */
export function cleanMedia(
  mediaDir: string,
  options: CleanOptions,
): CleanResult {
  const isAlive = options.isAlive ?? processAlive
  const filtersFiles =
    options.olderThan !== undefined || options.uniqueFileIds !== undefined
  const result: CleanResult = {
    removedFiles: 0,
    removedPartialFiles: 0,
    freedBytes: 0,
    keptFiles: 0,
    sharedFiles: 0,
  }

  for (const folder of cacheFolders(mediaDir)) {
    const dir = join(mediaDir, folder)
    const entries = folderFiles(dir)
    const lockPath = join(dir, LOCK_FILE)
    const hasLock = entries.some((entry) => entry.name === LOCK_FILE)

    if (hasLock && lockIsLive(lockPath, isAlive)) {
      result.keptFiles += entries.filter(
        (entry) => entry.name !== LOCK_FILE && !isPartialName(entry.name),
      ).length
      continue
    }

    let shared: boolean | undefined
    const isShared = () => {
      shared ??= options.isShared?.(folder) ?? false
      return shared
    }
    const remove = (entry: CacheEntry): boolean => {
      try {
        rmSync(entry.path, { force: true })
      } catch {
        return false
      }
      result.freedBytes += entry.size
      return true
    }

    for (const entry of entries) {
      if (entry.name === LOCK_FILE) continue

      if (isPartialName(entry.name)) {
        const stale = options.now - entry.mtimeMs >= options.partialMaxAgeMs
        if ((options.all || stale) && remove(entry)) {
          result.removedPartialFiles++
        }
        continue
      }

      let matches = options.all === true
      if (!matches && filtersFiles) {
        matches =
          (options.olderThan === undefined ||
            entry.mtimeMs < options.olderThan) &&
          (options.uniqueFileIds === undefined ||
            options.uniqueFileIds.has(folder))
        if (matches && options.uniqueFileIds !== undefined && isShared()) {
          matches = false
          result.sharedFiles++
        }
      }
      if (matches && remove(entry)) {
        result.removedFiles++
      } else {
        result.keptFiles++
      }
    }

    // Checked again: a download may have taken the dead holder's lock meanwhile
    if (hasLock && !lockIsLive(lockPath, isAlive)) {
      removeStaleLock(lockPath, isAlive)
    }
    try {
      rmdirSync(dir)
    } catch {
      // Not empty: something is left in it
    }
  }

  return result
}
