/**
 * tg media download: a message's file into the account's media cache,
 * printed as JSON, copied with --out, or written to stdout with --out -.
 * A cached file needs no network and no credentials.
 */
import type { Database } from 'bun:sqlite'
import { join, resolve } from 'node:path'
import { defineCommand } from 'citty'

import { getAccountMediaDir } from '../../db'
import { createMessagesCache } from '../../db/messages-cache'
import { getClientForAccount } from '../../services/telegram'
import { exitAfterFlush } from '../../telemetry'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { flagValues } from '../../utils/args'
import { formatBytes } from '../../utils/formatting'
import {
  error,
  getOutputFormat,
  info,
  rawFile,
  success,
} from '../../utils/output'
import { createProgress } from '../../utils/progress'
import { wrapClientCallWithRateLimits } from '../../utils/telegram-rate-limits'
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
} from '../messages/helpers'
import { downloadBatch, type FileFailure } from './batch'
import {
  type DownloadDeps,
  type DownloadResult,
  downloadMedia,
} from './download-media'
import { DownloadInterruptedError, reportMediaError } from './errors'
import {
  BATCH_NAME_TEMPLATE,
  copyOut,
  expandTemplate,
  isTemplate,
  outTarget,
  TEMPLATE_PLACEHOLDERS,
  templateDate,
  unknownPlaceholders,
} from './out'

const CONTEXT = 'cli:media.download'
/** Exit code of a download stopped by SIGINT or SIGTERM */
const INTERRUPTED_EXIT_CODE = 130

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

/**
 * Where --out puts a downloaded file: its name template filled, else, in a
 * batch, the directory under BATCH_NAME_TEMPLATE, else a directory or path
 */
function targetOf(
  out: string,
  result: DownloadResult,
  batch: boolean,
  cacheDb: Database,
): string {
  const template = isTemplate(out)
    ? out
    : batch
      ? join(out, BATCH_NAME_TEMPLATE)
      : null
  if (template === null) return outTarget(out, result.fileName)
  const row = createMessagesCache(cacheDb).get(result.chatId, result.messageId)
  return resolve(
    expandTemplate(template, {
      chat: String(result.chatId),
      id: String(result.messageId),
      date: row ? templateDate(row.date) : 'unknown',
      name: result.fileName,
      kind: result.kind,
    }),
  )
}

/** The fields a single download prints, with `path` the --out copy */
function outputOf(result: DownloadResult, path: string) {
  const { path: cachePath, ...fields } = result
  return { path, cachePath, ...fields }
}

/** One line per file on stdout, in the result schema */
function printLine(
  line:
    | { success: true; data: ReturnType<typeof outputOf> }
    | { success: false; error: FileFailure },
): void {
  const format = getOutputFormat()
  if (format === 'quiet') return
  console.log(JSON.stringify(line, null, format === 'pretty' ? 2 : undefined))
}

function exitWith(code: number): void {
  if (process.env.BUN_ENV === 'test' || process.env.NODE_ENV === 'test') {
    process.exitCode = code
    return
  }
  void exitAfterFlush(code)
}

export const downloadMediaCommand = defineCommand({
  meta: {
    name: 'download',
    description:
      "Download the files of one or more messages into the account's media cache and print their paths (cache-first: a cached file needs no network)",
  },
  args: {
    chat: {
      type: 'string',
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: 'string',
      description:
        'Message ID; repeat it for several messages of the chat (one JSON line per file)',
      required: true,
    },
    out: {
      type: 'string',
      description: `Also copy the file here: a directory (under its name; with several --id, as ${BATCH_NAME_TEMPLATE}), a file path, a name template with ${TEMPLATE_PLACEHOLDERS.map((name) => `{${name}}`).join(' ')}, or - for stdout (bytes only, no JSON)`,
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
  async run({ args, rawArgs }) {
    const ids = flagValues(rawArgs, 'id')
    const messageIds = [
      ...new Set(
        (ids.length > 0 ? ids : [args.id]).map((id) =>
          parseIntegerArg(id, 'id', { min: 1, max: MAX_MESSAGE_ID }),
        ),
      ),
    ]
    const batch = messageIds.length > 1
    const out = args.out
    if (out !== undefined && out.trim() === '') {
      error(
        ErrorCodes.INVALID_ARGS,
        '--out needs a directory, a file path or -',
        { out },
      )
    }
    const unknown = out === undefined ? [] : unknownPlaceholders(out)
    if (unknown.length > 0) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Unknown placeholder in --out: {${unknown[0]}}`,
        { out, placeholders: TEMPLATE_PLACEHOLDERS },
      )
    }
    if (batch && out === '-') {
      error(
        ErrorCodes.INVALID_ARGS,
        '--out - takes one --id: the bytes of several files would run together',
        { out, ids: messageIds },
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

    const history = openHistory(account.id, CONTEXT)
    // The instance the lazy history client wraps: one connection
    const getClient = () =>
      wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: CONTEXT,
        accountId: account.id,
      })
    const deps: DownloadDeps = {
      cacheDb: history.cacheDb,
      mediaDir: getAccountMediaDir(account.id),
      getClient,
      history,
      signal: controller.signal,
      progress: (fileName) => createProgress(fileName),
    }
    const overwrite = args.overwrite ?? false
    const options = { thumb: args.thumb ?? false, fresh: args.fresh ?? false }

    if (batch) {
      let failures: number
      try {
        failures = await downloadBatch(
          deps,
          { chat: args.chat, messageIds, ...options },
          {
            done: async (result) => {
              const path =
                out === undefined
                  ? result.path
                  : await copyOut(
                      result,
                      out,
                      targetOf(out, result, true, history.cacheDb),
                      overwrite,
                    )
              printLine({ success: true, data: outputOf(result, path) })
            },
            failed: (_messageId, failure) =>
              printLine({ success: false, error: failure }),
          },
        )
      } catch (err) {
        if (err instanceof DownloadInterruptedError) reportInterrupted(err)
        reportMediaError(err)
      }
      const done = messageIds.length - failures
      info(
        `Downloaded ${done} of ${messageIds.length} files${failures > 0 ? `, ${failures} failed` : ''}`,
      )
      exitWith(failures > 0 ? 1 : 0)
      return
    }

    let result: DownloadResult
    try {
      result = await downloadMedia(deps, {
        chat: args.chat,
        messageId: messageIds[0] ?? 0,
        ...options,
      })
    } catch (err) {
      if (err instanceof DownloadInterruptedError) reportInterrupted(err)
      reportMediaError(err)
    }

    if (out === '-') {
      await rawFile(result.path)
      return
    }
    let path = result.path
    if (out !== undefined) {
      try {
        path = await copyOut(
          result,
          out,
          targetOf(out, result, false, history.cacheDb),
          overwrite,
        )
      } catch (err) {
        reportMediaError(err)
      }
    }
    success(outputOf(result, path))
  },
})
