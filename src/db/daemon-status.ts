import type { Database } from "bun:sqlite";
import { DaemonStatusRow } from "./sync-schema";

/**
 * What the daemon last wrote to one account's cache. Each account's file has
 * its own rows: a row counts only while its daemon_pid is the live daemon's.
 */
export interface DaemonInfo {
  status: "running" | "stopped";
  pid: number | null;
  /** The version the running daemon recorded at start; null if none */
  version: string | null;
  startedAt: number | null;
  lastUpdate: number | null;
  /** The account's connection: connected, reconnecting, error, … */
  connectionStatus: string | null;
  lastError: string | null;
  /** Messages the daemon cached for this account since it started */
  messagesSynced: number;
  pendingJobs: number;
  runningJobs: number;
  /** The daemon's last dialog pass after a reconnect or a wake; null if none */
  lastCatchUp: CatchUpRecord | null;
  /** How fast the daemon starts the account's sync jobs; null if unknown */
  pacing: DaemonPacing | null;
}

/** How fast the daemon starts an account's sync jobs (#133) */
export interface DaemonPacing {
  /** `history` while first or history pages are due, else `calm` */
  mode: "history" | "calm";
  /** The pace it runs at now, in calls per second */
  targetCallsPerSecond: number;
  /** FLOOD_WAITs on messages.getHistory since the daemon started */
  floodWaits: number;
}

/** Why the daemon ran a dialog pass and catch-up after the start (#124) */
export type CatchUpReason = "reconnect" | "wake" | "new_client";

/** A dialog pass after a reconnect or a wake, as `tg status` shows it */
export interface CatchUpRecord {
  /** When the pass ended */
  at: number;
  reason: CatchUpReason;
  /** How long the account was offline or the computer asleep; null if unknown */
  offlineMs: number | null;
  /** Chats whose newest message was above the forward cursor after it */
  chats: number;
}

/** One main-loop tick's figures for an account */
export interface DaemonTick {
  connectionStatus: string;
  lastError: string | null;
  messagesSynced: number;
  pendingJobs: number;
  runningJobs: number;
  /** The account's sync pace; left as it was when absent */
  pacing?: DaemonPacing;
}

/**
 * Daemon status service interface
 */
export interface DaemonStatusService {
  /** Get a value by key */
  get(key: string): string | null;
  /** Set a value */
  set(key: string, value: string): void;
  /** Delete a key */
  delete(key: string): void;
  /** Get all key-value pairs */
  getAll(): Record<string, string>;

  /**
   * Mark daemon as running with given PID and version: the account is
   * `connecting`, and the previous run's error and job counts are gone
   */
  setDaemonRunning(pid: number, version: string): void;
  /** Mark daemon as stopped */
  setDaemonStopped(): void;
  /** Write a tick's figures and last_update in one transaction */
  writeTick(tick: DaemonTick): void;
  /** Record a dialog pass after a reconnect or a wake (#124) */
  recordCatchUp(record: CatchUpRecord): void;
  /** Get all daemon info */
  getDaemonInfo(): DaemonInfo;
}

/** The daemon's figures over every account it runs */
export interface DaemonSummary {
  /** Accounts whose rows the live daemon wrote and that are connected */
  connectedAccounts: number;
  /** Accounts whose rows the live daemon wrote */
  totalAccounts: number;
  /**
   * The version the live daemon recorded in its rows; null without live
   * rows or when it recorded none
   */
  version: string | null;
  messagesSynced: number;
  /** The earliest start among the live rows */
  startedAt: number | null;
  /**
   * The newest update among the live rows; without a live daemon, the
   * newest any daemon wrote, so a stopped daemon still says when it last ran
   */
  lastUpdate: number | null;
}

/**
 * Sum the accounts' rows. Only rows whose daemon_pid is the live daemon's
 * PID (from daemon.pid) count: a stopped daemon's or an older version's rows
 * say nothing about now. Only lastUpdate of a stopped daemon reads them.
 */
export function summarizeDaemonStatus(infos: DaemonInfo[], livePid: number | null) {
  const live =
    livePid === null
      ? []
      : infos.filter((info) => info.status === "running" && info.pid === livePid);
  const startTimes = live.flatMap((info) => (info.startedAt === null ? [] : [info.startedAt]));
  const updates = (livePid === null ? infos : live).flatMap((info) =>
    info.lastUpdate === null ? [] : [info.lastUpdate],
  );
  return {
    connectedAccounts: live.filter((info) => info.connectionStatus === "connected").length,
    totalAccounts: live.length,
    version: live.find((info) => info.version !== null)?.version ?? null,
    messagesSynced: live.reduce((sum, info) => sum + info.messagesSynced, 0),
    startedAt: startTimes.length > 0 ? Math.min(...startTimes) : null,
    lastUpdate: updates.length > 0 ? Math.max(...updates) : null,
  };
}

const CATCH_UP_KEYS = [
  "last_catch_up_at",
  "last_catch_up_reason",
  "last_offline_ms",
  "last_catch_up_chats",
] as const;

const PACING_KEYS = [
  "pacing_mode",
  "pacing_target_calls_per_second",
  "pacing_flood_waits",
] as const;

