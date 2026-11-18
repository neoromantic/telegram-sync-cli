import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createSyncScheduler } from "./scheduler";
import { processJobReal, REFETCH_BATCH_SIZE } from "./sync-worker-real-jobs";
import type { RealSyncWorkerContext } from "./sync-worker-real-types";
import { runMigrationBatch, runPendingMigrations } from "../db/background-migrations";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createRateLimitsService } from "../db/rate-limits";
import { BACKGROUND_MIGRATIONS } from "../db/raw-json-migrations";
import { createSenderLookups } from "../db/sender-lookups";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncJobStatus, SyncJobType, SyncPriority } from "../db/sync-schema";
import { createUsersCache } from "../db/users-cache";
import { toRawJson } from "../utils/raw-json";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";
import { range } from "../test/fake-history.test-utils";
import { takePartIn } from "../test/participation.test-utils";
import { photoMessage } from "../test/photo-message.test-utils";

const DM = 5001;
const CHANNEL_ID = 2002;
const CHANNEL = -1_000_000_002_002;

let db: Database;
let ctx: RealSyncWorkerContext;
let requests: Record<string, unknown>[];

function seedEmpty(chatId: number, messageId: number, hasMedia = false) {
  createMessagesCache(db).upsert({
    chat_id: chatId,
    message_id: messageId,
    text: hasMedia ? null : `made-up note ${messageId}`,
    message_type: hasMedia ? "photo" : "text",
    has_media: hasMedia,
    date: 1_700_000_000 + messageId,
    raw_json: "{}",
  });
}

function textMessage(peerId: Record<string, unknown>, id: number) {
  return {
    _: "message",
    id,
    peerId,
    date: 1_700_000_000 + id,
    message: `made-up note ${id}`,
  };
}

function answer(messages: unknown[]) {
  ctx.client = {
    call: mock(async (request: Record<string, unknown>) => {
      requests.push(request);
      return { _: "messages.messages", messages, chats: [], users: [] };
    }),
  } as unknown as TelegramClient;
}

function rawJsonOf(chatId: number, messageId: number) {
  return createMessagesCache(db).get(chatId, messageId)?.raw_json;
}

beforeEach(() => {
  db = createAccountCacheDb();
  takePartIn(db, CHANNEL);
  requests = [];
  ctx = {
    client: {} as TelegramClient,
    messagesCache: createMessagesCache(db),
    historyRanges: createHistoryRanges(db),
    chatSyncState: createChatSyncStateService(db),
    jobsService: createSyncJobsService(db),
    rateLimits: createRateLimitsService(db),
    chatsCache: createChatsCache(db),
    usersCache: createUsersCache(db),
    senderLookups: createSenderLookups(db),
    config: { apiMethod: "messages.getHistory", batchSize: 100 },
  };
});

afterEach(() => {
  db.close();
});

const refetchMigration = BACKGROUND_MIGRATIONS.find(
  (migration) => migration.name === "messages_refetch_empty_raw_json",
)!;

function restartRefetchPass() {
  db.run(
    `UPDATE cache_migrations SET state = 'pending', cursor = 0, end_rowid = NULL, done = 0, total = NULL WHERE name = ?`,
    [refetchMigration.name],
  );
}

async function migrateBatchThenRunJobs(maxRows: number) {
  const batch = runMigrationBatch(db, refetchMigration, {
    maxRows,
    maxMs: 60_000,
  });
  for (const job of ctx.jobsService.getPendingJobs()) {
    await processJobReal(ctx, job);
  }
  return batch.finished;
}

