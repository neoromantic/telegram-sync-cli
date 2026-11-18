import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";

import { prompt, promptPassword } from "./auth";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const written = () => output.read()?.toString() ?? "";
  return { input, output, written };
}

describe("promptPassword", () => {
  it("falls back to prompt when stdin is not a TTY", async () => {
    const io = streams();

    const answer = promptPassword("Password: ", io);
    io.input.write("  secret  \n");

    expect(await answer).toBe("secret");
    expect(io.written()).toBe("Password: ");
    expect(io.input.listenerCount("data")).toBe(0);
  });
});

describe("prompt", () => {
  it("asks on the output and reads one trimmed line", async () => {
    const io = streams();

    const answer = prompt("Code: ", io);
    io.input.write(" 12345 \nleft unread\n");

    expect(await answer).toBe("12345");
    expect(io.written()).toBe("Code: ");
    expect(io.input.listenerCount("data")).toBe(0);
  });
});
