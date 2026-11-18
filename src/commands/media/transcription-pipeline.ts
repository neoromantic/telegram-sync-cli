/**
 * The steps every transcription provider gets, in this order: eligibility
 * (voice and video notes, content protection) before any reuse; a stored
 * transcript of the file as it is now; the provider's setup; its limits;
 * the file and its audio only when the provider reads audio; the silence
 * check wherever audio is decoded; the provider; each result saved once it
 * exists, after eligibility is checked again. Temporary audio is removed
 * on success, failure and interrupt.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createMessageTranscriptsStore,
  type MessageTranscriptRow,
} from '../../db/message-transcripts'
import { ErrorCodes, type TranscriptSource } from '../../types'
import type { AttachmentInfo } from '../../utils/attachment'
import { info } from '../../utils/output'
import { type HistoryChat, resolveHistoryChat } from '../messages/history'
import { convertToWav, SILENCE_MAX_VOLUME_DB } from './audio'
import {
  checkedAttachment,
  type DownloadDeps,
  downloadMedia,
  readCachedAttachment,
} from './download-media'
import { MediaError } from './errors'
import type {
  AudioFormat,
  ProviderResult,
  ProviderSetup,
  TranscriptionProvider,
  TranscriptionRequest,
} from './transcription-provider'

export interface TranscribeResult {
  chatId: number
  messageId: number
  text: string
  language: string | null
  source: TranscriptSource
  /** The program or service that made it; null for silent audio */
  runner: string | null
  model: string | null
  cached: boolean
}

export type TranscribeOutcome = TranscribeResult | MediaError

export interface PipelineDeps {
  /** What `tg media download` reads with; its `signal` stops every step */
  download: DownloadDeps & { signal: AbortSignal }
  /** The selected provider, or its setup problem */
  setup: ProviderSetup
  language: string | null
  /** Ignore stored transcripts */
  force: boolean
  /** Where the temp directory for converted audio goes */
  tmpRoot?: string
  now?: () => number
}

/** A message the provider still has to transcribe */
interface Pending {
  messageId: number
  attachment: AttachmentInfo
}

const SPEECH_KINDS = new Set(['voice', 'round'])

function notSpeech(chatId: number, messageId: number, kind: string | null) {
  return new MediaError(
    ErrorCodes.MEDIA_UNSUPPORTED,
    `Message ${messageId} in chat ${chatId} is not a voice note or video note`,
    { chatId, messageId, kind, reason: 'not_speech' },
  )
}

/** chatId and messageId in a failure's details, so a batch line says which */
function withMessage(
  err: MediaError,
  chatId: number,
  messageId: number,
  extra: { details?: Record<string, unknown>; retryable?: boolean } = {},
): MediaError {
  return new MediaError(
    err.code,
    err.message,
    { chatId, messageId, ...err.details, ...extra.details },
    err.suggestion,
    extra.retryable ?? err.retryable,
  )
}

/** A provider's failure as reported: an unknown outcome is never retryable */
function failureError(
  result: Extract<ProviderResult, { status: 'failed' }>,
  chatId: number,
  messageId: number,
): MediaError {
  switch (result.failure) {
    case 'outcome_unknown':
      return withMessage(result.error, chatId, messageId, {
        details: { outcome: 'unknown' },
        retryable: false,
      })
    case 'retry_later':
      return withMessage(result.error, chatId, messageId, { retryable: true })
    case 'rejected':
      return withMessage(result.error, chatId, messageId)
  }
}

function toResult(row: MessageTranscriptRow, cached: boolean) {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    text: row.text,
    language: row.language,
    source: row.source,
    runner: row.runner,
    model: row.model,
    cached,
  } satisfies TranscribeResult
}

