/**
 * tg media transcribe: the text of voice notes and video notes, from a
 * speech-to-text program on this machine. Each file comes through `tg media
 * download`'s path (cache-first, content protection refused); transcripts
 * are stored in message_transcripts and shown by `tg messages`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { defineCommand } from 'citty'

import { getConfigPath, loadConfig } from '../../config'
import { getAccountMediaDir } from '../../db'
import {
  createMessageTranscriptsStore,
  type MessageTranscriptRow,
} from '../../db/message-transcripts'
import { createMessagesCache } from '../../db/messages-cache'
import { getClientForAccount } from '../../services/telegram'
import { exitAfterFlush } from '../../telemetry'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { flagValues } from '../../utils/args'
import { extractAttachment } from '../../utils/attachment'
import { error, getOutputFormat, info, success } from '../../utils/output'
import { createProgress } from '../../utils/progress'
import { wrapClientCallWithRateLimits } from '../../utils/telegram-rate-limits'
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
} from '../messages/helpers'
import { resolveHistoryChat } from '../messages/history'
import { downloadMedia } from './download-media'
import { MediaError, reportMediaError } from './errors'
import {
  convertToWav,
  findTranscriber,
  installSuggestion,
  type Runner,
  runTranscriber,
  SILENCE_MAX_VOLUME_DB,
} from './transcriber'

const CONTEXT = 'cli:media.transcribe'
const SPEECH_KINDS = new Set(['voice', 'round'])

export interface TranscribeResult {
  chatId: number
  messageId: number
  text: string
  language: string | null
  source: 'local'
  /** The program that made it; null for silent audio */
  runner: string | null
  model: string | null
  cached: boolean
}

function toResult(
  row: MessageTranscriptRow,
  cached: boolean,
): TranscribeResult {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    text: row.text,
    language: row.language,
    source: row.source,
    runner: row.runner,
    model: row.model,
    cached,
  }
}

function notSpeech(chatId: number, messageId: number, kind: string | null) {
  return new MediaError(
    ErrorCodes.MEDIA_UNSUPPORTED,
    `Message ${messageId} in chat ${chatId} is not a voice note or video note`,
    { chatId, messageId, kind, reason: 'not_speech' },
  )
}

/** The runner and ffmpeg, or the whole run fails: nothing can be transcribed */
function requireTranscriber(config: Parameters<typeof findTranscriber>[0]) {
  const dataDir = dirname(getConfigPath())
  let found: ReturnType<typeof findTranscriber>
  try {
    found = findTranscriber(config, dataDir)
  } catch (err) {
    reportMediaError(err)
  }
  if ('missing' in found) {
    const what = [
      !found.runner && 'No speech-to-text program',
      !found.ffmpeg && (found.runner ? 'No ffmpeg' : 'no ffmpeg'),
    ]
      .filter(Boolean)
      .join(' and ')
    error(
      ErrorCodes.TRANSCRIBER_NOT_FOUND,
      `${what} found on PATH`,
      { searched: found.searched, runner: found.runner, ffmpeg: found.ffmpeg },
      installSuggestion(
        { runner: !found.runner, ffmpeg: !found.ffmpeg },
        dataDir,
      ),
    )
  }
  return found
}

