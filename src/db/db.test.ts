import { beforeEach, describe, expect, it } from "bun:test";
import { type AccountsDbInterface, createTestDatabase } from "./index";

describe("accountsDb", () => {
  let accountsDb: AccountsDbInterface;

  beforeEach(() => {
    accountsDb = createTestDatabase().accountsDb;
  });

  it("creates an account with no name, no session and not active", () => {
    const account = accountsDb.create({ phone: "+15550000001" });

    expect(account).toMatchObject({
      phone: "+15550000001",
      name: null,
      session_data: "",
      is_active: 0,
    });
  });

  it("refuses a second account with the same phone", () => {
    accountsDb.create({ phone: "+15550000001" });

    expect(() => accountsDb.create({ phone: "+15550000001" })).toThrow();
  });

  it("finds an account by its username in any case, with or without @", () => {
    const account = accountsDb.create({ phone: "+15550000001", username: "TestUser" });

    expect(accountsDb.getByUsername("@testuser")?.id).toBe(account.id);
  });

  it("updates the given fields, normalizes username and label, and keeps the rest", () => {
    const account = accountsDb.create({
      phone: "+15550000001",
      name: "Original",
      session_data: "session",
    });

    expect(
      accountsDb.update(account.id, {
        phone: "+15550000002",
        name: "New Name",
        username: "@NewUser",
        label: "  Work  ",
      }),
    ).toMatchObject({
      phone: "+15550000002",
      name: "New Name",
      username: "newuser",
      label: "Work",
      session_data: "session",
    });
    expect(accountsDb.update(999, { name: "Test" })).toBeNull();
  });

  it("deletes only the given account and says whether it existed", () => {
    const first = accountsDb.create({ phone: "+15550000001" });
    const second = accountsDb.create({ phone: "+15550000002" });

    expect(accountsDb.delete(first.id)).toBe(true);
    expect(accountsDb.delete(999)).toBe(false);

    expect(accountsDb.getById(first.id)).toBeNull();
    expect(accountsDb.getById(second.id)).not.toBeNull();
  });
});
