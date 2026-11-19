import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getAccountCacheDb, getAccountCachePath } from "../db";
import { createDaemonStatusService } from "../db/daemon-status";
import { initCacheSchema } from "../db/schema";
import { testAccount, useTestDataDir } from "../test/accounts.test-utils";
import { fakeDialogClient } from "../test/fake-dialogs.test-utils";
import { fakeTelegramClients } from "../test/fake-telegram-client.test-utils";

const { created: connected, clients } = fakeTelegramClients();

let onDialogPass: (() => void) | null = null;

function connecting(accountId: number) {
  const pass = fakeDialogClient([]);
  clients.set(accountId, {
    ...pass.client,
    withParams(params: Parameters<typeof pass.client.withParams>[0]) {
      onDialogPass?.();
      return pass.client.withParams(params);
    },
  });
}

function stampForAnotherAccount(accountId: number) {
  const path = getAccountCachePath(accountId);
  mkdirSync(dirname(path), { recursive: true });
  const cache = new Database(path);
  initCacheSchema(cache);
  cache.run("INSERT INTO cache_meta (key, value) VALUES ('account_id', '99')");
  cache.close();
}

const { createDaemon } = await import("./daemon");
const { DaemonExitCode } = await import("./types");

let tempDir: string;
let pidPath: string;

function statusOf(accountId: number) {
  const cache = new Database(getAccountCachePath(accountId));
  try {
    return createDaemonStatusService(cache).getAll();
  } finally {
    cache.close();
  }
}

useTestDataDir([testAccount(), testAccount({ phone: "+15550000002", is_active: false })]);

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "tg-daemon-start-"));
  pidPath = join(tempDir, "daemon.pid");
  connected.length = 0;
});

afterEach(() => {
  clients.clear();
  onDialogPass = null;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("daemon start with a cache per account", () => {
  it("connects only the accounts whose cache opened, and marks each one's cache stopped", async () => {
    stampForAnotherAccount(1);
    const daemon = createDaemon({ pidPath });

    expect(await daemon.start()).toBe(DaemonExitCode.AllAccountsFailed);

    expect(connected).toEqual([2]);
    expect(statusOf(2)).toMatchObject({
      daemon_status: "stopped",
      connection_status: "disconnected",
    });
    expect(statusOf(2).daemon_pid).toBeUndefined();
    expect(statusOf(1).daemon_status).toBeUndefined();
  });

  it("fails without connecting when no account has a cache it can open", async () => {
    stampForAnotherAccount(1);
    stampForAnotherAccount(2);
    const daemon = createDaemon({ pidPath });

    expect(await daemon.start()).toBe(DaemonExitCode.AllAccountsFailed);
    expect(connected).toEqual([]);
  });

  it("writes each account's connection before the dialog pass", async () => {
    const previous = createDaemonStatusService(getAccountCacheDb(1));
    previous.setDaemonRunning(1111, "0.3.9");
    previous.writeTick({
      connectionStatus: "connected",
      lastError: null,
      messagesSynced: 40,
      pendingJobs: 7,
      runningJobs: 1,
    });
    connecting(2);
    const daemon = createDaemon({ pidPath });
    const seen: Record<number, Record<string, string>> = {};
    onDialogPass = () => {
      seen[1] = statusOf(1);
      seen[2] = statusOf(2);
      daemon.stop();
    };

    expect(await daemon.start()).toBe(DaemonExitCode.Success);

    const pid = String(process.pid);
    expect(seen[1]).toMatchObject({
      daemon_pid: pid,
      connection_status: "error",
      pending_jobs: "0",
      running_jobs: "0",
    });
    expect(seen[2]).toMatchObject({
      daemon_pid: pid,
      connection_status: "connected",
      pending_jobs: "0",
    });
    expect(statusOf(1)).toMatchObject({ daemon_status: "stopped" });
    expect(statusOf(2)).toMatchObject({ daemon_status: "stopped" });
  });
});
