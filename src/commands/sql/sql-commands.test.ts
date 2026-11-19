import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import type { ErrorCode } from "../../types";
import { ErrorCodes } from "../../types";
import { setOutputFormat } from "../../utils/output";
import { useTestDataDir } from "../../test/accounts.test-utils";

type CommandRun = (input: { args: Record<string, unknown> }) => Promise<void>;

async function expectCommandError(run: Promise<unknown>, code: ErrorCode) {
  try {
    await run;
  } catch (err) {
    expect((err as { code?: ErrorCode }).code).toBe(code);
    return;
  }
  throw new Error("Expected command to throw");
}

describe("SQL Commands", () => {
  let logSpy: Mock<typeof console.log>;

  useTestDataDir();

  beforeEach(() => {
    logSpy = spyOn(console, "log");
    setOutputFormat("json");
  });

  afterEach(() => {
    logSpy.mockRestore();
    setOutputFormat("json");
  });

  describe("sqlQueryCommand", () => {
    it("rejects missing query", async () => {
      const { sqlQueryCommand } = await import("./query");
      const run = sqlQueryCommand.run as CommandRun;
      await expectCommandError(run({ args: { _: [] } }), ErrorCodes.INVALID_ARGS);
    });

    it("rejects invalid limit", async () => {
      const { sqlQueryCommand } = await import("./query");
      const run = sqlQueryCommand.run as CommandRun;
      await expectCommandError(
        run({
          args: { query: "SELECT 1", output: "json", limit: "-1", _: [] },
        }),
        ErrorCodes.INVALID_ARGS,
      );
    });

    it("reports syntax errors", async () => {
      const { sqlQueryCommand } = await import("./query");
      const run = sqlQueryCommand.run as CommandRun;
      await expectCommandError(
        run({
          args: {
            query: "SELECT * FORM users_cache",
            output: "json",
            _: [],
          },
        }),
        ErrorCodes.SQL_SYNTAX_ERROR,
      );
    });

    it("reports missing tables", async () => {
      const { sqlQueryCommand } = await import("./query");
      const run = sqlQueryCommand.run as CommandRun;
      await expectCommandError(
        run({
          args: {
            query: "SELECT * FROM missing_table",
            output: "json",
            _: [],
          },
        }),
        ErrorCodes.SQL_TABLE_NOT_FOUND,
      );
    });
  });

  describe("printSchemaCommand", () => {
    it("describes the retry columns of sync_jobs", async () => {
      const { printSchemaCommand } = await import("./print-schema");
      const run = printSchemaCommand.run as CommandRun;

      await run({
        args: { table: "sync_jobs", format: "json", _: [] },
      });

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      const columns = Object.fromEntries(
        (parsed.data.columns as Array<{ name: string }>).map((col) => [col.name, col]),
      );
      expect(columns.attempts).toMatchObject({
        type: "INTEGER",
        nullable: false,
        defaultValue: "0",
        description: expect.stringContaining("FLOOD_WAIT does not count"),
      });
      expect(columns.next_run_at).toMatchObject({
        type: "INTEGER",
        defaultValue: "0",
        semanticType: "timestamp",
        description: expect.stringContaining("0 means now"),
      });
    });

    it("rejects unknown table", async () => {
      const { printSchemaCommand } = await import("./print-schema");
      const run = printSchemaCommand.run as CommandRun;
      await expectCommandError(
        run({
          args: { table: "unknown_table", output: "json", _: [] },
        }),
        ErrorCodes.SQL_TABLE_NOT_FOUND,
      );
    });

    it("prints JSON schema for all tables when no table specified", async () => {
      const { printSchemaCommand } = await import("./print-schema");
      const run = printSchemaCommand.run as CommandRun;

      await run({
        args: { output: "json", _: [] },
      });

      const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
      expect(parsed.success).toBe(true);
      expect(parsed.data.version).toBeGreaterThan(0);
      expect(Array.isArray(parsed.data.tables)).toBe(true);
      expect(parsed.data.tables.length).toBeGreaterThan(0);
      const firstTable = parsed.data.tables[0];
      expect(firstTable).toHaveProperty("name");
      expect(firstTable).toHaveProperty("description");
      expect(firstTable).toHaveProperty("primaryKey");
      expect(firstTable).toHaveProperty("columnCount");
    });
  });
});
