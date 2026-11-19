import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import type { ArgsDef } from "citty";

import { shellQuote, tgCommand } from "./next";

async function shellWords(words: string) {
  const out = await $`sh -c ${`printf '%s\\0' ${words}`}`.text();
  return out.split("\0").slice(0, -1);
}

const defs = {
  query: { type: "string", required: true },
  limit: { type: "string", default: "50" },
  offset: { type: "string", default: "0" },
  chat: { type: "string" },
  includeDeleted: { type: "boolean", default: false },
  snippet: { type: "boolean", default: true },
  account: { type: "string" },
} satisfies ArgsDef;

describe("shellQuote", () => {
  it.each(["$HOME `id` $(id)", "a\nb", "", "*", "back\\slash"])(
    "survives a POSIX shell: %p",
    async (value) => {
      expect(await shellWords(shellQuote(value))).toEqual([value]);
    },
  );
});

describe("tgCommand", () => {
  it("carries every set flag and leaves defaults out", () => {
    expect(
      tgCommand("messages search", defs, {
        query: "hello",
        limit: "50",
        offset: 50,
        chat: "-1001234567890",
        includeDeleted: true,
        snippet: true,
        account: undefined,
      }),
    ).toBe("tg messages search --query=hello --offset=50 --chat=-1001234567890 --includeDeleted");
  });

  it("writes a boolean turned off against its default as --no-", () => {
    expect(tgCommand("messages search", defs, { query: "a", snippet: false })).toBe(
      "tg messages search --query=a --no-snippet",
    );
  });

  it("refuses a command that read-only mode would refuse", () => {
    expect(() => tgCommand("send", {}, {})).toThrow(/can't be suggested/);
    expect(() => tgCommand("no such", {}, {})).toThrow(/can't be suggested/);
  });
});