/** The format the pipeline prepares: the original file when the provider takes it */
function preparedFormat(formats: readonly AudioFormat[]): AudioFormat {
  return formats.includes('original') ? 'original' : 'wav16k'
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * Transcribe the messages, one outcome per ID in order. A problem with one
 * message fails that message; a problem with the chat, Telegram or the
 * account rejects the whole run, as does an abort of the signal.
 */
export async function transcribeMessages(
  deps: PipelineDeps,
  chatArg: string,
  messageIds: readonly number[],
): Promise<TranscribeOutcome[]> {
  const { download, setup } = deps
  const { signal, cacheDb, history } = download
  const now = deps.now ?? Date.now
  const store = createMessageTranscriptsStore(cacheDb)
  const chat = await resolveHistoryChat(history.client, chatArg, history)
  const { chatId } = chat
  const outcomes = new Map<number, TranscribeOutcome>()
  const fail = (messageId: number, err: MediaError) =>
    outcomes.set(messageId, withMessage(err, chatId, messageId))

  /** Saved only while the message is cached, eligible and holds the same file */
  const save = (
    request: Pick<TranscriptionRequest, 'messageId' | 'uniqueFileId'>,
    fields: Pick<
      MessageTranscriptRow,
      'text' | 'language' | 'source' | 'runner' | 'model'
    >,
  ): TranscribeOutcome => {
    const { messageId, uniqueFileId } = request
    const row: MessageTranscriptRow = {
      chat_id: chatId,
      message_id: messageId,
      unique_file_id: uniqueFileId,
      ...fields,
      transcribed_at: now(),
    }
    let current: AttachmentInfo | null
    try {
      current = readCachedAttachment(download, chat, messageId)
    } catch (err) {
      if (!(err instanceof MediaError)) throw err
      return withMessage(err, chatId, messageId)
    }
    // A message the cache keeps out (a group the account left) keeps no transcript either
    if (!current) return toResult(row, false)
    if (current.uniqueFileId !== uniqueFileId) {
      return new MediaError(
        ErrorCodes.GENERAL_ERROR,
        `The file of message ${messageId} in chat ${chatId} changed while it was transcribed`,
        { chatId, messageId, reason: 'attachment_changed' },
        'run the command again',
        true,
      )
    }
    store.save(row)
    return toResult(row, false)
  }

  const pending = await checkAndReuse(deps, chat, messageIds, outcomes, fail)
  if (pending.length > 0) {
    if (!setup.ready) {
      for (const item of pending) fail(item.messageId, setup.problem)
    } else {
      await runProvider(setup, pending)
    }
  }
  return messageIds.map((id) => outcomes.get(id)!)

  async function runProvider(
    ready: Extract<ProviderSetup, { ready: true }>,
    items: Pending[],
  ): Promise<void> {
    const { provider, ffmpeg } = ready
    const declaration = provider.declaration
    const { maxDurationSeconds, input } = declaration
    const allowed = items.filter(({ messageId, attachment }) => {
      const duration = attachment.duration ?? 0
      if (maxDurationSeconds === null || duration <= maxDurationSeconds) {
        return true
      }
      fail(
        messageId,
        new MediaError(
          ErrorCodes.MEDIA_UNSUPPORTED,
          `Message ${messageId} in chat ${chatId} is longer than ${declaration.engine} takes`,
          { duration, maxDuration: maxDurationSeconds, reason: 'too_long' },
        ),
      )
      return false
    })
    if (allowed.length === 0) return

    const toRun: TranscriptionRequest[] = []
    if (input.kind === 'message') {
      for (const item of allowed) toRun.push(requestFor(item, null))
      await runBatches(provider, toRun)
      return
    }

    const format = preparedFormat(input.formats)
    const tmp =
      format === 'wav16k'
        ? await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'tg-transcribe-'))
        : null
    try {
      for (const [index, item] of allowed.entries()) {
        signal.throwIfAborted()
        const { messageId } = item
        try {
          const file = await downloadMedia(download, {
            chat: chatArg,
            messageId,
            thumb: false,
            fresh: false,
          })
          if (format === 'original') {
            toRun.push(
              requestFor(item, {
                path: file.path,
                format,
                mimeType: file.mimeType,
              }),
            )
            continue
          }
          if (!ffmpeg || !tmp) {
            throw new Error('A WAV provider is ready without ffmpeg')
          }
          const wav = join(tmp, `${index}.wav`)
          const peakDb = await convertToWav(ffmpeg, file.path, wav, signal)
          if (peakDb < SILENCE_MAX_VOLUME_DB) {
            outcomes.set(
              messageId,
              save(requestFor(item, null), {
                text: '',
                language: null,
                source: declaration.id,
                runner: null,
                model: null,
              }),
            )
            continue
          }
          toRun.push(
            requestFor(item, { path: wav, format, mimeType: 'audio/wav' }),
          )
        } catch (err) {
          if (!(err instanceof MediaError)) throw err
          fail(messageId, err)
        }
      }
      if (toRun.length > 0) await runBatches(provider, toRun)
    } finally {
      if (tmp) await rm(tmp, { recursive: true, force: true })
    }
  }

  function requestFor(
    item: Pending,
    audio: TranscriptionRequest['audio'],
  ): TranscriptionRequest {
    const { attachment } = item
    return {
      chatId,
      messageId: item.messageId,
      kind: attachment.kind === 'round' ? 'round' : 'voice',
      durationSeconds: attachment.duration,
      uniqueFileId: attachment.uniqueFileId,
      audio,
    }
  }

  async function runBatches(
    provider: TranscriptionProvider,
    requests: TranscriptionRequest[],
  ): Promise<void> {
    const { engine, model, batchSize, concurrency } = provider.declaration
    // Progress for a person watching; agents read runner and model in the result
    if (process.stderr.isTTY) {
      const files = `${requests.length} file${requests.length === 1 ? '' : 's'}`
      info(`Transcribing ${files} with ${engine}${model ? ` (${model})` : ''}`)
    }
    const batches = chunk(requests, batchSize)
    let next = 0
    const worker = async () => {
      for (let batch = batches[next++]; batch; batch = batches[next++]) {
        signal.throwIfAborted()
        const results = await provider.transcribe(batch, {
          language: deps.language,
          signal,
        })
        for (const [i, request] of batch.entries()) {
          const result = results[i]!
          outcomes.set(
            request.messageId,
            result.status === 'done'
              ? save(request, {
                  text: result.text,
                  language: result.language,
                  source: provider.declaration.id,
                  runner: engine,
                  model: result.model,
                })
              : failureError(result, chatId, request.messageId),
          )
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, worker),
    )
  }
}

