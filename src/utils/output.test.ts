import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ErrorCodes } from "../types";
import { error, getExitCode, info, setOutputFormat, success, verbose } from "./output";

process.env.BUN_ENV = "test";

describe("Output Utilities", () => {
  let logSpy: Mock<typeof console.log>;
  let errorSpy: Mock<typeof console.error>;

  beforeEach(() => {
    logSpy = spyOn(console, "log");
    errorSpy = spyOn(console, "error");
    setOutputFormat("json");
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    setOutputFormat("json");
    delete process.env.VERBOSE;
  });

  describe("error", () => {
    it("should not output in quiet mode but still throw", () => {
      setOutputFormat("quiet");

      expect(() => error(ErrorCodes.GENERAL_ERROR, "Test")).toThrow();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("marks a rate limit and a network error retryable, others only when the caller says so", () => {
      const retryable = (...args: Parameters<typeof error>) => {
        errorSpy.mockClear();
        expect(() => error(...args)).toThrow();
        return JSON.parse(errorSpy.mock.calls[0]?.[0] as string).error.retryable;
      };

      expect(retryable(ErrorCodes.RATE_LIMITED, "Try later")).toBe(true);
      expect(retryable(ErrorCodes.NETWORK_ERROR, "Try later")).toBe(true);
      expect(retryable(ErrorCodes.TELEGRAM_ERROR, "API call failed: METHOD_INVALID")).toBe(false);
      expect(retryable(ErrorCodes.GENERAL_ERROR, "Busy", undefined, "Run it again", true)).toBe(
        true,
      );
    });
  });

  describe("getExitCode", () => {
    it("exits 2 to 6 for the documented codes and 1 for every other", () => {
      const documented: Record<string, number> = {
        AUTH_REQUIRED: 2,
        INVALID_ARGS: 3,
        NETWORK_ERROR: 4,
        TELEGRAM_ERROR: 5,
        RATE_LIMITED: 5,
        ACCOUNT_NOT_FOUND: 6,
      };
      for (const code of Object.values(ErrorCodes)) {
        expect(`${code}: ${getExitCode(code)}`).toBe(`${code}: ${documented[code] ?? 1}`);
      }
    });
  });

  describe("info", () => {
    it("writes to stderr, except in quiet mode", () => {
      setOutputFormat("pretty");
      info("Info message");
      setOutputFormat("quiet");
      info("Hidden message");

      expect(errorSpy.mock.calls).toEqual([["Info message"]]);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("verbose", () => {
    it("writes to stderr with a prefix only when VERBOSE=1", () => {
      verbose("Hidden message");
      process.env.VERBOSE = "0";
      verbose("Hidden message");
      process.env.VERBOSE = "1";
      verbose("Verbose message");

      expect(errorSpy.mock.calls).toEqual([["[verbose] Verbose message"]]);
    });
  });

  describe("snapshots", () => {
    it("should match json success output", () => {
      setOutputFormat("json");
      success({
        message: "Snapshot test",
        count: 2,
        items: ["alpha", "beta"],
      });

      expect(logSpy.mock.calls[0]?.[0]).toMatchInlineSnapshot(`
"{
  "success": true,
  "data": {
    "message": "Snapshot test",
    "count": 2,
    "items": [
      "alpha",
      "beta"
    ]
  }
}"
`);
    });
  });
});
