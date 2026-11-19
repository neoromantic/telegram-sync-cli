import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runCliSuccess } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

describe("E2E: Output Formats", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("format");
    env.initDatabase();
    env.seedAccounts([{ phone: "+1111111111", name: "Test Account", is_active: true }]);
  });

  afterEach(() => {
    env.cleanup();
  });

  describe("--format pretty", () => {
    it("should output data without success wrapper", async () => {
      const result = await runCliSuccess(["accounts", "list", "-f", "pretty"], env.getCliOptions());

      const response = result.json as {
        accounts?: unknown[];
        success?: boolean;
      };

      expect(response.accounts).toBeDefined();
      expect(response.success).toBeUndefined();
    });
  });

  describe("--format quiet", () => {
    it("should output nothing on success", async () => {
      const result = await runCliSuccess(
        ["accounts", "list", "--format", "quiet"],
        env.getCliOptions(),
      );

      expect(result.stdout).toBe("");
    });

    it("should output nothing with --quiet flag", async () => {
      const result = await runCliSuccess(["accounts", "list", "--quiet"], env.getCliOptions());

      expect(result.stdout).toBe("");
    });
  });
});
