import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  createDaemonStatusService,
  type DaemonInfo,
  type DaemonStatusService,
  summarizeDaemonStatus,
} from "./daemon-status";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

describe("DaemonStatusService", () => {
  let db: Database;
  let service: DaemonStatusService;

  beforeEach(() => {
    db = createAccountCacheDb();
    service = createDaemonStatusService(db);
  });

  describe("convenience methods", () => {
    describe("setDaemonRunning", () => {
      it("drops the previous run's connection and queue until the first tick", () => {
        service.setDaemonRunning(1111, "0.4.0");
        service.writeTick({
          connectionStatus: "connected",
          lastError: "connection reset",
          messagesSynced: 40,
          pendingJobs: 7,
          runningJobs: 1,
        });
        db.run("UPDATE daemon_status SET value = '1000' WHERE key = 'last_update'");
        const before = Date.now();

        service.setDaemonRunning(2222, "0.4.0");

        expect(service.getDaemonInfo()).toMatchObject({
          status: "running",
          pid: 2222,
          connectionStatus: "connecting",
          lastError: null,
          messagesSynced: 0,
          pendingJobs: 0,
          runningJobs: 0,
        });
        const { startedAt, lastUpdate } = service.getDaemonInfo();
        expect(startedAt).toBeGreaterThanOrEqual(before);
        expect(lastUpdate).toBe(startedAt);
        expect(service.get("pending_jobs")).toBeNull();
        expect(service.get("running_jobs")).toBeNull();
      });

      it("records the version, tied to the PID", () => {
        service.setDaemonRunning(111, "0.3.1");

        expect(service.get("daemon_version")).toBe("0.3.1");
        expect(service.get("daemon_version_pid")).toBe("111");
        expect(service.getDaemonInfo().version).toBe("0.3.1");

        service.set("daemon_pid", "222");
        expect(service.getDaemonInfo()).toMatchObject({ pid: 222, version: null });
      });

      it("writes nothing if one of its keys fails to write", () => {
        db.run(
          "CREATE TRIGGER fail_start BEFORE INSERT ON daemon_status WHEN NEW.key = 'daemon_status' BEGIN SELECT RAISE(ABORT, 'boom'); END",
        );

        expect(() => service.setDaemonRunning(111, "0.3.1")).toThrow("boom");

        expect(service.get("daemon_version")).toBeNull();
        expect(service.get("daemon_version_pid")).toBeNull();
        expect(service.get("daemon_pid")).toBeNull();
      });
    });

    describe("setDaemonStopped", () => {
      it("clears the PID and the version", () => {
        expect(service.getDaemonInfo()).toMatchObject({
          status: "stopped",
          pid: null,
          version: null,
        });
        service.setDaemonRunning(111, "0.3.1");

        service.setDaemonStopped();

        expect(service.get("daemon_version")).toBeNull();
        expect(service.get("daemon_version_pid")).toBeNull();
        expect(service.getDaemonInfo()).toMatchObject({
          status: "stopped",
          pid: null,
          version: null,
          connectionStatus: "disconnected",
        });
      });

      it("keeps the running state if one of its keys fails to write", () => {
        service.setDaemonRunning(111, "0.3.1");
        db.run(
          "CREATE TRIGGER fail_stop BEFORE INSERT ON daemon_status WHEN NEW.value = 'stopped' BEGIN SELECT RAISE(ABORT, 'boom'); END",
        );

        expect(() => service.setDaemonStopped()).toThrow("boom");

        expect(service.get("daemon_pid")).toBe("111");
        expect(service.get("daemon_version")).toBe("0.3.1");
        expect(service.get("daemon_version_pid")).toBe("111");
        expect(service.getDaemonInfo().version).toBe("0.3.1");
      });
    });

    describe("writeTick", () => {
      it("writes the account's figures and last_update", () => {
        const before = Date.now();
        service.writeTick({
          connectionStatus: "connected",
          lastError: null,
          messagesSynced: 42,
          pendingJobs: 3,
          runningJobs: 1,
        });

        expect(service.getAll()).toMatchObject({
          connection_status: "connected",
          messages_synced: "42",
          pending_jobs: "3",
          running_jobs: "1",
        });
        expect(service.get("last_error")).toBeNull();
        expect(Number(service.get("last_update"))).toBeGreaterThanOrEqual(before);
        expect(service.getDaemonInfo()).toMatchObject({
          connectionStatus: "connected",
          messagesSynced: 42,
          pendingJobs: 3,
          runningJobs: 1,
        });
      });

      it("writes a tick in one transaction", () => {
        db.run(`
          CREATE TRIGGER fail_running_jobs BEFORE INSERT ON daemon_status
          WHEN NEW.key = 'running_jobs'
          BEGIN SELECT RAISE(ABORT, 'disk full'); END
        `);

        expect(() =>
          service.writeTick({
            connectionStatus: "connected",
            lastError: null,
            messagesSynced: 42,
            pendingJobs: 3,
            runningJobs: 1,
          }),
        ).toThrow("disk full");
        expect(service.getAll()).toEqual({});
      });

      it("keeps the last error until a tick without one", () => {
        const tick = {
          connectionStatus: "error",
          lastError: "AUTH_KEY_UNREGISTERED",
          messagesSynced: 0,
          pendingJobs: 0,
          runningJobs: 0,
        };
        service.writeTick(tick);
        expect(service.getDaemonInfo()).toMatchObject({
          connectionStatus: "error",
          lastError: "AUTH_KEY_UNREGISTERED",
        });

        service.writeTick({
          ...tick,
          connectionStatus: "connected",
          lastError: null,
        });
        expect(service.getDaemonInfo()).toMatchObject({
          connectionStatus: "connected",
          lastError: null,
        });
      });

      it("writes the account's sync pace, and a start clears it (#133)", () => {
        const tick = {
          connectionStatus: "connected",
          lastError: null,
          messagesSynced: 0,
          pendingJobs: 4,
          runningJobs: 1,
        };
        service.writeTick(tick);
        expect(service.getDaemonInfo().pacing).toBeNull();

        service.writeTick({
          ...tick,
          pacing: {
            mode: "history",
            targetCallsPerSecond: 0.75,
            floodWaits: 2,
          },
        });
        expect(service.getDaemonInfo().pacing).toEqual({
          mode: "history",
          targetCallsPerSecond: 0.75,
          floodWaits: 2,
        });

        service.setDaemonRunning(4242, "0.9.0");
        expect(service.getDaemonInfo().pacing).toBeNull();
      });
    });
  });
});

