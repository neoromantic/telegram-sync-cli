/**
 * Read-only mode and the chat allowlist: every command of the tree is
 * classified, and the checks before a command refuse what they should.
 * The chat checks with a seeded cache are in access.e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { main } from "../cli";
import {
  COMMAND_ACCESS,
  checkAccess,
  guardCommands,
  isReadMethod,
  runnableCommands,
} from "../commands/access";
import { ALLOWED_CHATS_ENV, READ_ONLY_ENV } from "../config";

const PATHS = runnableCommands(main).map(({ path }) => path);

/** The code checkAccess fails with, or null when it lets the command run */
async function refusal(path: string, args: Record<string, unknown> = {}): Promise<string | null> {
  const access = COMMAND_ACCESS[path];
  if (!access) throw new Error(`tg ${path} is unclassified`);
  try {
    await checkAccess(path, access, { args });
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  // error() prints each refusal
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  delete process.env[READ_ONLY_ENV];
  delete process.env[ALLOWED_CHATS_ENV];
});

describe("COMMAND_ACCESS", () => {
  it("classifies every command of the tree, and only those", () => {
    expect(PATHS.filter((path) => !(path in COMMAND_ACCESS))).toEqual([]);
    expect(Object.keys(COMMAND_ACCESS).filter((path) => !PATHS.includes(path))).toEqual([]);
  });

  it("guardCommands refuses a tree with an unclassified command", () => {
    const tree = { subCommands: { "made-up": { run: () => {} } } };
    expect(() => guardCommands(tree)).toThrow("tg made-up has no entry");
  });

  it("names only args the command has", () => {
    for (const { path, node } of runnableCommands(main)) {
      const args = Object.keys((node as { args?: object }).args ?? {});
      for (const name of COMMAND_ACCESS[path]?.chatArgs ?? []) {
        expect(`${path} --${name}: ${args.includes(name)}`).toBe(`${path} --${name}: true`);
      }
    }
  });
});

describe("read-only mode", () => {
  it("refuses every write command of the tree and lets every other one run", async () => {
    process.env[READ_ONLY_ENV] = "1";
    const refused: string[] = [];
    for (const path of PATHS) {
      const write = COMMAND_ACCESS[path]?.write;
      // tg api: a method that is not a read
      const args = { method: "messages.sendMessage" };
      const code = await refusal(path, args);
      expect(`${path}: ${code}`).toBe(`${path}: ${write ? "READ_ONLY" : null}`);
      if (code) refused.push(path);
    }
    expect(refused).toEqual(expect.arrayContaining(["send", "api", "auth logout", "auth login"]));
  });

  it("lets everything run when it is off", async () => {
    for (const path of PATHS) {
      expect(await refusal(path, { method: "messages.sendMessage" })).toBe(null);
    }
  });

  it("splits tg api methods by the name after the namespace", async () => {
    process.env[READ_ONLY_ENV] = "1";
    for (const method of [
      "messages.getHistory",
      "account.checkUsername",
      "help.getConfig",
      "contacts.resolveUsername",
      "contacts.search",
    ]) {
      expect(isReadMethod(method)).toBe(true);
      expect(await refusal("api", { method })).toBe(null);
    }
    for (const method of [
      "messages.sendMessage",
      "messages.readHistory",
      "messages.deleteMessages",
      "account.updateProfile",
      "getHistory",
    ]) {
      expect(isReadMethod(method)).toBe(false);
      expect(await refusal("api", { method })).toBe("READ_ONLY");
    }
  });

  it("reads config.json only for the commands it can refuse", async () => {
    process.env[ALLOWED_CHATS_ENV] = "not a chat";
    expect(await refusal("status")).toBe(null);
    expect(await refusal("send", { to: "me" })).toBe("INVALID_ARGS");
  });
});

describe("allowedChats", () => {
  it("refuses tg sql and tg api, which no chat list can limit", async () => {
    process.env[ALLOWED_CHATS_ENV] = "me";
    expect(await refusal("sql", { query: "SELECT 1" })).toBe("CHAT_NOT_ALLOWED");
    expect(await refusal("api", { method: "help.getConfig" })).toBe("CHAT_NOT_ALLOWED");
  });

  it("leaves the commands that name no chat alone", async () => {
    process.env[ALLOWED_CHATS_ENV] = "";
    for (const path of PATHS) {
      const access = COMMAND_ACCESS[path];
      if (access?.chatArgs || access?.unscopable) continue;
      expect(await refusal(path)).toBe(null);
    }
  });
});
