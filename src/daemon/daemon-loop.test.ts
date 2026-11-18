import { describe, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import type { DaemonContext } from "./daemon-context";
import { requestShutdown } from "./daemon-context";
import { mainLoop, waitForNextTick } from "./daemon-loop";
import { startDueJobs, waitForJobsInFlight } from "./daemon-scheduler";
import { createSyncScheduler } from "./scheduler";
import type { AccountConnectionState } from "./types";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createMessagesCache } from "../db/messages-cache";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncJobType, SyncPriority } from "../db/sync-schema";
import { createAccountCacheDb, failWrites } from "../test/cache-db.test-utils";
import {
  addAccountRuntime,
  cacheWithSyncJob,
  realSyncParts,
  syncedPrivateChat,
  testDaemonContext,
} from "../test/daemon-runtime.test-utils";
import { fakeDialogClient } from "../test/fake-dialogs.test-utils";
import { createFakeHistory, range } from "../test/fake-history.test-utils";

type CallParams = { abortSignal?: AbortSignal };

function clientWithCall(
  call: (request: unknown, params?: CallParams) => Promise<unknown>,
  rest: object = {},
) {
  return { ...rest, call } as unknown as TelegramClient;
}

function stoppingClient(ctx: DaemonContext, rest: object = {}) {
  return clientWithCall((_request, params) => {
    requestShutdown(ctx);
    return Promise.reject(params?.abortSignal?.reason);
  }, rest);
}

const emptyPage = { _: "messages.messages", messages: [], chats: [], users: [] };

function createContext() {
  const result: DaemonContext = testDaemonContext({
    verbosity: "quiet",
    state: { running: false, accounts: new Map(), shutdownRequested: false },
  });
  return result;
}

function immediateTicks(onTick: () => void = () => {}) {
  return {
    now: () => Date.now(),
    sleep: async (_ms: number, signal: AbortSignal) => {
      if (!signal.aborted) onTick();
    },
  };
}

function stopAfterTicks(ctx: DaemonContext, ticks: number, onTick: () => void = () => {}) {
  let count = 0;
  return immediateTicks(() => {
    onTick();
    count += 1;
    if (count >= ticks) ctx.state.shutdownRequested = true;
  });
}

function connectedState(accountId: number, client = {} as TelegramClient) {
  return {
    accountId,
    phone: `+1555000000${accountId}`,
    name: null,
    status: "connected" as const,
    client,
    lastActivity: 0,
  };
}

function runAccount(
  ctx: DaemonContext,
  accountId: number,
  db: ReturnType<typeof createAccountCacheDb>,
  client: TelegramClient,
  config?: Parameters<typeof realSyncParts>[3],
) {
  ctx.state.accounts.set(accountId, connectedState(accountId, client));
  return addAccountRuntime(ctx, accountId, db, realSyncParts(ctx, db, client, config));
}

