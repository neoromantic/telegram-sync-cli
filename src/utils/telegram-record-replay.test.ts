import { describe, expect, it, mock } from "bun:test";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramClient } from "@mtcute/bun";

import { dehydrate, rehydrate, wrapClientCallWithRecordReplay } from "./telegram-record-replay";

function listJsonFiles(dir: string) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    } else if (entry.isSymbolicLink()) {
      const stats = statSync(fullPath, { throwIfNoEntry: false });
      if (stats?.isFile() && entry.name.endsWith(".json")) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

describe("telegram record/replay utilities", () => {
  it("roundtrips BigInt and bytes through dehydrate/rehydrate", () => {
    const payload = {
      id: 42n,
      bytes: new Uint8Array([1, 2, 3, 4]),
      nested: {
        when: new Date("2026-01-01T00:00:00.000Z"),
      },
    };

    const dehydrated = dehydrate(payload);
    const hydrated = rehydrate(dehydrated) as typeof payload;

    expect(typeof hydrated.id).toBe("bigint");
    expect(hydrated.id).toBe(42n);
    expect(hydrated.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(hydrated.bytes)).toEqual([1, 2, 3, 4]);
    expect(hydrated.nested.when).toBeInstanceOf(Date);
    expect(hydrated.nested.when.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("records and replays fixtures without hitting the network", async () => {
    const fixturesDir = join(
      tmpdir(),
      `tgcli-fixtures-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(fixturesDir, { recursive: true });

    try {
      const recordCall = mock(async () => ({ ok: true, token: 7n }));
      const recordClient = { call: recordCall } as unknown as TelegramClient;
      const wrappedRecord = wrapClientCallWithRecordReplay(recordClient, {
        accountId: 7,
        config: { mode: "record", fixturesDir },
      });

      const recordRequest = {
        _: "test.method",
        value: 1,
      } as unknown as Parameters<TelegramClient["call"]>[0];
      const recordResult = await wrappedRecord.call(recordRequest);
      expect(recordResult).toEqual({ ok: true, token: 7n });
      expect(recordCall).toHaveBeenCalled();

      const replayCall = mock(async () => ({ ok: false }));
      const replayClient = { call: replayCall } as unknown as TelegramClient;
      const wrappedReplay = wrapClientCallWithRecordReplay(replayClient, {
        accountId: 7,
        config: { mode: "replay", fixturesDir },
      });

      const replayRequest = {
        _: "test.method",
        value: 1,
      } as unknown as Parameters<TelegramClient["call"]>[0];
      const replayResult = await wrappedReplay.call(replayRequest);
      expect(replayResult).toEqual({ ok: true, token: 7n });
      expect(replayCall).not.toHaveBeenCalled();

      const fixtures = listJsonFiles(fixturesDir);
      expect(fixtures.length).toBeGreaterThan(0);
    } finally {
      rmSync(fixturesDir, { recursive: true, force: true });
    }
  });
});
