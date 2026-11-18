import type { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import {
  type AccountRuntime,
  createDaemonRuntime,
  type DaemonContext,
} from "../daemon/daemon-context";
import { createLogger } from "../daemon/daemon-logger";
import { createPidFile } from "../daemon/pid-file";
import { createSyncScheduler } from "../daemon/scheduler";
import { createSyncPacer } from "../daemon/sync-pacing";
import { createRealSyncWorker } from "../daemon/sync-worker-real";
import type { SyncWorkerConfig } from "../daemon/sync-worker-real-types";
import { type ChatSyncStateInput, createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createDaemonStatusService } from "../db/daemon-status";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createRateLimitsService } from "../db/rate-limits";
import { createSenderLookups } from "../db/sender-lookups";
import { createSyncJobsService } from "../db/sync-jobs";
import { type SyncJobType, SyncPriority } from "../db/sync-schema";
import { createUsersCache } from "../db/users-cache";
import { createSeededAccountsDb } from "./accounts.test-utils";
import { chatRow, createAccountCacheDb } from "./cache-db.test-utils";

/**
 * The daemon's quiet logger, each level watched by a spy that records the
 * message and still runs the logger: only warnings and errors are printed
 */
export function watchedLogger() {
  const logger = createLogger("quiet");
  return {
    info: spyOn(logger, "info"),
    debug: spyOn(logger, "debug"),
    warn: spyOn(logger, "warn"),
    error: spyOn(logger, "error"),
  };
}

/** A daemon context with no accounts, a watched logger and an unused PID file */
export function testDaemonContext(overrides: Partial<Omit<DaemonContext, "logger">> = {}) {
  const result: DaemonContext & { logger: ReturnType<typeof watchedLogger> } = {
    dataDir: "/tmp/tgcli",
    pidPath: "/tmp/tgcli/daemon.pid",
    verbosity: "normal",
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 3,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: watchedLogger(),
    pidFile: createPidFile("/tmp/tgcli/daemon.pid"),
    state: { running: true, accounts: new Map(), shutdownRequested: false },
    accountsDb: createSeededAccountsDb([]),
    runtime: createDaemonRuntime(),
    ...overrides,
  };
  return result;
}

/** Give the context a runtime for the account, on its own cache */
export function addAccountRuntime(
  ctx: DaemonContext,
  accountId: number,
  db: Database = createAccountCacheDb(),
  overrides: Partial<AccountRuntime> = {},
) {
  const rt: AccountRuntime = {
    accountId,
    db,
    statusService: createDaemonStatusService(db),
    scheduler: null,
    worker: null,
    pacer: createSyncPacer(),
    messagesSynced: 0,
    ...overrides,
  };
  ctx.runtime.accounts.set(accountId, rt);
  return rt;
}

/**
 * The account's real scheduler and sync worker on its cache, as the daemon
 * makes them, with the worker on `client` and the daemon's stop signal
 */
export function realSyncParts(
  ctx: DaemonContext,
  db: Database,
  client: TelegramClient,
  config?: Partial<SyncWorkerConfig>,
) {
  const jobsService = createSyncJobsService(db);
  const chatSyncState = createChatSyncStateService(db);
  const messagesCache = createMessagesCache(db);
  const scheduler = createSyncScheduler({ db, jobsService, chatSyncState, messagesCache });
  const worker = createRealSyncWorker({
    client,
    signal: ctx.runtime.shutdown.signal,
    messagesCache,
    historyRanges: createHistoryRanges(db),
    chatSyncState,
    jobsService,
    rateLimits: createRateLimitsService(db),
    chatsCache: createChatsCache(db),
    usersCache: createUsersCache(db),
    senderLookups: createSenderLookups(db),
    ...(config && { config }),
  });
  return { scheduler, worker };
}

/** A private chat the sync can build a peer for, with sync on */
export function syncedPrivateChat(
  db: Database,
  chatId: number,
  state: Partial<ChatSyncStateInput> = {},
) {
  createChatsCache(db).upsert(chatRow(chatId, "private", { access_hash: "777" }));
  createChatSyncStateService(db).upsert({
    chat_id: chatId,
    chat_type: "private",
    sync_priority: SyncPriority.High,
    sync_enabled: true,
    ...state,
  });
}

/** A pending sync job of the chat, due at `nextRunAt` (at once by default) */
export function queueSyncJob(
  db: Database,
  chatId: number,
  jobType: SyncJobType,
  row: { id?: number; attempts?: number; nextRunAt?: number } = {},
) {
  const jobs = createSyncJobsService(db);
  let { id } = jobs.create({ chat_id: chatId, job_type: jobType, priority: SyncPriority.High });
  if (row.id !== undefined) {
    db.run("UPDATE sync_jobs SET id = ? WHERE id = ?", [row.id, id]);
    id = row.id;
  }
  db.run("UPDATE sync_jobs SET attempts = ?, next_run_at = ? WHERE id = ?", [
    row.attempts ?? 0,
    row.nextRunAt ?? 0,
    id,
  ]);
  return jobs.getById(id)!;
}

/** A cache with a synced private chat, 55 by default, and one pending job of it */
export function cacheWithSyncJob(
  jobType: SyncJobType,
  options: {
    chatId?: number;
    chat?: Partial<ChatSyncStateInput>;
    row?: Parameters<typeof queueSyncJob>[3];
  } = {},
) {
  const db = createAccountCacheDb();
  const chatId = options.chatId ?? 55;
  syncedPrivateChat(db, chatId, options.chat ?? { forward_cursor: 1 });
  const job = queueSyncJob(db, chatId, jobType, options.row);
  return { db, job };
}
