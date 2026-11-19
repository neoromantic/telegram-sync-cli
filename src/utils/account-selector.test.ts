import { describe, expect, it } from "bun:test";

import { createTestDatabase } from "../db";
import { ErrorCodes } from "../types";
import { resolveAccountSelector } from "./account-selector";

process.env.BUN_ENV = "test";

describe("resolveAccountSelector", () => {
  it("resolves an account ID, an @username in any case and a label", () => {
    const { accountsDb } = createTestDatabase();
    accountsDb.create({ phone: "+1111111111" });
    const named = accountsDb.create({
      phone: "+2222222222",
      username: "TestUser",
    });
    const labelled = accountsDb.create({
      phone: "+3333333333",
      label: "Work",
    });

    expect(resolveAccountSelector("1", accountsDb)).toBe(1);
    expect(resolveAccountSelector("@testuser", accountsDb)).toBe(named.id);
    expect(resolveAccountSelector("Work", accountsDb)).toBe(labelled.id);
  });

  it("throws when label matches multiple accounts", () => {
    const { accountsDb } = createTestDatabase();
    accountsDb.create({ phone: "+1111111111", label: "Work" });
    accountsDb.create({ phone: "+2222222222", label: "Work" });

    expect(() => resolveAccountSelector("Work", accountsDb)).toThrow(
      "Multiple accounts match label",
    );
  });

  it("throws when selector does not match any account", () => {
    const { accountsDb } = createTestDatabase();

    try {
      resolveAccountSelector("Missing", accountsDb);
      throw new Error("Expected error");
    } catch (err) {
      const typed = err as Error & { code?: string; suggestion?: string };
      expect(typed.code).toBe(ErrorCodes.ACCOUNT_NOT_FOUND);
      expect(typed.suggestion).toBe(
        "Run tg accounts list to see the accounts, then pass an ID, @username or label to --account",
      );
    }
  });
});