describe("refetching messages cached with an empty raw_json (#130)", () => {
  it("queues one low-priority job per chat in a background pass", async () => {
    for (const id of [3, 4]) seedEmpty(DM, id);
    seedEmpty(CHANNEL, 9);
    createMessagesCache(db).upsert({
      chat_id: 6001,
      message_id: 1,
      text: "made-up note",
      message_type: "text",
      date: 1_700_000_000,
      raw_json: JSON.stringify(textMessage({ _: "peerUser", userId: 6001 }, 1)),
    });
    db.run(
      `UPDATE cache_migrations SET state = 'pending', cursor = 0, end_rowid = NULL, done = 0, total = NULL`,
    );

    await runPendingMigrations(db);

    const jobs = ctx.jobsService
      .getPendingJobs()
      .map((job) => [job.chat_id, job.job_type, job.priority]);
    expect(jobs).toEqual([
      [DM, SyncJobType.RefetchMessages, SyncPriority.Background],
      [CHANNEL, SyncJobType.RefetchMessages, SyncPriority.Background],
    ]);
  });

  it("fills the rows Telegram still has, attachment included, and leaves the others", async () => {
    const peer = { _: "peerUser", userId: DM } as const;
    seedEmpty(DM, 3);
    seedEmpty(DM, 4, true);
    seedEmpty(DM, 5);
    ctx.jobsService.queueRefetch(DM);
    const photo = photoMessage(peer, 4);
    answer([
      textMessage(peer, 3),
      photo,
      { _: "messageEmpty", id: 5 },
      textMessage({ _: "peerUser", userId: 6001 }, 3),
    ]);

    const [job] = ctx.jobsService.getPendingJobs();
    const result = await processJobReal(ctx, job!);

    expect(result).toMatchObject({ success: true, messagesFetched: 2 });
    expect(requests).toEqual([
      {
        _: "messages.getMessages",
        id: [3, 4, 5].map((id) => ({ _: "inputMessageID", id })),
      },
    ]);
    expect(rawJsonOf(DM, 3)).toBe(toRawJson(textMessage(peer, 3)));
    expect(rawJsonOf(DM, 4)).toBe(toRawJson(photo));
    expect(rawJsonOf(DM, 5)).toBe("{}");
    expect(rawJsonOf(6001, 3)).toBeUndefined();
    expect(db.query("SELECT chat_id, message_id, kind FROM message_attachments").all()).toEqual([
      { chat_id: DM, message_id: 4, kind: "photo" },
    ]);
    expect(ctx.jobsService.getJobsForChat(DM)).toMatchObject([
      { status: SyncJobStatus.Completed, cursor_start: 5 },
    ]);
  });

  it("asks channels.getMessages for a channel, whose sync is off", async () => {
    createChatsCache(db).upsert(
      dialogToCacheInput(fakeDialog({ kind: "channel", id: CHANNEL_ID })),
    );
    ctx.chatSyncState.upsert({
      chat_id: CHANNEL,
      chat_type: "channel",
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    });
    seedEmpty(CHANNEL, 9);
    ctx.jobsService.queueRefetch(CHANNEL);
    const post = textMessage({ _: "peerChannel", channelId: CHANNEL_ID }, 9);
    answer([post]);

    await createSyncScheduler({
      db,
      jobsService: ctx.jobsService,
      chatSyncState: ctx.chatSyncState,
      messagesCache: ctx.messagesCache,
    }).initializeForStartup();
    const [job] = ctx.jobsService.getPendingJobs();
    expect(job).toMatchObject({
      job_type: SyncJobType.RefetchMessages,
      priority: SyncPriority.Background,
    });
    await processJobReal(ctx, job!);

    expect(requests).toMatchObject([
      {
        _: "channels.getMessages",
        channel: { _: "inputChannel", channelId: CHANNEL_ID },
        id: [{ _: "inputMessageID", id: 9 }],
      },
    ]);
    expect(rawJsonOf(CHANNEL, 9)).toBe(toRawJson(post));
  });

  it("takes 100 IDs per request and queues the next job above them", async () => {
    const peer = { _: "peerUser", userId: DM } as const;
    for (const id of range(1, REFETCH_BATCH_SIZE + 5)) seedEmpty(DM, id);
    ctx.jobsService.queueRefetch(DM);
    answer([]);

    const [first] = ctx.jobsService.getPendingJobs();
    await processJobReal(ctx, first!);
    const [second] = ctx.jobsService.getPendingJobs();
    expect(second).toMatchObject({
      job_type: SyncJobType.RefetchMessages,
      cursor_start: REFETCH_BATCH_SIZE,
    });
    answer([textMessage(peer, REFETCH_BATCH_SIZE + 2)]);
    await processJobReal(ctx, second!);

    expect(requests.map((request) => (request.id as unknown[]).length)).toEqual([
      REFETCH_BATCH_SIZE,
      5,
    ]);
    expect(rawJsonOf(DM, REFETCH_BATCH_SIZE + 2)).not.toBe("{}");
    expect(ctx.jobsService.getPendingJobs()).toHaveLength(0);
  });

  it("queues a chat once per pass, even after its job failed for good", async () => {
    for (const id of range(1, 501)) seedEmpty(DM, id);
    restartRefetchPass();
    ctx.client = {
      call: mock(async (request: Record<string, unknown>) => {
        requests.push(request);
        throw new tl.RpcError(400, "PEER_ID_INVALID");
      }),
    } as unknown as TelegramClient;

    expect(await migrateBatchThenRunJobs(500)).toBe(false);
    while (!(await migrateBatchThenRunJobs(500))) {}

    expect(requests).toHaveLength(1);
    expect(ctx.jobsService.getJobsForChat(DM)).toMatchObject([{ status: SyncJobStatus.Failed }]);
  });

  it("asks for a message Telegram no longer has once, across batches of the pass", async () => {
    seedEmpty(DM, 3);
    seedEmpty(DM, 4);
    restartRefetchPass();
    answer([
      { _: "messageEmpty", id: 3 },
      { _: "messageEmpty", id: 4 },
    ]);

    while (!(await migrateBatchThenRunJobs(1))) {}

    expect(requests).toHaveLength(1);
    expect(rawJsonOf(DM, 3)).toBe("{}");
    expect(ctx.jobsService.getPendingJobs()).toHaveLength(0);
  });

  it("fetches a message cached without raw form while a refetch of its chat runs", async () => {
    const peer = { _: "peerUser", userId: DM } as const;
    seedEmpty(DM, 3);
    ctx.jobsService.queueRefetch(DM);
    ctx.client = {
      call: mock(async (request: Record<string, unknown>) => {
        requests.push(request);
        if (requests.length === 1) {
          seedEmpty(DM, 9);
          ctx.jobsService.queueRefetch(DM);
          return { messages: [textMessage(peer, 3)], users: [] };
        }
        return { messages: [textMessage(peer, 9)], users: [] };
      }),
    } as unknown as TelegramClient;

    for (let i = 0; i < 5; i++) {
      const [job] = ctx.jobsService.getPendingJobs();
      if (!job) break;
      await processJobReal(ctx, job);
    }

    expect(requests).toHaveLength(2);
    expect(rawJsonOf(DM, 9)).toBe(toRawJson(textMessage(peer, 9)));
    expect(ctx.jobsService.getPendingJobs()).toHaveLength(0);
  });

  it("keeps a pending refetch when tg chats sync changes the mode", () => {
    seedEmpty(DM, 3);
    ctx.chatSyncState.upsert({
      chat_id: DM,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    });
    expect(ctx.jobsService.queueRefetch(DM)).toBe(true);
    expect(ctx.jobsService.queueRefetch(DM)).toBe(false);

    ctx.jobsService.cancelPendingForChat(DM);
    ctx.jobsService.alignPendingPriorities();

    expect(ctx.jobsService.getPendingJobs()).toMatchObject([
      {
        job_type: SyncJobType.RefetchMessages,
        priority: SyncPriority.Background,
      },
    ]);
  });
});
