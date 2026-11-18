/**
 * E2E tests for output format flags
 *
 * Tests --format json/pretty/quiet behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runCliSuccess } from "./helpers/cli";
import { createTestEnvironment, type TestEnvironment } from "./helpers/setup";

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

  describe("--format json (default)", () => {
    it("should output JSON with success wrapper", async () => {
      const result = await runCliSuccess(["accounts", "list"], env.getCliOptions());

      expect(result.json).toBeDefined();
      const response = result.json as { success: boolean; data: unknown };
      expect(response.success).toBe(true);
      expect(response.data).toBeDefined();
    });

    it("should output JSON with explicit flag", async () => {
      const result = await runCliSuccess(
        ["accounts", "list", "--format", "json"],
        env.getCliOptions(),
      );

      expect(result.json).toBeDefined();
      const response = result.json as { success: boolean };
      expect(response.success).toBe(true);
    });

    it("should output JSON using -f alias", async () => {
      const result = await runCliSuccess(["accounts", "list", "-f", "json"], env.getCliOptions());

      expect(result.json).toBeDefined();
    });
  });

  describe("--format pretty", () => {
    it("should output data without success wrapper", async () => {
      const result = await runCliSuccess(
        ["accounts", "list", "--format", "pretty"],
        env.getCliOptions(),
      );

      expect(result.json).toBeDefined();
      const response = result.json as {
        accounts?: unknown[];
        success?: boolean;
      };

      // pretty format outputs data directly without success wrapper
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

      // quiet mode should have no stdout
      expect(result.stdout).toBe("");
      expect(result.json).toBeUndefined();
    });

    it("should output nothing with --quiet flag", async () => {
      const result = await runCliSuccess(["accounts", "list", "--quiet"], env.getCliOptions());

      expect(result.stdout).toBe("");
      expect(result.json).toBeUndefined();
    });
  });

  describe("format flag position", () => {
    it("should work with format after command", async () => {
      const result = await runCliSuccess(
        ["accounts", "list", "--format", "json"],
        env.getCliOptions(),
      );

      expect(result.json).toBeDefined();
    });
  });
});
