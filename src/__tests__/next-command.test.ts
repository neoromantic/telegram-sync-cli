import { describe, expect, it } from "bun:test";
import { $ } from "bun";
import type { ArgsDef } from "citty";

import { listChatsArgs } from "../commands/chats/list";
import { listContactsArgs } from "../commands/contacts";
import { shellQuote, tgCommand } from "../commands/next";

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
  it.each([
    "hello",
    "hello world",
    "it's",
    '"exact phrase"',
    "$HOME `id` $(id)",
    "-1001234567890",
    "--chat",
    "a\nb",
    "",
    "*",
    "back\\slash",
    "квартир*",
  ])("survives a POSIX shell: %p", async (value) => {
    expect(await shellWords(shellQuote(value))).toEqual([value]);
  });

  it("leaves plain words unquoted", () => {
    expect(shellQuote("@teamchat")).toBe("@teamchat");
    expect(shellQuote("-1001234567890")).toBe("-1001234567890");
    expect(shellQuote("7d")).toBe("7d");
  });
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

  it("ignores parsed values the command does not declare", () => {
    expect(
      tgCommand("messages search", defs, {
        query: "a",
        _: [],
        "include-deleted": true,
        format: "pretty",
      }),
    ).toBe("tg messages search --query=a");
  });

  it("quotes values so the shell passes each flag as one word", async () => {
    const command = tgCommand("messages search", defs, {
      query: `--it's $5 "today"`,
      account: "Work Phone",
    });
    expect(command).toBe(
      `tg messages search --query='--it'\\''s $5 "today"' --account='Work Phone'`,
    );
    expect(await shellWords(command)).toEqual([
      "tg",
      "messages",
      "search",
      `--query=--it's $5 "today"`,
      "--account=Work Phone",
    ]);
  });

  it("keeps --fresh, filters and the account on the next page of chats and contacts", () => {
    const values = {
      limit: 2,
      offset: 2,
      type: "group",
      fresh: true,
      account: "Work Phone",
    };
    expect(tgCommand("chats list", listChatsArgs, values)).toBe(
      "tg chats list --limit=2 --offset=2 --type=group --account='Work Phone' --fresh",
    );
    expect(tgCommand("contacts list", listContactsArgs, values)).toBe(
      "tg contacts list --limit=2 --offset=2 --account='Work Phone' --fresh",
    );
  });

  it("refuses a command that read-only mode would refuse", () => {
    expect(() => tgCommand("send", {}, {})).toThrow(/can't be suggested/);
    expect(() => tgCommand("no such", {}, {})).toThrow(/can't be suggested/);
  });
});
