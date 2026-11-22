import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigError,
  getConfigPath,
  getConfigValue,
  getResolvedCacheConfig,
  loadAccessSettings,
  loadConfig,
  loadDaemonConfig,
  parseConfigValue,
  setConfigValue,
  syncActiveAccountFromConfig,
} from "./index";
import { DEFAULT_SYNC_PACING } from "../daemon/sync-pacing";
import { createTestDatabase } from "../db";
import { getDefaultCacheConfig, getDefaultRetentionConfig, parseDuration } from "../db/types";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "telegram-sync-cli-config-test-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("config", () => {
  it("returns empty config when file is missing", async () => {
    const result = await loadConfig({ dataDir });

    expect(result.exists).toBe(false);
    expect(result.config).toEqual({});
    expect(result.errors).toEqual([]);
  });

  it("sets and gets config values", async () => {
    await setConfigValue("cache.staleness.peers", "2d", { dataDir });
    await setConfigValue("cache.backgroundRefresh", false, { dataDir });

    const peers = await getConfigValue("cache.staleness.peers", {
      dataDir,
      strict: true,
    });
    const backgroundRefresh = await getConfigValue("cache.backgroundRefresh", {
      dataDir,
      strict: true,
    });

    expect(peers).toBe("2d");
    expect(backgroundRefresh).toBe(false);
  });

  it("parses config values with validation", () => {
    expect(parseConfigValue("activeAccount", "2")).toBe(2);
    expect(parseConfigValue("cache.backgroundRefresh", "true")).toBe(true);
    expect(parseConfigValue("cache.staleness.peers", " 7D ")).toBe("7d");

    expect(() => parseConfigValue("activeAccount", "0")).toThrow(ConfigError);
    expect(() => parseConfigValue("cache.staleness.peers", "nope")).toThrow(ConfigError);
  });

  it("loads resolved cache config overrides", async () => {
    await setConfigValue("cache.staleness.peers", "3d", { dataDir });
    await setConfigValue("cache.maxCacheAge", "14d", { dataDir });

    const resolved = await getResolvedCacheConfig({ dataDir });
    const defaults = getDefaultCacheConfig();

    expect(resolved.staleness.peers).toBe(parseDuration("3d"));
    expect(resolved.maxCacheAge).toBe(parseDuration("14d"));
    expect(resolved.staleness.dialogs).toBe(defaults.staleness.dialogs);
    expect(resolved.backgroundRefresh).toBe(defaults.backgroundRefresh);
  });

  it("throws on invalid values in strict mode", async () => {
    const path = getConfigPath(dataDir);
    await Bun.write(
      path,
      JSON.stringify(
        {
          cache: {
            staleness: {
              peers: "oops",
            },
          },
        },
        null,
        2,
      ),
    );

    await expect(loadConfig({ dataDir, strict: true })).rejects.toThrow(
      "Config file has invalid values",
    );
  });

  it("syncs active account from config", async () => {
    const { db, accountsDb } = createTestDatabase();
    const account1 = accountsDb.create({ phone: "+1111111111" });
    const account2 = accountsDb.create({ phone: "+2222222222" });

    expect(accountsDb.getActive()).toBeNull();

    await setConfigValue("activeAccount", account2.id, { dataDir });
    await syncActiveAccountFromConfig(accountsDb, { dataDir });

    const active = accountsDb.getActive();
    expect(active?.id).toBe(account2.id);
    expect(active?.id).not.toBe(account1.id);

    db.close();
  });

  describe("cache.retention", () => {
    const keys = [
      "cache.retention.apiActivity",
      "cache.retention.rateLimits",
      "cache.retention.completedJobs",
      "cache.retention.failedJobs",
    ] as const;

    it("accepts a duration and rejects 0 and garbage", () => {
      for (const key of keys) {
        expect(parseConfigValue(key, "3d")).toBe("3d");
        expect(() => parseConfigValue(key, "0s")).toThrow(ConfigError);
        expect(() => parseConfigValue(key, "abc")).toThrow(ConfigError);
      }
    });

    it("defaults to 7d, 1h, 24h and 24h", async () => {
      const { retention } = await getResolvedCacheConfig({ dataDir });

      expect(retention).toEqual({
        apiActivity: 7 * 24 * 60 * 60 * 1000,
        rateLimits: 60 * 60 * 1000,
        completedJobs: 24 * 60 * 60 * 1000,
        failedJobs: 24 * 60 * 60 * 1000,
      });
    });

    it("resolves a value config.json sets", async () => {
      await setConfigValue("cache.retention.failedJobs", "2h", { dataDir });

      const { retention } = await getResolvedCacheConfig({ dataDir });

      expect(retention.failedJobs).toBe(parseDuration("2h"));
      expect(retention.apiActivity).toBe(getDefaultRetentionConfig().apiActivity);
    });

    it("rejects 0s in config.json in strict mode", async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({ cache: { retention: { rateLimits: "0s" } } }),
      );

      await expect(getResolvedCacheConfig({ dataDir })).rejects.toThrow(ConfigError);
    });
  });

  describe("sync.pacing", () => {
    it("accepts a pace above 0 and at most 2 calls/s, and a calm interval above 0", () => {
      expect(parseConfigValue("sync.pacing.maxCallsPerSecond", "0.8")).toBe(0.8);
      expect(parseConfigValue("sync.pacing.maxCallsPerSecond", "2")).toBe(2);
      for (const bad of ["0", "-1", "2.5", "fast", ""]) {
        expect(() => parseConfigValue("sync.pacing.maxCallsPerSecond", bad)).toThrow(ConfigError);
      }
      expect(parseConfigValue("sync.pacing.calmInterval", "5s")).toBe("5s");
      expect(() => parseConfigValue("sync.pacing.calmInterval", "0s")).toThrow(ConfigError);
    });

    it("rejects a pace above 2 in config.json in strict mode", async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({ sync: { pacing: { maxCallsPerSecond: 3 } } }),
      );

      await expect(loadConfig({ dataDir, strict: true })).rejects.toThrow(
        "Config file has invalid values",
      );
    });
  });

  describe("transcribe", () => {
    it("takes a non-empty string, trimmed", async () => {
      expect(parseConfigValue("transcribe.local.command", " whisper-cli ")).toBe("whisper-cli");
      expect(() => parseConfigValue("transcribe.local.model", "  ")).toThrow(ConfigError);
      await setConfigValue("transcribe.language", "ru", { dataDir });
      expect(await getConfigValue("transcribe", { dataDir })).toEqual({
        language: "ru",
      });
    });

    it("rejects a non-string or blank value in config.json in strict mode", async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({ transcribe: { local: { command: 42, model: "" } } }),
      );
      const error = await loadConfig({ dataDir, strict: true }).catch((e) => e);
      expect((error as ConfigError).issues.map((i) => i.path)).toEqual([
        "transcribe.local.command",
        "transcribe.local.model",
      ]);
    });
  });

  describe("readOnly and allowedChats", () => {
    const writeConfig = (value: unknown) =>
      Bun.write(getConfigPath(dataDir), JSON.stringify(value));

    it("parses a comma-separated chat list and rejects other entries", () => {
      expect(parseConfigValue("allowedChats", "@team_chat, -1001234567890,me")).toEqual([
        "@team_chat",
        "-1001234567890",
        "me",
      ]);
      expect(parseConfigValue("allowedChats", "")).toEqual([]);
      expect(parseConfigValue("readOnly", "true")).toBe(true);
      for (const bad of ["team chat", "+15550000000", "0", "@", "me,,@a"]) {
        expect(() => parseConfigValue("allowedChats", bad)).toThrow(ConfigError);
      }
    });

    it("rejects a bad readOnly or allowedChats in config.json in strict mode", async () => {
      await writeConfig({ readOnly: "yes", allowedChats: ["@ok", 12.5] });
      const error = await loadConfig({ dataDir, strict: true }).catch((e) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues.map((i) => i.path)).toEqual([
        "readOnly",
        "allowedChats",
      ]);
    });

    it("reads both from config.json; no allowlist when the key is missing", async () => {
      expect(await loadAccessSettings({ dataDir, env: {} })).toEqual({
        readOnly: false,
        allowedChats: null,
      });
      await writeConfig({ readOnly: true, allowedChats: [" @team ", "-4242"] });
      expect(await loadAccessSettings({ dataDir, env: {} })).toEqual({
        readOnly: true,
        allowedChats: ["@team", "-4242"],
      });
    });

    it("TELEGRAM_SYNC_CLI_READ_ONLY turns read-only on, but never off", async () => {
      for (const value of ["1", "true", "yes", "ON"]) {
        const env = { TELEGRAM_SYNC_CLI_READ_ONLY: value };
        expect((await loadAccessSettings({ dataDir, env })).readOnly).toBe(true);
      }
      for (const value of ["", "0", "false", "off"]) {
        const env = { TELEGRAM_SYNC_CLI_READ_ONLY: value };
        expect((await loadAccessSettings({ dataDir, env })).readOnly).toBe(false);
      }
      await writeConfig({ readOnly: true });
      const env = { TELEGRAM_SYNC_CLI_READ_ONLY: "0" };
      expect((await loadAccessSettings({ dataDir, env })).readOnly).toBe(true);
    });

    it("TELEGRAM_SYNC_CLI_ALLOWED_CHATS replaces the list, even when empty", async () => {
      await writeConfig({ allowedChats: ["@team"] });
      const read = (value: string) =>
        loadAccessSettings({
          dataDir,
          env: { TELEGRAM_SYNC_CLI_ALLOWED_CHATS: value },
        });
      expect((await read("me, -4242")).allowedChats).toEqual(["me", "-4242"]);
      expect((await read("")).allowedChats).toEqual([]);
      await expect(read("team chat")).rejects.toBeInstanceOf(ConfigError);
    });
  });

  describe("loadDaemonConfig", () => {
    it("falls back to the defaults on invalid JSON", async () => {
      await Bun.write(getConfigPath(dataDir), "{ not json");

      const result = await loadDaemonConfig({ dataDir });

      expect(result.retention).toEqual(getDefaultRetentionConfig());
      expect(result.pacing).toEqual(DEFAULT_SYNC_PACING);
      expect(result.warning).toContain("Invalid JSON");
    });

    it("falls back to the default for a bad value", async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({ cache: { retention: { apiActivity: "x" } } }),
      );

      const result = await loadDaemonConfig({ dataDir });

      expect(result.retention).toEqual(getDefaultRetentionConfig());
      expect(result.warning).toContain("cache.retention.apiActivity");
    });

    it("reads the sync pacing, and falls back to the default for a bad value", async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({
          sync: { pacing: { maxCallsPerSecond: 0.8, calmInterval: "soon" } },
        }),
      );

      const result = await loadDaemonConfig({ dataDir });

      expect(result.pacing).toEqual({
        maxCallsPerSecond: 0.8,
        calmIntervalMs: DEFAULT_SYNC_PACING.calmIntervalMs,
      });
      expect(result.warning).toContain("sync.pacing.calmInterval");
    });

    it("reads valid values without a warning", async () => {
      await setConfigValue("cache.retention.apiActivity", "3d", { dataDir });
      await setConfigValue("sync.pacing.calmInterval", "5s", { dataDir });

      const result = await loadDaemonConfig({ dataDir });

      expect(result.retention.apiActivity).toBe(parseDuration("3d"));
      expect(result.pacing.calmIntervalMs).toBe(5000);
      expect(result.warning).toBeNull();
    });
  });
});
