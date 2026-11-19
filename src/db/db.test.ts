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

  it("merges an account into another all at once or not at all", () => {
    const from = accountsDb.create({ phone: "+15550000001" });
    const into = accountsDb.create({ phone: "user:4242", user_id: 4242 });
    accountsDb.create({ phone: "+15550000003" });

    expect(() => accountsDb.merge(from.id, into.id, { phone: "+15550000003" })).toThrow();
    expect(accountsDb.getAll().map((account) => account.phone)).toEqual([
      "+15550000001",
      "user:4242",
      "+15550000003",
    ]);

    accountsDb.merge(from.id, into.id, { phone: "+15550000001" });
    expect(accountsDb.getAll()).toMatchObject([
      { id: into.id, phone: "+15550000001", user_id: 4242 },
      { phone: "+15550000003" },
    ]);
  });
});