function readPacing(read: (key: string) => string | null) {
  const mode = read("pacing_mode");
  const target = Number(read("pacing_target_calls_per_second"));
  if ((mode !== "history" && mode !== "calm") || !(target > 0)) {
    const result: DaemonPacing | null = null;
    return result;
  }
  const result: DaemonPacing | null = {
    mode,
    targetCallsPerSecond: target,
    floodWaits: parseNumber(read("pacing_flood_waits")) ?? 0,
  };
  return result;
}

const CATCH_UP_REASONS: readonly string[] = [
  "reconnect",
  "wake",
  "new_client",
] satisfies CatchUpReason[];

function readCatchUp(read: (key: string) => string | null) {
  const at = parseNumber(read("last_catch_up_at"));
  const reason = read("last_catch_up_reason");
  if (at === null || reason === null || !CATCH_UP_REASONS.includes(reason)) {
    return null;
  }
  return {
    at,
    reason: reason as CatchUpReason,
    offlineMs: parseNumber(read("last_offline_ms")),
    chats: parseNumber(read("last_catch_up_chats")) ?? 0,
  };
}

function parseNumber(value: string | null) {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Create a daemon status service
 */
export function createDaemonStatusService(db: Database) {
  const stmts = {
    get: db.query(`
      SELECT value FROM daemon_status WHERE key = $key
    `),

    set: db.prepare(`
      INSERT OR REPLACE INTO daemon_status (key, value, updated_at)
      VALUES ($key, $value, $now)
    `),

    delete: db.prepare(`
      DELETE FROM daemon_status WHERE key = $key
    `),

    getAll: db
      .query(`
      SELECT key, value FROM daemon_status
    `)
      .as(DaemonStatusRow),
  };

  const service: DaemonStatusService = {
    get(key: string) {
      const result = stmts.get.get({ $key: key }) as {
        value: string | null;
      } | null;
      return result?.value ?? null;
    },

    set(key: string, value: string) {
      stmts.set.run({
        $key: key,
        $value: value,
        $now: Date.now(),
      });
    },

    delete(key: string) {
      stmts.delete.run({ $key: key });
    },

    getAll() {
      const rows = stmts.getAll.all();
      const result: Record<string, string> = {};
      for (const row of rows) {
        if (row.value !== null) {
          result[row.key] = row.value;
        }
      }
      return result;
    },

    setDaemonRunning(pid: number, version: string) {
      const now = Date.now();
      db.transaction(() => {
        service.set("daemon_version", version);
        service.set("daemon_version_pid", pid.toString());
        service.set("daemon_pid", pid.toString());
        service.set("daemon_started_at", now.toString());
        service.set("daemon_status", "running");
        service.set("messages_synced", "0");
        service.set("connection_status", "connecting");
        service.delete("last_error");
        service.delete("pending_jobs");
        service.delete("running_jobs");
        for (const key of CATCH_UP_KEYS) service.delete(key);
        for (const key of PACING_KEYS) service.delete(key);
        service.set("last_update", now.toString());
      }).immediate();
    },

    setDaemonStopped() {
      db.transaction(() => {
        service.delete("daemon_pid");
        service.delete("daemon_started_at");
        service.delete("daemon_version");
        service.delete("daemon_version_pid");
        service.set("daemon_status", "stopped");
        service.set("connection_status", "disconnected");
      }).immediate();
    },

    writeTick(tick: DaemonTick) {
      db.transaction(() => {
        service.set("connection_status", tick.connectionStatus);
        if (tick.lastError === null) {
          service.delete("last_error");
        } else {
          service.set("last_error", tick.lastError);
        }
        service.set("messages_synced", String(tick.messagesSynced));
        service.set("pending_jobs", String(tick.pendingJobs));
        service.set("running_jobs", String(tick.runningJobs));
        if (tick.pacing) {
          service.set("pacing_mode", tick.pacing.mode);
          service.set("pacing_target_calls_per_second", String(tick.pacing.targetCallsPerSecond));
          service.set("pacing_flood_waits", String(tick.pacing.floodWaits));
        }
        service.set("last_update", Date.now().toString());
      }).immediate();
    },

    recordCatchUp(record: CatchUpRecord) {
      db.transaction(() => {
        service.set("last_catch_up_at", String(record.at));
        service.set("last_catch_up_reason", record.reason);
        if (record.offlineMs === null) service.delete("last_offline_ms");
        else service.set("last_offline_ms", String(record.offlineMs));
        service.set("last_catch_up_chats", String(record.chats));
      }).immediate();
    },

    getDaemonInfo() {
      const values = service.getAll();
      const read = (key: string) => values[key] ?? null;
      const pid = read("daemon_pid");
      const result: DaemonInfo = {
        status: read("daemon_status") === "running" ? "running" : "stopped",
        pid: parseNumber(pid),
        version: pid !== null && read("daemon_version_pid") === pid ? read("daemon_version") : null,
        startedAt: parseNumber(read("daemon_started_at")),
        lastUpdate: parseNumber(read("last_update")),
        connectionStatus: read("connection_status"),
        lastError: read("last_error"),
        messagesSynced: parseNumber(read("messages_synced")) ?? 0,
        pendingJobs: parseNumber(read("pending_jobs")) ?? 0,
        runningJobs: parseNumber(read("running_jobs")) ?? 0,
        lastCatchUp: readCatchUp(read),
        pacing: readPacing(read),
      };
      return result;
    },
  };

  return service;
}
