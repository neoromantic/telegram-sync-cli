import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMessageTranscriptsStore,
  type MessageTranscriptRow,
} from "../../db/message-transcripts";
import { ErrorCodes, type TranscriptSource } from "../../types";
import type { AttachmentInfo } from "../../utils/attachment";
import { info } from "../../utils/output";
import { resolveHistoryChat } from "../messages/history";
import { convertToWav, SILENCE_MAX_VOLUME_DB } from "./audio";
import {
  checkedAttachment,
  type DownloadDeps,
  attachmentChanged,
  downloadResolved,
  type CheckedTarget,
  readCachedAttachment,
} from "./download-media";
import { MediaError } from "./errors";
import type {
  AudioFormat,
  ProviderResult,
  ProviderSetup,
  TranscriptionProvider,
  TranscriptionRequest,
} from "./transcription-provider";

export interface TranscribeResult {
  chatId: number;
  messageId: number;
  text: string;
  language: string | null;
  source: TranscriptSource;
  /** The program or service that made it; null for silent audio */
  runner: string | null;
  model: string | null;
  cached: boolean;
}

export type TranscribeOutcome = TranscribeResult | MediaError;

export interface PipelineDeps {
  /** What `tg media download` reads with; its `signal` stops every step */
  download: DownloadDeps & { signal: AbortSignal };
  /** The selected provider, or its setup problem */
  setup: ProviderSetup;
  language: string | null;
  /** Ignore stored transcripts */
  force: boolean;
  /** Where the temp directory for converted audio goes */
  tmpRoot?: string;
  now?: () => number;
}

type TranscriptFields = Omit<MessageTranscriptRow, "chat_id" | "message_id" | "unique_file_id">;

interface Pending {
  messageId: number;
  attachment: AttachmentInfo;
  prepared?: CheckedTarget;
}

const SPEECH_KINDS = new Set(["voice", "round"]);

function notSpeech(chatId: number, messageId: number, kind: string | null) {
  return new MediaError(
    ErrorCodes.MEDIA_UNSUPPORTED,
    `Message ${messageId} in chat ${chatId} is not a voice note or video note`,
    { chatId, messageId, kind, reason: "not_speech" },
  );
}

function withMessage(
  err: MediaError,
  chatId: number,
  messageId: number,
  extra: { details?: Record<string, unknown>; retryable?: boolean } = {},
) {
  return new MediaError(
    err.code,
    err.message,
    { chatId, messageId, ...err.details, ...extra.details },
    err.suggestion,
    extra.retryable ?? err.retryable,
  );
}

function failureError(
  result: Extract<ProviderResult, { status: "failed" }>,
  chatId: number,
  messageId: number,
) {
  switch (result.failure) {
    case "outcome_unknown":
      return withMessage(result.error, chatId, messageId, {
        details: { outcome: "unknown" },
        retryable: false,
      });
    case "retry_later":
      return withMessage(result.error, chatId, messageId, { retryable: true });
    case "rejected":
      return withMessage(result.error, chatId, messageId, { retryable: false });
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
  } satisfies TranscribeResult;
}

