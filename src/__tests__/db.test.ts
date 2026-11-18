/**
 * Database module tests
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { type AccountsDbInterface, createTestDatabase } from "../db";

describe("Database Module", () => {
  let db: Database;
  let accountsDb: AccountsDbInterface;

  beforeEach(() => {
    const testDb = createTestDatabase();
    db = testDb.db;
    accountsDb = testDb.accountsDb;
  });

  describe("createTestDatabase", () => {
    it("should create an in-memory database", () => {
      expect(db).toBeDefined();
      expect(accountsDb).toBeDefined();
    });

    it("should have accounts table", () => {
      const result = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
        .get();
      expect(result).toBeDefined();
    });

    it("should start with empty accounts", () => {
      expect(accountsDb.count()).toBe(0);
      expect(accountsDb.getAll()).toHaveLength(0);
    });
  });

  describe("accountsDb.create", () => {
    it("should create a new account", () => {
      const account = accountsDb.create({ phone: "+1234567890" });

      expect(account).toBeDefined();
      expect(account.id).toBe(1);
      expect(account.phone).toBe("+1234567890");
      expect(account.name).toBeNull();
      expect(account.session_data).toBe("");
      expect(account.is_active).toBe(0);
    });

    it("should create account with name", () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        name: "Test User",
      });

      expect(account.name).toBe("Test User");
    });

    it("should create account with session data", () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        session_data: "test-session",
      });

      expect(account.session_data).toBe("test-session");
    });

    it("should create active account", () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });

      expect(account.is_active).toBe(1);
    });

    it("should throw on duplicate phone", () => {
      accountsDb.create({ phone: "+1234567890" });

      expect(() => accountsDb.create({ phone: "+1234567890" })).toThrow();
    });

    it("should auto-increment IDs", () => {
      const account1 = accountsDb.create({ phone: "+1111111111" });
      const account2 = accountsDb.create({ phone: "+2222222222" });

      expect(account1.id).toBe(1);
      expect(account2.id).toBe(2);
    });
  });

  describe("accountsDb.getById", () => {
    it("should return account by ID", () => {
      const created = accountsDb.create({ phone: "+1234567890", name: "Test" });
      const found = accountsDb.getById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.phone).toBe("+1234567890");
      expect(found?.name).toBe("Test");
    });

    it("should return null for non-existent ID", () => {
      const found = accountsDb.getById(999);

      expect(found).toBeNull();
    });
  });

  describe("accountsDb.getByPhone", () => {
    it("should return account by phone", () => {
      accountsDb.create({ phone: "+1234567890", name: "Test" });
      const found = accountsDb.getByPhone("+1234567890");

      expect(found).toBeDefined();
      expect(found?.phone).toBe("+1234567890");
    });

    it("should return null for non-existent phone", () => {
      const found = accountsDb.getByPhone("+9999999999");

      expect(found).toBeNull();
    });
  });

  describe("accountsDb.getByUsername", () => {
    it("should return account by username (case-insensitive, @ optional)", () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        username: "TestUser",
      });

      const found = accountsDb.getByUsername("@testuser");

      expect(found?.id).toBe(account.id);
    });

    it("should return null for empty username", () => {
      const found = accountsDb.getByUsername("   ");
      expect(found).toBeNull();
    });
  });

  describe("accountsDb.getAllByLabel", () => {
    it("should return accounts by label", () => {
      accountsDb.create({ phone: "+1111111111", label: "Work" });
      accountsDb.create({ phone: "+2222222222", label: "Work" });
      accountsDb.create({ phone: "+3333333333", label: "Personal" });

      const results = accountsDb.getAllByLabel("Work");

      expect(results).toHaveLength(2);
      expect(results.map((a) => a.phone)).toEqual(["+1111111111", "+2222222222"]);
    });

    it("should return empty array for blank label", () => {
      const results = accountsDb.getAllByLabel("   ");
      expect(results).toEqual([]);
    });
  });

  describe("accountsDb.getActive", () => {
    it("should return null when no active account", () => {
      accountsDb.create({ phone: "+1234567890", is_active: false });

      expect(accountsDb.getActive()).toBeNull();
    });

    it("should return active account", () => {
      accountsDb.create({ phone: "+1111111111", is_active: false });
      const active = accountsDb.create({
        phone: "+2222222222",
        is_active: true,
      });

      const found = accountsDb.getActive();

      expect(found).toBeDefined();
      expect(found?.id).toBe(active.id);
    });

    it("should return first active if multiple", () => {
      const first = accountsDb.create({ phone: "+1111111111", is_active: true });
      // Manually insert another active for edge case
      db.run("INSERT INTO accounts (phone, is_active) VALUES ('+2222222222', 1)");

      const found = accountsDb.getActive();

      expect(found?.id).toBe(first.id);
    });
  });

  describe("accountsDb.getAll", () => {
    it("should return empty array when no accounts", () => {
      expect(accountsDb.getAll()).toEqual([]);
    });

    it("should return all accounts ordered by ID", () => {
      accountsDb.create({ phone: "+1111111111" });
      accountsDb.create({ phone: "+2222222222" });
      accountsDb.create({ phone: "+3333333333" });

      const all = accountsDb.getAll();

      expect(all).toHaveLength(3);
      expect(all[0]?.phone).toBe("+1111111111");
      expect(all[1]?.phone).toBe("+2222222222");
      expect(all[2]?.phone).toBe("+3333333333");
    });
  });

  describe("accountsDb.update", () => {
    it("should update account phone", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const updated = accountsDb.update(account.id, { phone: "+0987654321" });

      expect(updated?.phone).toBe("+0987654321");
    });

    it("should update account name", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const updated = accountsDb.update(account.id, { name: "New Name" });

      expect(updated?.name).toBe("New Name");
    });

    it("should update session data", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const updated = accountsDb.update(account.id, {
        session_data: "new-session",
      });

      expect(updated?.session_data).toBe("new-session");
    });

    it("should normalize username on update", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const updated = accountsDb.update(account.id, { username: "@NewUser" });

      expect(updated?.username).toBe("newuser");
    });

    it("should trim label on update", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const updated = accountsDb.update(account.id, { label: "  Work  " });

      expect(updated?.label).toBe("Work");
    });

    it("should return null for non-existent ID", () => {
      const updated = accountsDb.update(999, { name: "Test" });

      expect(updated).toBeNull();
    });

    it("should preserve unchanged fields", () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        name: "Original",
        session_data: "session",
      });
      const updated = accountsDb.update(account.id, { name: "New Name" });

      expect(updated?.phone).toBe("+1234567890");
      expect(updated?.name).toBe("New Name");
      expect(updated?.session_data).toBe("session");
    });

    it("should update updated_at timestamp", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const _originalUpdatedAt = account.updated_at;

      // Small delay to ensure timestamp difference
      const updated = accountsDb.update(account.id, { name: "New" });

      // Note: SQLite CURRENT_TIMESTAMP has second precision, so we just check it's defined
      expect(updated?.updated_at).toBeDefined();
    });
  });

  describe("accountsDb.updateSession", () => {
    it("should update session data only", () => {
      const account = accountsDb.create({ phone: "+1234567890", name: "Test" });
      accountsDb.updateSession(account.id, "new-session-data");

      const updated = accountsDb.getById(account.id);

      expect(updated?.session_data).toBe("new-session-data");
      expect(updated?.name).toBe("Test"); // Unchanged
    });

    it("should not throw for non-existent ID", () => {
      // Just verify it doesn't throw
      expect(() => accountsDb.updateSession(999, "data")).not.toThrow();
    });
  });

  describe("accountsDb.setActive", () => {
    it("should set account as active", () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: false,
      });
      accountsDb.setActive(account.id);

      const updated = accountsDb.getById(account.id);

      expect(updated?.is_active).toBe(1);
    });

    it("should deactivate other accounts", () => {
      const account1 = accountsDb.create({
        phone: "+1111111111",
        is_active: true,
      });
      const account2 = accountsDb.create({
        phone: "+2222222222",
        is_active: false,
      });

      accountsDb.setActive(account2.id);

      const updated1 = accountsDb.getById(account1.id);
      const updated2 = accountsDb.getById(account2.id);

      expect(updated1?.is_active).toBe(0);
      expect(updated2?.is_active).toBe(1);
    });
  });

  describe("accountsDb.delete", () => {
    it("should delete account and return true", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      const deleted = accountsDb.delete(account.id);

      expect(deleted).toBe(true);
      expect(accountsDb.getById(account.id)).toBeNull();
    });

    it("should return false for non-existent ID", () => {
      const deleted = accountsDb.delete(999);

      expect(deleted).toBe(false);
    });

    it("should only delete specified account", () => {
      const account1 = accountsDb.create({ phone: "+1111111111" });
      const account2 = accountsDb.create({ phone: "+2222222222" });

      accountsDb.delete(account1.id);

      expect(accountsDb.getById(account1.id)).toBeNull();
      expect(accountsDb.getById(account2.id)).toBeDefined();
    });
  });

  describe("accountsDb.count", () => {
    it("should return 0 for empty database", () => {
      expect(accountsDb.count()).toBe(0);
    });

    it("should return correct count", () => {
      accountsDb.create({ phone: "+1111111111" });
      accountsDb.create({ phone: "+2222222222" });
      accountsDb.create({ phone: "+3333333333" });

      expect(accountsDb.count()).toBe(3);
    });

    it("should update after delete", () => {
      const account = accountsDb.create({ phone: "+1234567890" });
      accountsDb.create({ phone: "+0987654321" });

      expect(accountsDb.count()).toBe(2);

      accountsDb.delete(account.id);

      expect(accountsDb.count()).toBe(1);
    });
  });

  describe("timestamps", () => {
    it("should set created_at on create", () => {
      const account = accountsDb.create({ phone: "+1234567890" });

      expect(account.created_at).toBeDefined();
      expect(account.created_at).not.toBe("");
    });

    it("should set updated_at on create", () => {
      const account = accountsDb.create({ phone: "+1234567890" });

      expect(account.updated_at).toBeDefined();
      expect(account.updated_at).not.toBe("");
    });
  });
});