describe("mainLoop", () => {
  it("logs status update failures without crashing", async () => {
    const ctx = createContext();
    const db = createAccountCacheDb();
    failWrites(db, "daemon_status", "status fail");
    addAccountRuntime(ctx, 1, db);

    await mainLoop(ctx, stopAfterTicks(ctx, 1));

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Account 1] Failed to update daemon status: SQLiteError: status fail",
      ),
    );
  });

  it("writes each account's tick to its own cache", async () => {
    const ctx = createContext();
    const seedJobs = (db: ReturnType<typeof createAccountCacheDb>, statuses: string[]) => {
      for (const [i, status] of statuses.entries()) {
        db.run("INSERT INTO sync_jobs (chat_id, job_type, priority, status) VALUES (?, ?, ?, ?)", [
          101 + i,
          SyncJobType.BackwardHistory,
          SyncPriority.Low,
          status,
        ]);
      }
    };
    const firstDb = createAccountCacheDb();
    seedJobs(firstDb, ["pending", "running", "failed", "completed"]);
    const first = addAccountRuntime(ctx, 1, firstDb, {
      messagesSynced: 40,
    });
    const secondDb = createAccountCacheDb();
    seedJobs(secondDb, ["pending", "pending", "pending", "running"]);
    const second = addAccountRuntime(ctx, 2, secondDb, {
      messagesSynced: 2,
      scheduler: realSyncParts(ctx, secondDb, {} as TelegramClient).scheduler,
    });
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000001",
      name: null,
      status: "connected",
    });
    ctx.state.accounts.set(2, {
      accountId: 2,
      phone: "+15550000002",
      name: null,
      status: "error",
      lastError: "AUTH_KEY_UNREGISTERED",
    });
    const writes = [first, second].map((rt) => spyOn(rt.statusService, "writeTick"));

    await mainLoop(ctx, stopAfterTicks(ctx, 1));

    expect(writes.map((write) => write.mock.calls.length)).toEqual([1, 1]);
    expect(first.statusService.getDaemonInfo()).toMatchObject({
      connectionStatus: "connected",
      lastError: null,
      messagesSynced: 40,
      pendingJobs: 1,
      runningJobs: 1,
    });
    expect(second.statusService.getDaemonInfo()).toMatchObject({
      connectionStatus: "error",
      lastError: "AUTH_KEY_UNREGISTERED",
      messagesSynced: 2,
      pendingJobs: 3,
      runningJobs: 1,
    });
  });

  it("runs health checks and schedules reconnects when idle", async () => {
    const ctx = createContext();
    addAccountRuntime(ctx, 1);

    const client = {
      getMe: () => {
        throw new Error("offline");
      },
    } as unknown as TelegramClient;

    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: "+10000000001",
      name: null,
      status: "connected",
      client,
      lastActivity: 0,
    };

    ctx.state.accounts.set(1, accountState);

    setSystemTime(120000);

    try {
      await mainLoop(ctx, stopAfterTicks(ctx, 60));
    } finally {
      setSystemTime();
    }

    expect(ctx.state.accounts.get(1)?.status).toBe("error");
    expect(ctx.state.accounts.get(1)?.nextReconnectAt).toBeDefined();
  });

  it("catches up after the computer slept during a health check (#124)", async () => {
    const ctx = createContext();
    const db = createAccountCacheDb();
    const chatSyncState = createChatSyncStateService(db);
    chatSyncState.upsert({
      chat_id: 1002,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 1000,
      backward_cursor: 1,
    });
    chatSyncState.markHistoryComplete(1002);
    chatSyncState.raiseTopMessageId(1002, 1000);
    const jobsService = createSyncJobsService(db);
    const rt = addAccountRuntime(ctx, 1, db, {
      scheduler: createSyncScheduler({
        db,
        jobsService,
        chatSyncState,
        messagesCache: createMessagesCache(db),
      }),
    });

    let clock = Date.UTC(2026, 0, 1);
    const fake = fakeDialogClient([{ kind: "user", id: 1002, topMessage: 1004 }]);
    const client = Object.assign(fake.client, {
      getMe: async () => {
        clock += 9 * 3_600_000;
        setSystemTime(clock);
        return {};
      },
    }) as unknown as TelegramClient;
    ctx.state.accounts.set(1, {
      ...connectedState(1, client),
      watch: { online: true },
    });
    const caughtUp = () => rt.statusService.getDaemonInfo().lastCatchUp !== null;

    setSystemTime(clock);
    try {
      await mainLoop(
        ctx,
        stopAfterTicks(ctx, 1000, () => {
          clock += 1_000;
          setSystemTime(clock);
          if (caughtUp()) ctx.state.shutdownRequested = true;
        }),
      );
    } finally {
      setSystemTime();
    }

    expect(caughtUp()).toBe(true);
    expect(rt.statusService.getDaemonInfo().lastCatchUp).toMatchObject({
      reason: "wake",
      chats: 1,
    });
    expect(fake.calls).toHaveLength(1);
    expect(chatSyncState.get(1002)?.top_message_id).toBe(1004);
    expect(
      jobsService
        .getPendingJobs()
        .filter((job) => job.job_type === SyncJobType.ForwardCatchup)
        .map((job) => job.chat_id),
    ).toEqual([1002]);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "[Account 1] Woke after 9 h asleep: dialog pass, 1 chat(s) to catch up",
    );
    db.close();
  });

  it("refreshes every account's queues, even when one fails", async () => {
    const ctx = createContext();
    const caches = [1, 2].map(() => {
      const db = createAccountCacheDb();
      syncedPrivateChat(db, 55, { forward_cursor: 1 });
      const state = createChatSyncStateService(db);
      state.markHistoryComplete(55);
      state.raiseTopMessageId(55, 5);
      return db;
    });
    failWrites(caches[0]!, "sync_jobs", "disk I/O error");
    const [first, second] = caches.map((db, i) =>
      addAccountRuntime(ctx, i + 1, db, {
        scheduler: realSyncParts(ctx, db, {} as TelegramClient).scheduler,
      }),
    );
    const refreshes = [first!, second!].map((rt) => spyOn(rt.scheduler!, "refreshQueues"));

    await mainLoop(ctx, stopAfterTicks(ctx, 30));

    expect(refreshes.map((refresh) => refresh.mock.calls.length)).toEqual([1, 1]);
    expect(
      createSyncJobsService(caches[1]!)
        .getPendingJobs()
        .map((job) => [job.chat_id, job.job_type]),
    ).toEqual([[55, SyncJobType.ForwardCatchup]]);
    expect(createSyncJobsService(caches[0]!).getPendingJobs()).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[Account 1] Failed to refresh sync queues: SQLiteError: disk I/O error",
      ),
    );
  });

  it("ends right after a job that a daemon stop cut short, even on a 60th tick", async () => {
    const ctx = createContext();
    let timeouts = 0;
    let now = 120_000;
    const { db, job } = cacheWithSyncJob(SyncJobType.ForwardCatchup, {
      chat: { forward_cursor: 1000 },
      row: { nextRunAt: now + 59_000 },
    });
    const state = createChatSyncStateService(db);
    state.markHistoryComplete(55);
    state.raiseTopMessageId(55, 1000);
    const getMe = mock(async () => ({}));
    const rt = runAccount(ctx, 1, db, stoppingClient(ctx, { getMe }));
    const processJobReal = spyOn(rt.worker!, "processJobReal");
    const getNextJob = spyOn(rt.scheduler!, "getNextJob");
    const writeTick = spyOn(rt.statusService, "writeTick");

    setSystemTime(now);
    try {
      await mainLoop(
        ctx,
        immediateTicks(() => {
          timeouts += 1;
          now += 1000;
          setSystemTime(now);
        }),
      );
      await waitForJobsInFlight(ctx);
    } finally {
      setSystemTime();
    }

    expect(processJobReal).toHaveBeenCalledTimes(1);
    expect(getNextJob).toHaveBeenCalledTimes(60);
    expect(writeTick).toHaveBeenCalledTimes(59);
    expect(timeouts).toBe(59);
    expect(getMe).not.toHaveBeenCalled();
    expect(createSyncJobsService(db).getById(job.id)).toEqual(job);
  });

  it("looks for due contacts on the first tick and then every 30th", async () => {
    const ctx = createContext();
    ctx.runtime.contacts.peersTtlMs = 0;
    const requests: string[] = [];
    const client = {
      withParams: () => ({
        call: async (request: { _: string }) => {
          requests.push(request._);
          return {
            _: "contacts.contacts",
            contacts: [],
            savedCount: 0,
            users: [],
          };
        },
      }),
    } as unknown as TelegramClient;
    addAccountRuntime(ctx, 1);
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000001",
      name: null,
      status: "connected",
      client,
    });

    await mainLoop(ctx, stopAfterTicks(ctx, 30));
    expect(requests).toEqual(["contacts.getContacts", "contacts.getContacts"]);
  });

  it("does not hold the loop on a contacts check that never ends", async () => {
    const ctx = createContext();
    const requests: string[] = [];
    const client = {
      withParams: () => ({
        call: (request: { _: string }) => {
          requests.push(request._);
          return new Promise(() => {});
        },
      }),
    } as unknown as TelegramClient;
    addAccountRuntime(ctx, 1);
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000001",
      name: null,
      status: "connected",
      client,
    });

    await mainLoop(ctx, stopAfterTicks(ctx, 30));
    expect(requests).toEqual(["contacts.getContacts"]);
  });

  it("makes no contacts call after a stop during the first tick", async () => {
    const ctx = createContext();
    const call = mock(() => new Promise(() => {}));
    const { db } = cacheWithSyncJob(SyncJobType.ForwardCatchup);
    runAccount(ctx, 1, db, stoppingClient(ctx, { withParams: () => ({ call }) }));

    await mainLoop(ctx, immediateTicks());
    await waitForJobsInFlight(ctx);

    expect(ctx.state.shutdownRequested).toBe(true);
    expect(call).not.toHaveBeenCalled();
  });

  it("prunes the caches on cleanup interval", async () => {
    const ctx = createContext();
    const db = createAccountCacheDb();
    db.query(
      "INSERT INTO api_activity (timestamp, method, success) VALUES (?, 'messages.getHistory', 1)",
    ).run(Math.floor(Date.now() / 1000) - 30 * 24 * 3600);
    addAccountRuntime(ctx, 1, db, {
      scheduler: realSyncParts(ctx, db, {} as TelegramClient).scheduler,
    });

    await mainLoop(ctx, stopAfterTicks(ctx, 300));

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      "[Account 1] Pruned 1 API activity rows, 0 rate limit windows, 0 completed and 0 failed jobs",
    );
  });

  it("finishes account 2's jobs while account 1's job waits, and stops both", async () => {
    const ctx = createContext();
    const events: string[] = [];
    let now = 1_760_000_000_000;
    const ticks: number[] = [];
    let tick = 1;
    const waitForStop = (_request: unknown, params?: CallParams) =>
      new Promise((_resolve, reject) => {
        const signal = params!.abortSignal!;
        signal.addEventListener(
          "abort",
          () => {
            events.push("1 stopped");
            reject(signal.reason);
          },
          { once: true },
        );
      });
    let secondRuns = 0;
    const secondHistory = createFakeHistory(range(1, 100), () => {
      secondRuns += 1;
      ticks.push(tick);
      events.push(`2 done ${secondRuns}`);
      if (secondRuns === 3) requestShutdown(ctx);
    });
    const [first, second] = [
      runAccount(
        ctx,
        1,
        cacheWithSyncJob(SyncJobType.ForwardCatchup).db,
        clientWithCall(waitForStop),
      ),
      runAccount(ctx, 2, cacheWithSyncJob(SyncJobType.ForwardCatchup).db, secondHistory.client, {
        batchSize: 1,
      }),
    ].map((rt) => spyOn(rt.worker!, "processJobReal"));

    setSystemTime(now);
    try {
      await mainLoop(
        ctx,
        immediateTicks(() => {
          now += 1000;
          setSystemTime(now);
          tick += 1;
        }),
      );
      await waitForJobsInFlight(ctx);
    } finally {
      setSystemTime();
    }

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(3);
    expect(ticks).toEqual([1, 4, 7]);
    expect(events).toEqual(["2 done 1", "2 done 2", "2 done 3", "1 stopped"]);
    expect(ctx.runtime.jobsInFlight.size).toBe(0);
  });

  it("a stop ends the tick wait at once", async () => {
    const ctx = createContext();
    addAccountRuntime(ctx, 1, createAccountCacheDb());
    setTimeout(() => requestShutdown(ctx), 20);

    const started = performance.now();
    await mainLoop(ctx);

    expect(performance.now() - started).toBeLessThan(500);
  });

  it("checks a busy account but waits to reconnect one until its job ends", async () => {
    const ctx = createContext();
    const finishes: Array<(page: unknown) => void> = [];
    const getMe = mock(async () => ({}));
    const blockedJob = () =>
      new Promise((resolve) => {
        finishes.push(resolve);
      });
    for (const accountId of [1, 2]) {
      runAccount(
        ctx,
        accountId,
        cacheWithSyncJob(SyncJobType.ForwardCatchup).db,
        clientWithCall(blockedJob, { getMe }),
      );
    }
    const second = ctx.state.accounts.get(2) as AccountConnectionState;

    setSystemTime(120000);
    try {
      startDueJobs(ctx);
      second.status = "error";
      second.nextReconnectAt = 1;
      await mainLoop(ctx, stopAfterTicks(ctx, 61));
    } finally {
      setSystemTime();
    }

    expect(getMe).toHaveBeenCalledTimes(1);
    expect(ctx.state.accounts.get(1)?.status).toBe("connected");
    expect(second.status).toBe("error");
    expect(second.nextReconnectAt).toBe(1);

    for (const finish of finishes) finish(emptyPage);
    await waitForJobsInFlight(ctx);
    expect(finishes).toHaveLength(2);
    expect(ctx.runtime.jobsInFlight.size).toBe(0);
  });
});

