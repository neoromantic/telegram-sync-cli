import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { main } from "../cli";
import {
  COMMAND_ACCESS,
  checkAccess,
  guardCommands,
  isReadMethod,
  runnableCommands,
} from "./access";
import { ALLOWED_CHATS_ENV } from "../config";

const PATHS = runnableCommands(main).map(({ path }) => path);

async function refusal(path: string, args: Record<string, unknown> = {}) {
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
  errorSpy = spyOn(console, "error");
});

afterEach(() => {
  errorSpy.mockRestore();
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
});

describe("read-only mode", () => {
  it("splits tg api methods by the name after the namespace", () => {
    for (const method of [
      "messages.getHistory",
      "account.checkUsername",
      "help.getConfig",
      "contacts.resolveUsername",
      "contacts.search",
    ]) {
      expect(isReadMethod(method)).toBe(true);
    }
    for (const method of [
      "messages.sendMessage",
      "messages.readHistory",
      "messages.deleteMessages",
      "account.updateProfile",
      "getHistory",
    ]) {
      expect(isReadMethod(method)).toBe(false);
    }
  });

  it("reads config.json only for the commands it can refuse", async () => {
    process.env[ALLOWED_CHATS_ENV] = "not a chat";
    expect(await refusal("status")).toBe(null);
    expect(await refusal("send", { to: "me" })).toBe("INVALID_ARGS");
  });
});

describe("allowedChats", () => {
  it("leaves the commands that name no chat alone", async () => {
    process.env[ALLOWED_CHATS_ENV] = "";
    for (const path of PATHS) {
      const access = COMMAND_ACCESS[path];
      if (access?.chatArgs || access?.unscopable) continue;
      expect(await refusal(path)).toBe(null);
    }
  });
});