/**
 * Eligibility, then reuse: each message's attachment as it is now, checked
 * as `tg media download` checks it, before any stored transcript is read.
 * Returns the messages a provider still has to transcribe.
 */
async function checkAndReuse(
  deps: PipelineDeps,
  chat: HistoryChat,
  messageIds: readonly number[],
  outcomes: Map<number, TranscribeOutcome>,
  fail: (messageId: number, err: MediaError) => void,
): Promise<Pending[]> {
  const { download, force } = deps
  const store = createMessageTranscriptsStore(download.cacheDb)
  const pending: Pending[] = []
  for (const messageId of messageIds) {
    download.signal.throwIfAborted()
    let attachment: AttachmentInfo
    try {
      attachment = await checkedAttachment(download, chat, messageId)
    } catch (err) {
      if (!(err instanceof MediaError)) throw err
      fail(messageId, err)
      continue
    }
    if (!SPEECH_KINDS.has(attachment.kind)) {
      fail(messageId, notSpeech(chat.chatId, messageId, attachment.kind))
      continue
    }
    const stored = force ? null : store.get(chat.chatId, messageId)
    if (stored?.unique_file_id === attachment.uniqueFileId) {
      outcomes.set(messageId, toResult(stored, true))
      continue
    }
    const sameFile = force ? null : store.getByFile(attachment.uniqueFileId)
    if (sameFile) {
      const copy = { ...sameFile, chat_id: chat.chatId, message_id: messageId }
      store.save(copy)
      outcomes.set(messageId, toResult(copy, true))
      continue
    }
    pending.push({ messageId, attachment })
  }
  return pending
}