describe("waitForNextTick (#133)", () => {
  function fakeClock(start: number, onSleep: (ms: number) => void = () => {}) {
    let now = start;
    const sleeps: number[] = [];
    return {
      sleeps,
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          now += ms;
          onSleep(ms);
        },
      },
      get now() {
        return now;
      },
    };
  }

  function historyAccount(ctx: DaemonContext, lastStart: number) {
    const starts: number[] = [];
    const { db } = cacheWithSyncJob(SyncJobType.BackwardHistory, {
      chat: { forward_cursor: 1000, backward_cursor: 1000 },
    });
    const history = createFakeHistory(range(1, 1000), () => starts.push(Date.now()));
    const rt = runAccount(ctx, 1, db, history.client, { batchSize: 1 });
    rt.pacer.setHistoryDue(true);
    rt.pacer.recordStart(lastStart);
    return { rt, starts };
  }

  it("wakes inside the tick when an account's next job is due, then sleeps the rest", async () => {
    const ctx = createContext();
    const time = fakeClock(10_000, () => setSystemTime(time.now));
    const { starts } = historyAccount(ctx, 10_000 - 1029);
    setSystemTime(time.now);

    try {
      await waitForNextTick(ctx, 1000, time.clock);
      await waitForJobsInFlight(ctx);
    } finally {
      setSystemTime();
    }

    expect(starts).toEqual([10_400]);
    expect(time.sleeps).toEqual([400, 600]);
  });

  it("sleeps the whole tick when no job comes due in it", async () => {
    const ctx = createContext();
    const time = fakeClock(10_000);
    const { starts } = historyAccount(ctx, 10_000);

    await waitForNextTick(ctx, 1000, time.clock);

    expect(starts).toEqual([]);
    expect(time.sleeps).toEqual([1000]);
  });

  it("a stop during the wait for a due job starts no job and ends the tick", async () => {
    const ctx = createContext();
    const time = fakeClock(10_000, () => requestShutdown(ctx));
    const { starts } = historyAccount(ctx, 10_000 - 1029);

    await waitForNextTick(ctx, 1000, time.clock);

    expect(starts).toEqual([]);
    expect(time.sleeps).toEqual([400]);
    expect(ctx.runtime.jobsInFlight.size).toBe(0);
  });
});