function preparedFormat(formats: readonly AudioFormat[]) {
  return formats.includes("original") ? "original" : "wav16k";
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
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
) {
  const { download, setup } = deps;
  const { signal, cacheDb, history } = download;
  const now = deps.now ?? Date.now;
  const store = createMessageTranscriptsStore(cacheDb);
  const chat = await resolveHistoryChat(history.client, chatArg, history);
  const { chatId } = chat;
  const expected = new Map<number, string>();
  const previouslyCached = new Set<number>();
  const outcomes = new Map<number, TranscribeOutcome>();
  const fail = (messageId: number, err: MediaError) =>
    outcomes.set(messageId, withMessage(err, chatId, messageId));

  function currentAttachment(messageId: number, fileId: string) {
    try {
      const current = readCachedAttachment(download, chat, messageId);
      if (
        current
          ? current.uniqueFileId !== fileId || !SPEECH_KINDS.has(current.kind)
          : previouslyCached.has(messageId)
      )
        return attachmentChanged(chatId, messageId);
      return current;
    } catch (err) {
      if (!(err instanceof MediaError)) throw err;
      return err;
    }
  }

  const save = cacheDb.transaction(
    (
      request: Pick<TranscriptionRequest, "messageId" | "uniqueFileId">,
      fields: TranscriptFields,
      cached = false,
    ) => {
      const { messageId, uniqueFileId } = request;
      const row: MessageTranscriptRow = {
        chat_id: chatId,
        message_id: messageId,
        unique_file_id: uniqueFileId,
        ...fields,
      };
      const current = currentAttachment(messageId, uniqueFileId);
      if (current instanceof MediaError) return current;
      if (!current) return toResult(row, cached);
      store.save(row);
      return toResult(row, cached);
    },
  ).immediate;

  const pending: Pending[] = [];
  for (const messageId of messageIds) {
    download.signal.throwIfAborted();
    let item: Pending;
    try {
      const checked = await checkedAttachment(
        download,
        chat,
        messageId,
        setup.ready ? null : setup.problem,
      );
      if (!checked.prepared) previouslyCached.add(messageId);
      item = { messageId, ...checked };
    } catch (err) {
      if (!(err instanceof MediaError)) throw err;
      fail(messageId, err);
      continue;
    }
    const { attachment } = item;
    expected.set(messageId, attachment.uniqueFileId);
    if (!SPEECH_KINDS.has(attachment.kind)) {
      fail(messageId, notSpeech(chat.chatId, messageId, attachment.kind));
      continue;
    }
    const stored = deps.force ? null : store.get(chat.chatId, messageId);
    if (stored?.unique_file_id === attachment.uniqueFileId) {
      outcomes.set(messageId, toResult(stored, true));
      continue;
    }
    const sameFile = deps.force ? null : store.getByFile(attachment.uniqueFileId);
    if (sameFile) {
      const { chat_id, message_id, unique_file_id, ...fields } = sameFile;
      outcomes.set(messageId, save({ messageId, uniqueFileId: unique_file_id }, fields, true));
      continue;
    }
    pending.push(item);
  }
  if (pending.length > 0) {
    if (!setup.ready) {
      for (const item of pending) fail(item.messageId, setup.problem);
    } else {
      await runProvider(setup, pending);
    }
  }
  return messageIds.map((id) => {
    const outcome = outcomes.get(id)!;
    const result =
      outcome instanceof MediaError ? outcome : currentAttachment(id, expected.get(id)!);
    if (!(result instanceof MediaError)) return outcome;
    if (!result.suggestion?.includes("--fresh")) return result;
    const account = history.accountId === undefined ? "" : ` --account ${history.accountId}`;
    return new MediaError(
      result.code,
      result.message,
      result.details,
      `Refresh the cached attachment with tg media download --chat ${chatId} --id ${id}${account} --fresh`,
      result.retryable,
    );
  });

  async function runProvider(ready: Extract<ProviderSetup, { ready: true }>, items: Pending[]) {
    const { provider, ffmpeg } = ready;
    const declaration = provider.declaration;
    const { maxDurationSeconds, input } = declaration;
    const allowed = items.filter(({ messageId, attachment }) => {
      const duration = attachment.duration ?? 0;
      if (maxDurationSeconds === null || duration <= maxDurationSeconds) {
        return true;
      }
      fail(
        messageId,
        new MediaError(
          ErrorCodes.MEDIA_UNSUPPORTED,
          `Message ${messageId} in chat ${chatId} is longer than ${declaration.engine} takes`,
          { duration, maxDuration: maxDurationSeconds, reason: "too_long" },
        ),
      );
      return false;
    });
    if (allowed.length === 0) return;

    const toRun: TranscriptionRequest[] = [];
    if (input.kind === "message") {
      for (const item of allowed) toRun.push(requestFor(item, null));
      await runBatches(provider, toRun);
      return;
    }

    const format = preparedFormat(input.formats);
    const tmp =
      format === "wav16k" ? await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "tg-transcribe-")) : null;
    const cleanup = () => {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    };
    if (tmp) process.once("exit", cleanup);
    try {
      for (const [index, item] of allowed.entries()) {
        signal.throwIfAborted();
        const { messageId } = item;
        try {
          const file = await downloadResolved(
            download,
            chat,
            {
              expectedAttachment: item.attachment,
              chat: chatArg,
              messageId,
              thumb: false,
              fresh: false,
            },
            item.prepared,
          );
          if (format === "original") {
            toRun.push(
              requestFor(item, {
                path: file.path,
                format,
                mimeType: file.mimeType,
              }),
            );
            continue;
          }
          if (!ffmpeg || !tmp) {
            throw new Error("A WAV provider is ready without ffmpeg");
          }
          const wav = join(tmp, `${index}.wav`);
          const peakDb = await convertToWav(ffmpeg, file.path, wav, signal);
          if (peakDb < SILENCE_MAX_VOLUME_DB) {
            outcomes.set(
              messageId,
              save(requestFor(item, null), {
                text: "",
                language: null,
                source: declaration.id,
                runner: null,
                model: null,
                transcribed_at: now(),
              }),
            );
            continue;
          }
          toRun.push(requestFor(item, { path: wav, format, mimeType: "audio/wav" }));
        } catch (err) {
          if (!(err instanceof MediaError)) throw err;
          fail(messageId, err);
        }
      }
      if (toRun.length > 0) await runBatches(provider, toRun);
    } finally {
      process.off("exit", cleanup);
      cleanup();
    }
  }

  function requestFor(item: Pending, audio: TranscriptionRequest["audio"]) {
    const { attachment } = item;
    return {
      chatId,
      messageId: item.messageId,
      kind: attachment.kind === "round" ? "round" : "voice",
      durationSeconds: attachment.duration,
      uniqueFileId: attachment.uniqueFileId,
      audio,
    } satisfies TranscriptionRequest;
  }

  async function runBatches(provider: TranscriptionProvider, requests: TranscriptionRequest[]) {
    const { engine, model, batchSize, concurrency } = provider.declaration;
    if (process.stderr.isTTY) {
      const files = `${requests.length} file${requests.length === 1 ? "" : "s"}`;
      info(`Transcribing ${files} with ${engine}${model ? ` (${model})` : ""}`);
    }
    const groups = new Map<string | number, TranscriptionRequest[]>();
    for (const request of requests) {
      const key =
        provider.declaration.input.kind === "audio" ? request.uniqueFileId : request.messageId;
      const group = groups.get(key);
      if (group) group.push(request);
      else groups.set(key, [request]);
    }
    const batches = chunk([...groups.values()], batchSize);
    let next = 0;
    const worker = async () => {
      for (let batch = batches[next++]; batch; batch = batches[next++]) {
        signal.throwIfAborted();
        const eligible = batch
          .map((group) =>
            group.filter((request) => {
              const current = currentAttachment(request.messageId, request.uniqueFileId);
              if (!(current instanceof MediaError)) return true;
              fail(request.messageId, current);
              return false;
            }),
          )
          .filter((group) => group.length);
        if (!eligible.length) continue;
        const results = await provider.transcribe(
          eligible.map((group) => group[0]!),
          {
            language: deps.language,
            signal,
          },
        );
        signal.throwIfAborted();
        for (const [i, group] of eligible.entries()) {
          const result = results[i]!;
          for (const request of group) {
            outcomes.set(
              request.messageId,
              result.status === "done"
                ? save(request, {
                    text: result.text,
                    language: result.language,
                    source: provider.declaration.id,
                    runner: engine,
                    model: result.model ?? model,
                    transcribed_at: now(),
                  })
                : failureError(result, chatId, request.messageId),
            );
          }
        }
      }
    };
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, batches.length) }, worker),
    );
    for (const result of workers) if (result.status === "rejected") throw result.reason;
  }
}
