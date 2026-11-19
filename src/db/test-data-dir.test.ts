import { describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getDataDir } from "./index";

describe("test data dir", () => {
  it("is a temp dir, never the real one", () => {
    expect(getDataDir()).toBe(process.env.TELEGRAM_SYNC_CLI_DATA_DIR!);
    expect(getDataDir()).toStartWith(join(tmpdir(), "tg-test-data-"));
    expect(getDataDir()).not.toBe(join(homedir(), ".telegram-sync-cli"));
  });
});
