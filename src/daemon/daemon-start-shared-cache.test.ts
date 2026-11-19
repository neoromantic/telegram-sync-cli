import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getAccountCachePath, getLegacyCachePath } from "../db";
import { useTestDataDir } from "../test/accounts.test-utils";
import { fakeTelegramClients } from "../test/fake-telegram-client.test-utils";
import { seedInChild } from "../test/seed-in-child.test-utils";
import { holdOpen } from "../test/shared-cache.test-utils";

const { created: connected } = fakeTelegramClients();

const { createDaemon } = await import("./daemon");
const { DaemonExitCode } = await import("./types");

const tempDir = join(process.cwd(), ".tmp", `daemon-start-shared-cache-${process.pid}`);
const pidPath = join(tempDir, "daemon.pid");

useTestDataDir();

beforeEach(() => {
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("daemon start with the shared cache of an older version", () => {
  it("stops when that cache is still open", async () => {
    seedInChild(getLegacyCachePath(), "legacySharedCache");
    const holder = holdOpen(getLegacyCachePath());
    await holder.ready();

    try {
      const daemon = createDaemon({ pidPath });

      expect(await daemon.start()).toBe(DaemonExitCode.Error);
    } finally {
      await holder.release();
    }

    expect(connected).toEqual([]);
    expect(existsSync(getAccountCachePath(1))).toBe(false);
  });
});
