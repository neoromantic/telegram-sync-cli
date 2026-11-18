import type { Database } from "bun:sqlite";
import { capturesSql } from "./group-participation";
import { historyDoneSql, SyncJobStatus, SyncJobType } from "./sync-schema";

/** The span the pace of history pages is measured over */
export const HISTORY_PACE_WINDOW_MS = 15 * 60 * 1000;

/** The span the rate of `messages.getHistory` calls is measured over */
export const HISTORY_CALL_RATE_WINDOW_MS = 5 * 60 * 1000;

const LARGEST_PENDING_LIMIT = 5;

const HISTORY_JOB_TYPES = [
  SyncJobType.BackwardHistory,
  SyncJobType.InitialLoad,
  SyncJobType.FullSync,
];

export interface PendingHistoryChat {
  chat_id: number;
  chat_type: string;
  messages_cached: number;
  messages_known: number;
  messages_left: number;
}

export interface HistoryProgress {
  /** Chats with sync on whose history isn't complete */
  chats_pending: number;
  /** Pending chats that have no count from Telegram yet */
  chats_without_count: number;
  /**
   * Messages cached in the chats with a count, at most the count each, and
   * in complete chats without one
   */
  messages_cached: number;
  /**
   * Those chats' messages on the server: the newest count, or for a
   * complete chat without one (synced by an older version; catch-up pages
   * give none) its cached messages
   */
  messages_known: number;
  /** Messages of pending chats not cached yet, by their counts */
  messages_left: number;
  /**
   * Messages history pages cached per minute over the last 15 minutes;
   * null without two pages in that span
   */
  messages_per_minute: number | null;
  /** messages_left at that pace; null without a pace or nothing left */
  eta_seconds: number | null;
  /**
   * `messages.getHistory` calls per second over the last 5 minutes, from
   * api_activity: every call of the account, the retry after a FLOOD_WAIT
   * and CLI calls included; null without two calls in that span
   */
  calls_per_second: number | null;
  /** The pending chats with the most messages left */
  largest_pending: PendingHistoryChat[];
}

export function emptyHistoryProgress() {
  const result: HistoryProgress = {
    chats_pending: 0,
    chats_without_count: 0,
    messages_cached: 0,
    messages_known: 0,
    messages_left: 0,
    messages_per_minute: null,
    eta_seconds: null,
    calls_per_second: null,
    largest_pending: [],
  };
  return result;
}

interface ChatRow {
  chat_id: number;
  chat_type: string;
  history_complete: number;
  history_done: number;
  total_messages: number | null;
  cached: number;
  has_gaps: number;
}

function measurePace(db: Database, now: number) {
  const types = HISTORY_JOB_TYPES.map((type) => `'${type}'`).join(", ");
  const jobs = db
    .query(
      `SELECT completed_at, messages_fetched FROM sync_jobs
       WHERE status = '${SyncJobStatus.Completed}'
         AND job_type IN (${types})
         AND completed_at >= $since AND completed_at <= $now
       ORDER BY completed_at`,
    )
    .all({ $since: now - HISTORY_PACE_WINDOW_MS, $now: now }) as Array<{
    completed_at: number;
    messages_fetched: number | null;
  }>;
  const first = jobs[0];
  if (jobs.length < 2 || !first || now <= first.completed_at) return null;

  const messages = jobs.slice(1).reduce((sum, job) => sum + (job.messages_fetched ?? 0), 0);
  return (messages / (now - first.completed_at)) * 60_000;
}

function measureCallRate(db: Database, now: number) {
  const row = db
    .query(
      `SELECT COUNT(*) AS calls, MIN(timestamp) AS first FROM api_activity
       WHERE method = 'messages.getHistory'
         AND timestamp >= $since AND timestamp <= $now`,
    )
    .get({ $since: now - HISTORY_CALL_RATE_WINDOW_MS, $now: now }) as {
    calls: number;
    first: number | null;
  } | null;
  if (!row || row.calls < 2 || row.first === null || now <= row.first) {
    return null;
  }
  return ((row.calls - 1) / (now - row.first)) * 1000;
}

export function readHistoryProgress(db: Database, options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  const rows = db
    .query(
      `SELECT s.chat_id, s.chat_type, s.history_complete,
         ${historyDoneSql("s")} AS history_done, s.total_messages,
         (SELECT COUNT(*) FROM messages_cache m WHERE m.chat_id = s.chat_id) AS cached,
         EXISTS (SELECT 1 FROM group_capture_gaps g WHERE g.chat_id = s.chat_id) AS has_gaps
       FROM chat_sync_state s
       WHERE s.sync_enabled = 1 AND ${capturesSql("s", Math.floor(now / 1000))}`,
    )
    .all() as ChatRow[];

  const progress = emptyHistoryProgress();
  const pending: PendingHistoryChat[] = [];
  for (const row of rows) {
    const pendingChat = row.history_done === 0;
    if (pendingChat) progress.chats_pending++;
    const newestPageOnly = !pendingChat && row.history_complete === 0;
    if (row.total_messages === null || newestPageOnly || row.has_gaps === 1) {
      if (pendingChat) {
        progress.chats_without_count++;
      } else {
        progress.messages_cached += row.cached;
        progress.messages_known += row.cached;
      }
      continue;
    }
    const cached = Math.min(row.cached, row.total_messages);
    progress.messages_cached += cached;
    progress.messages_known += row.total_messages;
    if (pendingChat) {
      const left = row.total_messages - cached;
      progress.messages_left += left;
      pending.push({
        chat_id: row.chat_id,
        chat_type: row.chat_type,
        messages_cached: cached,
        messages_known: row.total_messages,
        messages_left: left,
      });
    }
  }

  progress.largest_pending = pending
    .filter((chat) => chat.messages_left > 0)
    .sort((a, b) => b.messages_left - a.messages_left || a.chat_id - b.chat_id)
    .slice(0, LARGEST_PENDING_LIMIT);

  const pace = measurePace(db, now);
  progress.messages_per_minute = pace === null ? null : Math.round(pace);
  progress.eta_seconds =
    pace !== null && pace > 0 && progress.messages_left > 0
      ? Math.ceil((progress.messages_left / pace) * 60)
      : null;
  const callRate = measureCallRate(db, now);
  progress.calls_per_second = callRate === null ? null : Math.round(callRate * 100) / 100;

  return progress;
}
