import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { ArgsDef } from "citty";

import { parseTimeWindow, parseTypeArg } from "./filters";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const DEFS = {
  query: { type: "string" },
  type: { type: "string" },
} satisfies ArgsDef;

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  errorSpy = spyOn(console, "error");
});

afterEach(() => {
  errorSpy.mockRestore();
});

function codeOf(run: () => unknown) {
  try {
    run();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  throw new Error("expected a failure");
}

describe("parseTypeArg", () => {
  it("is undefined without --type", () => {
    expect(parseTypeArg(["--chat", "@alice"], DEFS)).toBeUndefined();
  });

  it("reads comma-separated and repeated values, once each", () => {
    expect(parseTypeArg(["--type", "voice,round"], DEFS)).toEqual(["voice", "round"]);
    expect(parseTypeArg(["--type", "voice", "--type=round", "--type", " voice "], DEFS)).toEqual([
      "voice",
      "round",
    ]);
  });

  it("reads --type=voice given as the value of --query as the query", () => {
    expect(parseTypeArg(["--query", "--type=voice"], DEFS)).toBeUndefined();
    expect(parseTypeArg(["--query=--type=voice"], DEFS)).toBeUndefined();
    expect(parseTypeArg(["--query", "--type=voice", "--type", "round"], DEFS)).toEqual(["round"]);
  });

  it.each(["nope", "voice,", "Voice", ""])("rejects %p", (value) => {
    expect(codeOf(() => parseTypeArg(["--type", value], DEFS))).toBe("INVALID_ARGS");
  });
});

describe("parseTimeWindow", () => {
  it("reads the forms tg messages search takes", () => {
    expect(parseTimeWindow({}, NOW)).toEqual({
      since: undefined,
      until: undefined,
    });
    expect(parseTimeWindow({ since: "7d", until: "24h" }, NOW)).toEqual({
      since: NOW / 1000 - 7 * 86_400,
      until: NOW / 1000 - 86_400,
    });
    expect(parseTimeWindow({ since: "2026-11-01T00:00Z" }, NOW).since).toBe(
      Date.UTC(2026, 10, 1) / 1000,
    );
  });

  it("rejects a value of no accepted form", () => {
    expect(codeOf(() => parseTimeWindow({ since: "monday" }, NOW))).toBe("INVALID_ARGS");
  });

  it("rejects --since that is not earlier than --until", () => {
    expect(codeOf(() => parseTimeWindow({ since: "1d", until: "2d" }, NOW))).toBe("INVALID_ARGS");
  });
});