describe("summarizeDaemonStatus", () => {
  const info = (overrides: Partial<DaemonInfo>) => {
    const result: DaemonInfo = {
      status: "running",
      pid: 4242,
      version: "0.4.0",
      startedAt: 1_000,
      lastUpdate: 5_000,
      connectionStatus: "connected",
      lastError: null,
      messagesSynced: 10,
      pendingJobs: 0,
      runningJobs: 0,
      lastCatchUp: null,
      pacing: null,
      ...overrides,
    };
    return result;
  };

  it("sums only the rows the live daemon wrote", () => {
    const summary = summarizeDaemonStatus(
      [
        info({ messagesSynced: 10, startedAt: 2_000, lastUpdate: 9_000 }),
        info({
          connectionStatus: "reconnecting",
          messagesSynced: 5,
          startedAt: 1_500,
          lastUpdate: 8_000,
        }),
        info({
          pid: 1111,
          version: "0.0.1",
          messagesSynced: 99,
          lastUpdate: 99_000,
        }),
        info({ status: "stopped", pid: null, messagesSynced: 7 }),
      ],
      4242,
    );

    expect(summary).toEqual({
      connectedAccounts: 1,
      totalAccounts: 2,
      version: "0.4.0",
      messagesSynced: 15,
      startedAt: 1_500,
      lastUpdate: 9_000,
    });
  });

  it("counts nothing without a live daemon, but keeps its last update", () => {
    const stopped = (lastUpdate: number | null) =>
      info({
        status: "stopped",
        pid: null,
        startedAt: null,
        connectionStatus: "disconnected",
        lastUpdate,
      });

    expect(summarizeDaemonStatus([stopped(7_000), stopped(9_500), stopped(null)], null)).toEqual({
      connectedAccounts: 0,
      totalAccounts: 0,
      version: null,
      messagesSynced: 0,
      startedAt: null,
      lastUpdate: 9_500,
    });
  });
});
