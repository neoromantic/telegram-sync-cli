import { mkdirSync } from "node:fs";
import { join } from "node:path";

process.env.BUN_ENV = "test";
process.env.NODE_ENV = "test";

const testDataDir = join(process.cwd(), ".tmp", `test-data-${process.pid}`);
process.env.TELEGRAM_SYNC_CLI_DATA_DIR = testDataDir;
mkdirSync(testDataDir, { recursive: true });

process.env.TELEGRAM_SYNC_CLI_TELEMETRY = "0";

for (const key of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"] as const) {
  const stashKey = key.replace("TELEGRAM_", "TELEGRAM_TEST_");
  const real = process.env[key];
  if (real && !process.env[stashKey]) {
    process.env[stashKey] = real;
  }
}
process.env.TELEGRAM_API_ID = "12345";
process.env.TELEGRAM_API_HASH = "test-api-hash";
delete process.env.TELEGRAM_PROXY;

// WARNING: keep these imports dynamic: src/db/index opens <dataDir>/data.db as it loads.
await import("./src/types/index");
await import("./src/db/index");
await import("./src/utils/output");
await import("./src/services/telegram");
