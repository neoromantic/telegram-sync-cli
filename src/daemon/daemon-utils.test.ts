import { describe, expect, it } from "bun:test";
import { formatError, getErrorMessage } from "./daemon-utils";

class CircularRef {
  self: CircularRef;

  constructor() {
    this.self = this;
  }
}

describe("daemon-utils", () => {
  it("formatError handles Error instances", () => {
    const err = new Error("boom");
    const formatted = formatError(err);

    expect(formatted).toContain("boom");
  });

  it("formatError handles strings and objects", () => {
    expect(formatError("plain")).toBe("plain");
    expect(formatError({ ok: true })).toContain("ok");
  });

  it("formatError falls back for circular objects", () => {
    const formatted = formatError(new CircularRef());

    expect(formatted).toBe("[object Object]");
  });

  it("getErrorMessage normalizes error inputs", () => {
    expect(getErrorMessage(new Error("nope"))).toBe("nope");
    expect(getErrorMessage("simple")).toBe("simple");
    expect(getErrorMessage(123)).toBe("123");
  });
});
