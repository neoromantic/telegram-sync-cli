import { describe, expect, it } from "bun:test";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from "../daemon/types";

describe("DEFAULT_SHUTDOWN_TIMEOUT_MS", () => {
  it("is set to 30 seconds", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(30000);
  });
});

describe("shutdown timeout behavior", () => {
  it("Promise.race resolves when cleanup completes before timeout", async () => {
    const cleanupWork = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "cleanup done";
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Shutdown timeout exceeded"));
      }, 100);
    });

    const result = await Promise.race([cleanupWork(), timeoutPromise]);
    expect(result).toBe("cleanup done");
  });

  it("Promise.race rejects when timeout occurs before cleanup", async () => {
    const cleanupWork = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "cleanup done";
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Shutdown timeout exceeded"));
      }, 50);
    });

    let error: Error | null = null;
    try {
      await Promise.race([cleanupWork(), timeoutPromise]);
    } catch (err) {
      error = err as Error;
    }

    expect(error).not.toBeNull();
    expect(error?.message).toBe("Shutdown timeout exceeded");
  });

  it("can identify timeout error by message", () => {
    const timeoutError = new Error("Shutdown timeout exceeded");
    expect(
      timeoutError instanceof Error && timeoutError.message === "Shutdown timeout exceeded",
    ).toBe(true);
  });
});
