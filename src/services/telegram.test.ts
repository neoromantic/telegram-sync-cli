import { afterEach, describe, expect, it } from "bun:test";
import { SocksProxyTcpTransport } from "@mtcute/bun";
import { getDefaultConfig, type TelegramConfig, validateConfig } from "./telegram";

process.env.BUN_ENV = "test";

describe("Telegram Service", () => {
  describe("getDefaultConfig", () => {
    afterEach(() => {
      delete process.env.TELEGRAM_PROXY;
    });

    it("parses a SOCKS5 proxy with credentials", async () => {
      process.env.TELEGRAM_PROXY = "socks5://user:secret@127.0.0.1:1080";
      expect((await getDefaultConfig()).transport).toEqual(
        new SocksProxyTcpTransport({
          version: 5,
          host: "127.0.0.1",
          port: 1080,
          user: "user",
          password: "secret",
        }),
      );
    });
  });

  describe("validateConfig", () => {
    it("requires an API ID above 0 and an API hash", () => {
      const config = (apiId: number, apiHash: string) => {
        const result: TelegramConfig = { apiId, apiHash, logLevel: 2 };
        return result;
      };

      expect(validateConfig(config(12345, "abc123"))).toEqual({ valid: true });
      expect(validateConfig(config(0, "abc123")).error).toContain("TELEGRAM_API_ID");
      expect(validateConfig(config(-1, "abc123")).error).toContain("TELEGRAM_API_ID");
      expect(validateConfig(config(12345, "")).error).toContain("TELEGRAM_API_HASH");
    });
  });
});
