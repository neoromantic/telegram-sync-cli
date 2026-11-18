/**
 * Where `tg media download --out` puts a file: a directory, a file path, or
 * a name template such as `exports/{chat}/{date}_{id}_{name}`
 */
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { ErrorCodes } from '../../types'
import { sanitizeFileName } from '../../utils/media-cache'
import type { DownloadResult } from './download-media'
import { MediaError } from './errors'

export const TEMPLATE_PLACEHOLDERS = [
  'chat',
  'id',
  'date',
  'name',
  'kind',
] as const

export type TemplateValues = Record<
  (typeof TEMPLATE_PLACEHOLDERS)[number],
  string
>

/** The name a batch gives each file in an --out directory: never two alike */
export const BATCH_NAME_TEMPLATE = '{id}_{name}'

const PLACEHOLDER = /\{([^{}]*)\}/g

export function isTemplate(out: string): boolean {
  return /\{[^{}]*\}/.test(out)
}

/** Placeholders of the template tg doesn't know */
export function unknownPlaceholders(template: string): string[] {
  const known = new Set<string>(TEMPLATE_PLACEHOLDERS)
  return [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1] ?? '')
    .filter((name) => !known.has(name))
}

/** A message date (Unix seconds) as the UTC day, 2026-10-09 */
export function templateDate(date: number): string {
  return new Date(date * 1000).toISOString().slice(0, 10)
}

/**
 * The template with its placeholders filled. Each path segment that holds
 * a placeholder is made a safe file name as a whole, so a value never adds
 * a folder; segments without one stay as written.
 */
export function expandTemplate(
  template: string,
  values: TemplateValues,
): string {
  return template
    .split(/[/\\]/)
    .map((segment) => {
      if (!isTemplate(segment)) return segment
      const filled = segment.replace(
        PLACEHOLDER,
        (_, name: keyof TemplateValues) => values[name],
      )
      return sanitizeFileName(filled) ?? '_'
    })
    .join('/')
}

function statOrNull(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/**
 * Where --out puts the file: into a directory (an existing one, or a path
 * ending in a slash, created) under the file's name, else at that path
 */
export function outTarget(out: string, fileName: string): string {
  const isDir = /[/\\]$/.test(out) || statOrNull(out)?.isDirectory() === true
  return resolve(isDir ? join(out, fileName) : out)
}

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}

/** The target already holds this file: a rerun leaves it as it is */
async function sameFile(target: string, source: string): Promise<boolean> {
  const a = statOrNull(target)
  const b = statOrNull(source)
  if (!a?.isFile() || !b || a.size !== b.size) return false
  return (await digest(target)) === (await digest(source))
}

/**
 * Copy the cached file to `target` (from the --out value `out`), never over
 * another file unless asked. Throws a MediaError: FILE_EXISTS, or
 * GENERAL_ERROR when it can't write.
 */
export async function copyOut(
  result: DownloadResult,
  out: string,
  target: string,
  overwrite: boolean,
): Promise<string> {
  try {
    mkdirSync(dirname(target), { recursive: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new MediaError(
      ErrorCodes.GENERAL_ERROR,
      `Failed to create --out: ${message}`,
      { out },
    )
  }
  if (!overwrite && statOrNull(target) !== null) {
    if (await sameFile(target, result.path)) return target
    throw new MediaError(
      ErrorCodes.FILE_EXISTS,
      `File already exists: ${target}`,
      { path: target },
      'pass --overwrite or another --out',
    )
  }

  // Written next to the target, then renamed over it: never half a file
  const tmp = join(
    dirname(target),
    `.${basename(target)}.tg-${process.pid}.part`,
  )
  try {
    await Bun.write(tmp, Bun.file(result.path))
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    const message = err instanceof Error ? err.message : String(err)
    throw new MediaError(
      ErrorCodes.GENERAL_ERROR,
      `Failed to write --out: ${message}`,
      { path: target },
    )
  }
  return target
}