export const transcribeMediaCommand = defineCommand({
  meta: {
    name: 'transcribe',
    description:
      'Transcribe voice notes and video notes with a speech-to-text program on this machine (whisper.cpp or an openai-whisper CLI), store the text and print it',
  },
  args: {
    chat: {
      type: 'string',
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: 'string',
      description: 'Message ID; repeat for several',
      required: true,
    },
    language: {
      type: 'string',
      description:
        'Language code of the speech (en, ru…); the program detects it by default',
    },
    force: {
      type: 'boolean',
      description: 'Transcribe again, even when a transcript is stored',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args, rawArgs }) {
    const rawIds = flagValues(rawArgs ?? [], 'id')
    const messageIds = [
      ...new Set(
        (rawIds.length > 0 ? rawIds : [args.id]).map((id) =>
          parseIntegerArg(id, 'id', { min: 1, max: MAX_MESSAGE_ID }),
        ),
      ),
    ]
    const force = args.force ?? false
    const { account } = openAccountCache(args.account)
    const history = openHistory(account.id, CONTEXT)
    const store = createMessageTranscriptsStore(history.cacheDb)
    const messages = createMessagesCache(history.cacheDb)
    const now = Date.now

    let config: Awaited<ReturnType<typeof loadConfig>>['config']
    let chatId: number
    try {
      config = (await loadConfig({ strict: true })).config
      chatId = (await resolveHistoryChat(history.client, args.chat, history))
        .chatId
    } catch (err) {
      reportMediaError(err)
    }
    const language =
      args.language?.trim() || config.transcribe?.language || null

    const results = new Map<number, TranscribeResult | MediaError>()
    /** A transcript of the same file, copied to this message */
    const reuse = (messageId: number, uniqueFileId: string): boolean => {
      const row = force ? null : store.getByFile(uniqueFileId)
      if (!row) return false
      const copy = { ...row, chat_id: chatId, message_id: messageId }
      store.save(copy)
      results.set(messageId, toResult(copy, true))
      return true
    }

    const pending: number[] = []
    for (const messageId of messageIds) {
      const stored = force ? null : store.get(chatId, messageId)
      if (stored) {
        results.set(messageId, toResult(stored, true))
        continue
      }
      const row = messages.get(chatId, messageId)
      const attachment = row ? extractAttachment(row.raw_json) : null
      if (attachment && !SPEECH_KINDS.has(attachment.kind)) {
        results.set(messageId, notSpeech(chatId, messageId, attachment.kind))
        continue
      }
      if (attachment && reuse(messageId, attachment.uniqueFileId)) continue
      pending.push(messageId)
    }

    if (pending.length > 0) {
      const { runner, ffmpeg } = requireTranscriber(config.transcribe ?? {})
      const tmp = await mkdtemp(join(tmpdir(), 'tg-transcribe-'))
      // Reported only once the converted audio is gone: error() exits at once
      try {
        try {
          await transcribe(pending, runner, ffmpeg, tmp)
        } finally {
          await rm(tmp, { recursive: true, force: true })
        }
      } catch (err) {
        reportMediaError(err)
      }
    }

    async function transcribe(
      ids: number[],
      runner: Runner,
      ffmpeg: string,
      tmp: string,
    ): Promise<void> {
      const getClient = () =>
        wrapClientCallWithRateLimits(getClientForAccount(account.id), {
          context: CONTEXT,
          accountId: account.id,
        })
      const toRun: Array<{ messageId: number; wav: string; fileId: string }> =
        []
      for (const [index, messageId] of ids.entries()) {
        try {
          const file = await downloadMedia(
            {
              cacheDb: history.cacheDb,
              mediaDir: getAccountMediaDir(account.id),
              getClient,
              history,
              progress: (fileName) => createProgress(fileName),
            },
            { chat: args.chat, messageId, thumb: false, fresh: false },
          )
          if (!SPEECH_KINDS.has(file.kind)) {
            throw notSpeech(chatId, messageId, file.kind)
          }
          if (reuse(messageId, file.uniqueFileId)) continue
          const { wav, maxVolumeDb } = await convertToWav(
            ffmpeg,
            file.path,
            join(tmp, `${index}.wav`),
          )
          if (maxVolumeDb < SILENCE_MAX_VOLUME_DB) {
            const row: MessageTranscriptRow = {
              chat_id: chatId,
              message_id: messageId,
              unique_file_id: file.uniqueFileId,
              text: '',
              language: null,
              source: 'local',
              runner: null,
              model: null,
              transcribed_at: now(),
            }
            store.save(row)
            results.set(messageId, toResult(row, false))
            continue
          }
          toRun.push({ messageId, wav, fileId: file.uniqueFileId })
        } catch (err) {
          if (!(err instanceof MediaError)) throw err
          results.set(messageId, withMessage(err, chatId, messageId))
        }
      }
      if (toRun.length === 0) return

      // Progress for a person watching; agents read runner and model in the result
      if (process.stderr.isTTY)
        info(
          `Transcribing ${toRun.length} file${toRun.length === 1 ? '' : 's'} with ${runner.name} (${runner.modelName})`,
        )
      const transcripts = await runTranscriber(
        runner,
        toRun.map((item) => item.wav),
        tmp,
        language,
      )
      for (const [i, item] of toRun.entries()) {
        const transcript = transcripts[i]!
        if (transcript instanceof MediaError) {
          results.set(
            item.messageId,
            withMessage(transcript, chatId, item.messageId),
          )
          continue
        }
        const row: MessageTranscriptRow = {
          chat_id: chatId,
          message_id: item.messageId,
          unique_file_id: item.fileId,
          text: transcript.text,
          language: transcript.language,
          source: 'local',
          runner: runner.name,
          model: runner.modelName,
          transcribed_at: now(),
        }
        store.save(row)
        results.set(item.messageId, toResult(row, false))
      }
    }

    const ordered = messageIds.map((id) => results.get(id)!)
    if (ordered.length === 1) {
      const [only] = ordered
      if (only instanceof MediaError) reportMediaError(only)
      success(only)
      return
    }
    printBatch(ordered)
  },
})

/** chatId and messageId in a failure's details, so a batch line says which */
function withMessage(
  err: MediaError,
  chatId: number,
  messageId: number,
): MediaError {
  return new MediaError(
    err.code,
    err.message,
    { chatId, messageId, ...err.details },
    err.suggestion,
  )
}

/**
 * Several messages: one JSON line each, in the order of --id; exit 1 when
 * any failed
 */
function printBatch(results: Array<TranscribeResult | MediaError>): void {
  let failed = 0
  for (const result of results) {
    const line =
      result instanceof MediaError
        ? {
            success: false,
            error: {
              code: result.code,
              message: result.message,
              details: result.details,
              suggestion: result.suggestion,
            },
          }
        : { success: true, data: result }
    if (result instanceof MediaError) failed++
    if (getOutputFormat() !== 'quiet') console.log(JSON.stringify(line))
  }
  if (failed > 0) {
    info(
      `Transcribed ${results.length - failed} of ${results.length} messages, ${failed} failed`,
    )
  }
  void exitAfterFlush(failed > 0 ? 1 : 0)
}
