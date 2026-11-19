import { describe, expect, it } from "bun:test";
import { formatError } from "./daemon-utils";

class CircularRef {
  self: CircularRef;

  constructor() {
    this.self = this;
  }
}

describe("formatError", () => {
  it("formats a thrown value that isn't an Error without throwing itself", () => {
    expect(formatError("plain")).toBe("plain");
    expect(formatError({ ok: true })).toBe('{"ok":true}');
    expect(formatError(new CircularRef())).toBe("[object Object]");
  });
});
