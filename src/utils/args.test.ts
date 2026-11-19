import { describe, expect, it } from "bun:test";
import { type ArgsDef, parseArgs } from "citty";

import { main } from "../cli";
import { runnableCommands } from "../commands/access";
import { apiCommand } from "../commands/api";
import { sendCommand } from "../commands/send";
import { flagValues, spacedFlagValues, undeclaredArg } from "./args";

function spaced(...argv: string[]) {
  const args = parseArgs(argv, apiCommand.args as ArgsDef) as Record<string, unknown>;
  return Object.fromEntries(spacedFlagValues(argv, args.method as string, args));
}

describe("spacedFlagValues", () => {
  it("pairs a flag with the value after it", () => {
    expect(spaced("account.checkUsername", "--username", "myuser")).toEqual({
      username: "myuser",
    });
  });

  it("pairs a dotted name", () => {
    expect(spaced("messages.getHistory", "--peer._", "inputPeerSelf")).toEqual({
      "peer._": "inputPeerSelf",
    });
  });

  it.each([
    ["--username=myuser", ["--username=myuser"]],
    ["--no-silent x", ["--no-silent", "x"]],
    ["--account 2", ["--account", "2"]],
    ["-a 2", ["-a", "2"]],
    ["--json x", ["--json", "x"]],
    ["-j x", ["-j", "x"]],
    ["-r", ["-r"]],
  ])("leaves %s alone", (_form, argv) => {
    expect(spaced("messages.sendMessage", ...argv)).toEqual({});
  });

  it("keeps a flag followed by another option as true", () => {
    expect(spaced("messages.getDialogs", "--excludePinned", "--limit", "10")).toEqual({
      limit: "10",
    });
  });

  it("keeps a flag at the end as true", () => {
    expect(spaced("messages.sendMessage", "--silent")).toEqual({});
  });

  it.each(["-10", "-1.5"])("takes the negative number %s as a value", (n) => {
    expect(spaced("messages.getHistory", "--addOffset", n)).toEqual({
      addOffset: n,
    });
  });

  it("does not take another value that starts with -", () => {
    expect(spaced("messages.sendMessage", "--message", "-hi")).toEqual({});
  });

  it("pairs only flags after the method", () => {
    expect(spaced("--silent", "messages.sendMessage", "--message", "hi")).toEqual({
      message: "hi",
    });
  });

  it("stops at --", () => {
    expect(spaced("account.checkUsername", "--username", "--", "--username", "myuser")).toEqual({});
  });
});

const SEND_ARGS = sendCommand.args as ArgsDef;

describe("flagValues", () => {
  it("collects --name value and --name=value", () => {
    expect(
      flagValues(
        ["--to", "me", "--file", "a.pdf", "--caption", "x", "--file=b.png"],
        "file",
        SEND_ARGS,
      ),
    ).toEqual(["a.pdf", "b.png"]);
  });

  it("stops at a bare --", () => {
    expect(flagValues(["--file", "a.pdf", "--", "--file", "b"], "file", SEND_ARGS)).toEqual([
      "a.pdf",
    ]);
  });

  it("takes the next argument as the value, and counts a flag without one", () => {
    expect(flagValues(["--file", "--file"], "file", SEND_ARGS)).toEqual(["--file"]);
    expect(flagValues(["--to", "me", "--file"], "file", SEND_ARGS)).toEqual([""]);
  });

  it("skips the value of another string flag, as citty does", () => {
    expect(flagValues(["--caption", "--file=a.pdf", "-m", "--file"], "file", SEND_ARGS)).toEqual(
      [],
    );
    expect(flagValues(["--caption=--file=a.pdf", "--file", "b.png"], "file", SEND_ARGS)).toEqual([
      "b.png",
    ]);
  });

  it("ignores other flags with the same prefix", () => {
    expect(flagValues(["--files", "a", "--file-name=b"], "file", SEND_ARGS)).toEqual([]);
  });

  it("finds the values citty drops: it keeps only the last one", () => {
    const argv = ["--to", "me", "--file", "a.pdf", "--file", "b.png"];
    const args = parseArgs(argv, sendCommand.args as ArgsDef) as Record<string, unknown>;
    expect(args.file).toBe("b.png");
    expect(flagValues(argv, "file", SEND_ARGS)).toEqual(["a.pdf", "b.png"]);
  });
});

describe("undeclaredArg", () => {
  const known = (path: string) => {
    const node = runnableCommands(main).find((command) => command.path === path)?.node;
    return { ...(main.args as ArgsDef), ...(node?.args as ArgsDef) };
  };
  const send = (...argv: string[]) =>
    undeclaredArg(["--to", "me", "-m", "hi", ...argv], known("send"));

  it("names a flag the command doesn't declare, which citty would take as true", () => {
    expect(send("--acount", "2")).toBe("Unknown option --acount");
    expect(send("-x")).toBe("Unknown option -x");
  });

  it("refuses a value after a boolean flag, which citty would drop", () => {
    expect(send("--silent", "false")).toBe(
      "--silent takes no value: pass --silent or --no-silent, not --silent false",
    );
    expect(send("stray")).toBe("Unexpected argument stray");
  });

  it("takes declared flags, aliases, --no-, =values, global flags and negative IDs", () => {
    expect(
      undeclaredArg(
        ["--to", "-1001234567890", "-m", "-5", "--silent=false", "--no-markdown", "-f", "pretty"],
        known("send"),
      ),
    ).toBeNull();
    expect(send("-vq", "--account=2", "--", "--anything")).toBeNull();
    expect(undeclaredArg(["-1001234567890", "--auto"], known("chats sync"))).toBeNull();
    expect(undeclaredArg(["@team", "@club"], known("chats sync"))).toBe(
      "Unexpected argument @club",
    );
  });
});
