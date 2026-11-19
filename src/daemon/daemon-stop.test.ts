import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcCallOptions } from "@mtcute/bun";

import { CONTACTS_METHOD } from "./daemon-contacts";
import { getAccountCacheDb } from "../db";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createDaemonStatusService } from "../db/daemon-status";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncJobType, SyncPriority } from "../db/sync-schema";
import { useTestDataDir } from "../test/accounts.test-utils";
import { type FakeDialogInput, fakeDialogClient } from "../test/fake-dialogs.test-utils";
import { fakeTelegramClients } from "../test/fake-telegram-client.test-utils";
import { waitLikeFloodWait } from "../test/flood-wait.test-utils";

let onDestroy: (() => void) | null = null;
const { clients } = fakeTelegramClients({ onDestroy: () => onDestroy?.() });

const { createDaemon } = await import("./daemon");
const { DaemonExitCode } = await import("./types");

let tempDir: string;
let pidPath: string;

const CHAT = 1001;

function fakeClient(
  dialogs: FakeDialogInput[],
  options: Parameters<typeof fakeDialogClient>[1],
  call: (request: unknown, params?: RpcCallOptions) => Promise<unknown>,
) {
  const pass = fakeDialogClient(dialogs, options);
  const callMock = mock(call);
  Object.assign(pass.client, { call: callMock });
  return { client: pass.client, pass, call: callMock };
}

let log: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;

const output = () => log.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");

useTestDataDir();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tg-daemon-stop-"));
  pidPath = join(tempDir, "daemon.pid");
  log = spyOn(console, "log");
  warn = spyOn(console, "warn");
  error = spyOn(console, "error");
});

afterEach(() => {
  log.mockRestore();
  warn.mockRestore();
  error.mockRestore();
  clients.clear();
  onDestroy = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("daemon stop during a FLOOD_WAIT", () => {
  it("ends the startup dialog pass and exits at once", async () => {
    const daemon = createDaemon({ pidPath, verbosity: "verbose" });
    let stopped = false;
    const fake = fakeClient(
      [{ kind: "user", id: CHAT, topMessage: 10 }],
      {
        waitAfter: 1,
        onWait: () => {
          stopped = true;
          daemon.stop();
        },
      },
      async () => {
        throw new Error("No sync job runs after the stop");
      },
    );
    clients.set(1, fake.client);

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.Success);
    expect(stopped).toBe(true);
    expect(fake.pass.params).toHaveLength(1);
    expect(fake.call).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(output()).toContain(
      "[Account 1] Dialog pass stopped after 1 dialogs: the daemon is stopping",
    );
    expect(output()).not.toContain("Dialog page failed during the stop");
    expect(createDaemonStatusService(getAccountCacheDb(1)).getAll()).toMatchObject({
      daemon_status: "stopped",
    });
  });

  it("leaves the sync job pending as it was and exits at once", async () => {
    const cache = getAccountCacheDb(1);
    createChatSyncStateService(cache).upsert({
      chat_id: CHAT,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    });
    const jobs = createSyncJobsService(cache);
    const created = jobs.create({
      chat_id: CHAT,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.High,
    });
    cache.run(
      `UPDATE sync_jobs SET attempts = 2, error_message = 'connection reset',
         next_run_at = 0 WHERE id = ?`,
      [created.id],
    );
    const daemon = createDaemon({ pidPath, verbosity: "verbose" });
    let stopped = false;
    let jobRequests = 0;
    const fake = fakeClient([{ kind: "user", id: CHAT, topMessage: 10 }], {}, (request, params) => {
      if ((request as { _: string })._ === CONTACTS_METHOD) {
        return Promise.resolve({ _: "contacts.contactsNotModified" });
      }
      jobRequests++;
      return waitLikeFloodWait(params, {
        onWait: () => {
          stopped = true;
          daemon.stop();
        },
      }).catch((err) => new Promise((_resolve, reject) => setTimeout(() => reject(err), 5)));
    });
    clients.set(1, fake.client);
    const runningJobsAtDisconnect: number[] = [];
    onDestroy = () => {
      runningJobsAtDisconnect.push(jobs.countJobs().running);
    };

    const exitCode = await daemon.start();

    expect(exitCode).toBe(DaemonExitCode.Success);
    expect(stopped).toBe(true);
    expect(jobRequests).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(output()).toContain(
      `[Account 1] Job ${created.id} left pending: the daemon is stopping`,
    );
    const reopened = getAccountCacheDb(1);
    const jobsAfter = createSyncJobsService(reopened);
    expect(jobsAfter.getById(created.id)).toMatchObject({
      status: "pending",
      attempts: 2,
      error_message: "connection reset",
      next_run_at: 0,
      started_at: null,
    });
    expect(jobsAfter.countJobs().running).toBe(0);
    expect(runningJobsAtDisconnect).toEqual([0]);
    expect(createDaemonStatusService(reopened).getAll()).toMatchObject({
      daemon_status: "stopped",
    });
  });
});
