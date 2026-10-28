/**
 * Errors of `tg media download`, thrown by its core (download-media.ts) and
 * reported by the command with the stable error schema
 */
import type { ErrorCode } from '../../types'
import { error } from '../../utils/output'
import { reportHistoryError } from '../messages/helpers'

/** A failure with its documented error code */
export class MediaError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>
  readonly suggestion?: string

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown>,
    suggestion?: string,
  ) {
    super(message)
    this.name = 'MediaError'
    this.code = code
    this.details = details
    this.suggestion = suggestion
  }
}

/**
 * SIGINT or SIGTERM stopped a download: the partial download is kept for
 * the next run. Not an error for the error schema: the command exits 130.
 */
export class DownloadInterruptedError extends Error {
  /** Bytes in the partial download; null when the transfer hadn't started */
  readonly downloaded: number | null
  /** The file's size, when Telegram gives it */
  readonly total: number | null

  constructor(downloaded: number | null, total: number | null) {
    super('Download interrupted')
    this.name = 'DownloadInterruptedError'
    this.downloaded = downloaded
    this.total = total
  }
}

/**
 * Report a failed download: a MediaError with its own code, a peer, config
 * or rate-limit error as `tg messages` reports it, anything else as
 * TELEGRAM_ERROR
 */
export function reportMediaError(err: unknown): never {
  if (err instanceof MediaError) {
    error(err.code, err.message, err.details, err.suggestion)
  }
  reportHistoryError(err, 'download media')
}
