/**
 * Type definitions for telegram-sync-cli
 */
import type { AttachmentInfo } from '../utils/attachment'

/** Account stored in database */
export interface Account {
  id: number
  phone: string
  user_id: number | null
  name: string | null
  username: string | null
  label: string | null
  session_data: string
  is_active: number
  created_at: string
  updated_at: string
}

/** Output format options */
export type OutputFormat = 'json' | 'pretty' | 'quiet'

/** Result wrapper for consistent output */
export interface Result<T> {
  success: true
  data: T
}

/** Error wrapper for consistent output */
export interface ErrorResult {
  success: false
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
    /** What to do next, for errors that have a fix */
    suggestion?: string
  }
}

/** CLI output type */
export type Output<T> = Result<T> | ErrorResult

/** Contact from Telegram */
export interface Contact {
  id: number
  firstName: string
  lastName: string | null
  username: string | null
  phone: string | null
}

/** Paginated response */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
}

/** Message search result item */
export interface MessageSearchItem {
  chatId: number
  messageId: number
  fromId: number | null
  text: string | null
  messageType: string
  hasMedia: boolean
  mediaPath: string | null
  /** The message's file, read from its raw_json; null when it has none */
  attachment: AttachmentInfo | null
  isOutgoing: boolean
  isEdited: boolean
  isPinned: boolean
  isDeleted: boolean
  replyToId: number | null
  forwardFromId: number | null
  editDate: number | null
  date: number
  chat: {
    id: number
    title: string | null
    username: string | null
    type: string | null
  }
  sender: {
    id: number | null
    username: string | null
    firstName: string | null
    lastName: string | null
  }
}

/** Auth state */
export type AuthState =
  | { state: 'unauthorized' }
  | { state: 'awaiting_code'; phone: string; phoneCodeHash: string }
  | { state: 'awaiting_password'; phone: string; hint?: string }
  | {
      state: 'authorized'
      user: { id: number; firstName: string; username?: string }
    }

/** Error codes */
export const ErrorCodes = {
  GENERAL_ERROR: 'GENERAL_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  INVALID_ARGS: 'INVALID_ARGS',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TELEGRAM_ERROR: 'TELEGRAM_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  NO_ACTIVE_ACCOUNT: 'NO_ACTIVE_ACCOUNT',
  CACHE_UNAVAILABLE: 'CACHE_UNAVAILABLE',
  PHONE_CODE_INVALID: 'PHONE_CODE_INVALID',
  SESSION_PASSWORD_NEEDED: 'SESSION_PASSWORD_NEEDED',
  // Daemon error codes
  DAEMON_NOT_RUNNING: 'DAEMON_NOT_RUNNING',
  DAEMON_ALREADY_RUNNING: 'DAEMON_ALREADY_RUNNING',
  DAEMON_SIGNAL_FAILED: 'DAEMON_SIGNAL_FAILED',
  DAEMON_SHUTDOWN_TIMEOUT: 'DAEMON_SHUTDOWN_TIMEOUT',
  DAEMON_FORCE_KILL_FAILED: 'DAEMON_FORCE_KILL_FAILED',
  // SQL error codes
  SQL_SYNTAX_ERROR: 'SQL_SYNTAX_ERROR',
  SQL_TABLE_NOT_FOUND: 'SQL_TABLE_NOT_FOUND',
  SQL_WRITE_NOT_ALLOWED: 'SQL_WRITE_NOT_ALLOWED',
  SQL_OPERATION_BLOCKED: 'SQL_OPERATION_BLOCKED',
  // Media error codes
  NO_MEDIA: 'NO_MEDIA',
  MESSAGE_NOT_FOUND: 'MESSAGE_NOT_FOUND',
  CONTENT_PROTECTED: 'CONTENT_PROTECTED',
  MEDIA_UNSUPPORTED: 'MEDIA_UNSUPPORTED',
  FILE_EXISTS: 'FILE_EXISTS',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]
