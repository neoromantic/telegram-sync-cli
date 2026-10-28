/**
 * tg media download: a message's file into the account's media cache,
 * printed as JSON, copied with --out, or written to stdout with --out -.
 * A cached file needs no network and no credentials.
 */
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { defineCommand } from 'citty'

import { getAccountMediaDir } from '../../db'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { formatBytes } from '../../utils/formatting'
import { error, info, rawFile, success } from '../../utils/output'
import { createProgress } from '../../utils/progress'
import { wrapClientCallWithRateLimits } from '../../utils/telegram-rate-limits'
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
} from '../messages/helpers'
import { type DownloadResult, downloadMedia } from './download-media'
import { DownloadInterruptedError, reportMediaError } from './errors'

const CONTEXT = 'cli:media.download'
/** Exit code of a download stopped by SIGINT or SIGTERM */
const INTERRUPTED_EXIT_CODE = 130

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
function outTarget(out: string, fileName: string): string {
  const isDir = /[/\\]$/.test(out) || statOrNull(out)?.isDirectory() === true
  const target = resolve(isDir ? join(out, fileName) : out)
  mkdirSync(dirname(target), { recursive: true })
  return target
}

/** Copy the cached file to --out, never over an existing file unless asked */
async function copyOut(
  result: DownloadResult,
  out: string,
  overwrite: boolean,
): Promise<string> {
  let target: string
  try {
    target = outTarget(out, result.fileName)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    error(ErrorCodes.GENERAL_ERROR, `Failed to create --out: ${message}`, {
      out,
    })
  }
  if (!overwrite && statOrNull(target) !== null) {
    error(
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
    error(ErrorCodes.GENERAL_ERROR, `Failed to write --out: ${message}`, {
      path: target,
    })
  }
  return target
}

function reportInterrupted(err: DownloadInterruptedError): never {
  const kept =
    err.downloaded === null
      ? ''
      : err.total === null
        ? `: ${formatBytes(err.downloaded)} kept`
        : `: ${formatBytes(err.downloaded)} of ${formatBytes(err.total)} kept`
  info(`Download interrupted${kept}, run the command again to resume`)
  process.exit(INTERRUPTED_EXIT_CODE)
}

export const downloadMediaCommand = defineCommand({
  meta: {
    name: 'download',
    description:
      "Download a message's file into the account's media cache and print its path (cache-first: a cached file needs no network)",
  },
  args: {
    chat: {
      type: 'string',
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: 'string',
      description: 'Message ID',
      required: true,
    },
    out: {
      type: 'string',
      description:
        'Also copy the file here: a directory (under its name), a file path, or - for stdout (bytes only, no JSON)',
    },
    thumb: {
      type: 'boolean',
      description: "Download the file's small preview instead of the file",
      default: false,
    },
    fresh: {
      type: 'boolean',
      description:
        'Fetch the message from Telegram again and check its content protection, even when the file is cached',
      default: false,
    },
    overwrite: {
      type: 'boolean',
      description: 'Replace an existing --out file',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const messageId = parseIntegerArg(args.id, 'id', {
      min: 1,
      max: MAX_MESSAGE_ID,
    })
    const out = args.out
    if (out !== undefined && out.trim() === '') {
      error(
        ErrorCodes.INVALID_ARGS,
        '--out needs a directory, a file path or -',
        { out },
      )
    }
    const { account } = openAccountCache(args.account)

    // SIGINT/SIGTERM stop the transfer; the partial download is kept
    const controller = new AbortController()
    const stop = () => {
      if (controller.signal.aborted) process.exit(INTERRUPTED_EXIT_CODE)
      controller.abort()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)

    let result: DownloadResult
    try {
      const history = openHistory(account.id, CONTEXT)
      // The instance the lazy history client wraps: one connection
      const getClient = () =>
        wrapClientCallWithRateLimits(getClientForAccount(account.id), {
          context: CONTEXT,
          accountId: account.id,
        })
      result = await downloadMedia(
        {
          cacheDb: history.cacheDb,
          mediaDir: getAccountMediaDir(account.id),
          getClient,
          history,
          signal: controller.signal,
          progress: (fileName) => createProgress(fileName),
        },
        {
          chat: args.chat,
          messageId,
          thumb: args.thumb ?? false,
          fresh: args.fresh ?? false,
        },
      )
    } catch (err) {
      if (err instanceof DownloadInterruptedError) reportInterrupted(err)
      reportMediaError(err)
    }

    if (out === '-') {
      await rawFile(result.path)
      return
    }
    const cachePath = result.path
    const path =
      out === undefined
        ? cachePath
        : await copyOut(result, out, args.overwrite ?? false)
    const { path: _cachePath, ...fields } = result
    success({ path, cachePath, ...fields })
  },
})
