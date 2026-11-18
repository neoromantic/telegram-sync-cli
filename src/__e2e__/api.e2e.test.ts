import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createUsersCache } from "../db/users-cache";
import { type CliOptions, runCli } from "./helpers/cli";
import {
  FAKE_CLIENT_CLI,
  FAKE_CLIENT_DESTROYED,
  FAKE_CONFIG,
  FAKE_FLOOD_METHOD,
  FAKE_FLOOD_SECONDS,
  FAKE_INTERNAL_ERRORS,
} from "./helpers/fake-client-cli";
import { createTestEnvironment, type TestEnvironment } from "./helpers/setup";

const HANG_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 15_000;

describe("E2E: tg api closes the client and exits", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("api");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", is_active: true }]);
  });

  afterEach(() => {
    env.cleanup();
  });

  function runApi(args: string[]) {
    const options: CliOptions = {
      ...env.getCliOptions(),
      entry: FAKE_CLIENT_CLI,
      timeout: HANG_TIMEOUT_MS,
    };
    return runCli(["api", ...args], options);
  }

  it(
    "--raw prints the bare result, closes the client and exits 0",
    async () => {
      const result = await runApi(["help.getConfig", "--raw"]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(FAKE_CONFIG);
      expect(result.stderr).toContain(FAKE_CLIENT_DESTROYED);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "without --raw prints the success wrapper, closes the client and exits 0",
    async () => {
      const result = await runApi(["help.getConfig"]);

      expect(result.exitCode).toBe(0);
      expect(result.json).toEqual({
        success: true,
        data: { method: "help.getConfig", result: FAKE_CONFIG },
      });
      expect(result.stderr).toContain(FAKE_CLIENT_DESTROYED);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a failed call closes the client and exits with TELEGRAM_ERROR",
    async () => {
      const result = await runApi(["help.getNothing", "--raw"]);

      expect(result.exitCode).toBe(5);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(FAKE_CLIENT_DESTROYED);
      expect(result.stderr).toContain('"code": "TELEGRAM_ERROR"');
      expect(result.stderr).toContain('"telegramErrorCode": 400');
    },
    TEST_TIMEOUT_MS,
  );
});

describe("E2E: errors say whether a retry can work", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("api-errors");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", is_active: true }]);
  });

  afterEach(() => {
    env.cleanup();
  });

  function run(args: string[]) {
    return runCli(args, {
      ...env.getCliOptions(),
      entry: FAKE_CLIENT_CLI,
      timeout: HANG_TIMEOUT_MS,
    });
  }

  function errorOf(stderr: string) {
    const json = stderr.slice(stderr.indexOf("{"), stderr.lastIndexOf("}") + 1);
    return (JSON.parse(json) as { error: Record<string, unknown> }).error;
  }

  const RATE_LIMITED = {
    code: "RATE_LIMITED",
    message: `Rate limited for ${FAKE_FLOOD_METHOD}. Wait ${FAKE_FLOOD_SECONDS}s before retrying.`,
    details: { method: FAKE_FLOOD_METHOD, wait_seconds: FAKE_FLOOD_SECONDS },
    suggestion: `Wait ${FAKE_FLOOD_SECONDS}s, then run the same command again`,
    retryable: true,
  };

  it(
    "a FLOOD_WAIT is RATE_LIMITED, retryable after details.wait_seconds, also while it runs",
    async () => {
      const first = await run(["api", FAKE_FLOOD_METHOD]);
      expect(first.exitCode).toBe(5);
      expect(errorOf(first.stderr)).toEqual(RATE_LIMITED);

      const second = await run(["api", FAKE_FLOOD_METHOD]);
      expect(second.exitCode).toBe(5);
      expect(errorOf(second.stderr)).toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
      });
      const wait = (errorOf(second.stderr).details as { wait_seconds: number }).wait_seconds;
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(FAKE_FLOOD_SECONDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a refused call is not retryable",
    async () => {
      const result = await run(["api", "help.getNothing"]);

      expect(result.exitCode).toBe(5);
      expect(errorOf(result.stderr)).toEqual({
        code: "TELEGRAM_ERROR",
        message: "API call failed: METHOD_INVALID",
        details: { method: "help.getNothing", telegramErrorCode: 400 },
        retryable: false,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it.each(Object.entries(FAKE_INTERNAL_ERRORS))(
    "a failure on Telegram's side (%s) is retryable",
    async (method, [telegramErrorCode, text]) => {
      const result = await run(["api", method]);

      expect(result.exitCode).toBe(5);
      expect(errorOf(result.stderr)).toEqual({
        code: "TELEGRAM_ERROR",
        message: `API call failed: Telegram API error ${telegramErrorCode}: ${text}`,
        details: { method, telegramErrorCode },
        retryable: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a user ID Telegram refuses suggests sending to the @username or +phone once",
    async () => {
      const result = await run(["send", "--to", "123456", "--message", "Hi"]);

      expect(result.exitCode).toBe(5);
      expect(errorOf(result.stderr)).toEqual({
        code: "TELEGRAM_ERROR",
        message:
          "Invalid recipient: 123456. Make sure the user/chat exists and you have access to it.",
        suggestion:
          "Send to the user's @username or +phone once: tg caches the user, and its ID works after that",
        retryable: false,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a @username Telegram refuses gets no suggestion",
    async () => {
      createUsersCache(env.openCacheDb(1)).upsert({
        user_id: "1001",
        username: "alice",
        first_name: "Alice",
        access_hash: "777",
        fetched_at: Date.now(),
        raw_json: "{}",
      });
      const result = await run(["send", "--to", "@alice", "--message", "Hi"]);

      expect(result.exitCode).toBe(5);
      const reported = errorOf(result.stderr);
      expect(reported.code).toBe("TELEGRAM_ERROR");
      expect(reported.suggestion).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});
