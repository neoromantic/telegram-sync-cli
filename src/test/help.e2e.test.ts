import { describe, expect, it } from "bun:test";
import { runCli } from "./cli.test-utils";

describe("E2E: Help Commands", () => {
  it("should show help when no command given", async () => {
    const result = await runCli([]);

    expect(result.stdout).toContain("USAGE");
  });

  it("should fail for nonexistent command", async () => {
    const result = await runCli(["nonexistent"]);

    expect(result.exitCode).not.toBe(0);
  });
});
