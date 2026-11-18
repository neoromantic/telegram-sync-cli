import { describe, expect, it, mock } from "bun:test";

const questionMock = mock(async (_message: string) => "  secret  ");
const closeMock = mock(() => {});

mock.module("node:readline/promises", () => ({
  createInterface: mock(() => ({
    question: questionMock,
    close: closeMock,
  })),
}));

describe("promptPassword", () => {
  it("falls back to prompt when stdin is not a TTY", async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });

    const { promptPassword } = await import("./auth");

    const result = await promptPassword("Password: ");

    expect(result).toBe("secret");
    expect(questionMock).toHaveBeenCalledWith("Password: ");
    expect(closeMock).toHaveBeenCalled();

    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });
});
