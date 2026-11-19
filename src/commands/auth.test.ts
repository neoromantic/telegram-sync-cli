import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramClient } from "@mtcute/bun";
import {
  type AuthDependencies,
  getAuthStatus,
  getDefaultDependencies,
  loginWithPhone,
  loginWithQr,
  logout,
} from "./auth";
import { syncActiveAccountFromConfig } from "../config";
import { type AccountsDbInterface, createTestDatabase } from "../db";
import { renderQr } from "../utils/qr";

process.env.BUN_ENV = "test";

const PHONE = "+15550000002";

describe("Authentication Commands", () => {
  let accountsDb: AccountsDbInterface;
  let mockClients: Map<number, TelegramClient>;
  let deps: AuthDependencies;

  type SignInQrOptions = {
    onUrlUpdated?: (url: string, expires: Date) => void;
    onQrScanned?: () => void;
  };

  type MockAuthClient = Pick<TelegramClient, "start" | "getMe" | "signInQr" | "call" | "destroy">;

  type UserResult = Awaited<ReturnType<TelegramClient["getMe"]>>;

  const createUser = (overrides: Partial<UserResult> = {}) =>
    ({
      id: 123,
      firstName: "Test",
      lastName: "User",
      username: "testuser",
      ...overrides,
    }) as UserResult;

  const createMockClient = (overrides: Partial<MockAuthClient> = {}) => {
    const client = {
      start: mock(() =>
        Promise.resolve(
          createUser({
            id: 123,
            firstName: "Test",
            lastName: "User",
            username: "testuser",
          }),
        ),
      ),
      getMe: mock(() =>
        Promise.resolve(
          createUser({
            id: 123,
            firstName: "Test",
            username: "testuser",
          }),
        ),
      ),
      signInQr: mock((_options: SignInQrOptions) =>
        Promise.resolve(
          createUser({
            id: 456,
            firstName: "QR",
            lastName: "User",
            username: "qruser",
          }),
        ),
      ),
      call: mock(() => Promise.resolve({})),
      destroy: mock(() => Promise.resolve()),
      ...overrides,
    } satisfies MockAuthClient;

    return client as TelegramClient;
  };

  beforeEach(() => {
    const testDb = createTestDatabase();
    accountsDb = testDb.accountsDb;
    mockClients = new Map();

    deps = {
      ...getDefaultDependencies(),
      accountsDb,
      createClient: mock((accountId: number) => {
        const client = createMockClient({
          signInQr: mock((options: SignInQrOptions) => {
            if (options.onUrlUpdated) {
              options.onUrlUpdated("tg://login?token=abc", new Date());
            }
            if (options.onQrScanned) {
              options.onQrScanned();
            }
            return Promise.resolve(
              createUser({
                id: 456,
                firstName: "QR",
                lastName: "User",
                username: "qruser",
              }),
            );
          }),
        });
        mockClients.set(accountId, client);
        return client;
      }),
      getClient: mock((accountId: number) => {
        let client = mockClients.get(accountId);
        if (!client) {
          client = createMockClient();
          mockClients.set(accountId, client);
        }
        return client;
      }),
    };
  });

  describe("loginWithPhone", () => {
    it("should create new account and login", async () => {
      const result = await loginWithPhone("+1234567890", deps);

      expect(result.success).toBe(true);
      expect(result.account).toBeDefined();
      expect(result.account?.phone).toBe("+1234567890");
      expect(result.account?.name).toBe("Test");
      expect(result.account?.username).toBe("testuser");
    });

    it("should use existing account if phone exists", async () => {
      const existing = accountsDb.create({
        phone: "+1234567890",
        name: "Existing",
      });

      const result = await loginWithPhone("+1234567890", deps);

      expect(result.success).toBe(true);
      expect(result.account?.id).toBe(existing.id);
    });

    it("moves the phone onto the user's account from a QR login and creates no other", async () => {
      const existing = accountsDb.create({ phone: "user:123", user_id: 123 });

      const result = await loginWithPhone("+15550000001", deps);

      expect(result).toMatchObject({ success: true, account: { id: existing.id } });
      expect(accountsDb.getAll()).toMatchObject([
        { id: existing.id, phone: "+15550000001", user_id: 123, is_active: 1 },
      ]);
    });

    it("stores the user's full name, username and the label", async () => {
      await loginWithPhone("+1234567890", deps, { label: "Work" });

      const account = accountsDb.getByPhone("+1234567890");
      expect(account?.name).toBe("Test User");
      expect(account?.username).toBe("testuser");
      expect(account?.label).toBe("Work");

      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.resolve(createUser({ firstName: "Single", lastName: null }))),
        }),
      );
      await loginWithPhone("+1234567890", deps);
      expect(accountsDb.getByPhone("+1234567890")?.name).toBe("Single");
    });

    it("should return error on login failure", async () => {
      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.reject(new Error("Invalid phone"))),
        }),
      );

      const result = await loginWithPhone("+1234567890", deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid phone");

      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.reject("string error")),
        }),
      );
      expect(await loginWithPhone("+1234567890", deps)).toEqual({
        success: false,
        error: "Unknown error",
      });
    });

    it("closes client after successful login", async () => {
      const client = createMockClient({
        start: mock(() =>
          Promise.resolve(
            createUser({
              id: 321,
              firstName: "Close",
              lastName: "Test",
              username: "closer",
            }),
          ),
        ),
      });

      deps.createClient = mock(() => client);

      await loginWithPhone("+15559998877", deps);

      expect(client.destroy).toHaveBeenCalled();
    });
  });

  describe("loginWithQr", () => {
    let logSpy: Mock<typeof console.log>;
    let errorSpy: Mock<typeof console.error>;

    beforeEach(() => {
      logSpy = spyOn(console, "log");
      errorSpy = spyOn(console, "error");
    });

    afterEach(() => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("should create new account and login via QR", async () => {
      const result = await loginWithQr("test_account", deps);

      expect(result.success).toBe(true);
      expect(result.account).toBeDefined();
      expect(result.account?.name).toBe("QR");
      expect(result.account?.username).toBe("qruser");
      expect(result.account?.userId).toBe(456);
      expect(accountsDb.getAll().map((account) => account.phone)).toEqual(["user:456"]);
    });

    it("should delete account on failure", async () => {
      deps.createClient = mock(() =>
        createMockClient({
          signInQr: mock(() => Promise.reject(new Error("QR expired"))),
        }),
      );

      const result = await loginWithQr("test", deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("QR expired");
      expect(accountsDb.count()).toBe(0);
    });

    it("prints the QR code and its prompts to stderr, never stdout", async () => {
      await loginWithQr("test", deps);

      expect(errorSpy).toHaveBeenCalledWith(renderQr("tg://login?token=abc"));
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("the account a login makes active", () => {
    const isRoot = process.getuid?.() === 0;
    const logins = [
      ["tg auth login", (d: AuthDependencies) => loginWithPhone(PHONE, d)],
      ["tg auth login-qr", (d: AuthDependencies) => loginWithQr("Second", d)],
    ] as const;

    let dataDir: string;
    let savedDataDir: string | undefined;

    const configPath = () => join(dataDir, "config.json");
    const writeConfig = (text: string) => writeFileSync(configPath(), text);
    const readConfig = () => readFileSync(configPath(), "utf8");

    const activeIds = () =>
      accountsDb
        .getAll()
        .filter((account) => account.is_active === 1)
        .map((account) => account.id);

    const nextCommandStart = () => syncActiveAccountFromConfig(accountsDb);

    const failLogins = () => {
      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.reject(new Error("Code expired"))),
          signInQr: mock(() => Promise.reject(new Error("QR expired"))),
        }),
      );
    };

    beforeEach(() => {
      savedDataDir = process.env.TELEGRAM_SYNC_CLI_DATA_DIR;
      dataDir = mkdtempSync(join(tmpdir(), "telegram-sync-cli-auth-test-"));
      process.env.TELEGRAM_SYNC_CLI_DATA_DIR = dataDir;
      accountsDb.create({
        phone: "+15550000001",
        user_id: 999,
        is_active: true,
      });
    });

    afterEach(() => {
      process.env.TELEGRAM_SYNC_CLI_DATA_DIR = savedDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    });

    for (const [name, login] of logins) {
      it(`${name} writes the account to activeAccount and keeps the other keys`, async () => {
        writeConfig(
          JSON.stringify({
            activeAccount: 1,
            cache: { staleness: { peers: "3d" } },
            note: "kept",
          }),
        );

        const result = await login(deps);
        await nextCommandStart();

        expect(result.account?.id).toBe(2);
        expect(JSON.parse(readConfig())).toEqual({
          activeAccount: 2,
          cache: { staleness: { peers: "3d" } },
          note: "kept",
        });
        expect(activeIds()).toEqual([2]);
      });

      it(`${name} leaves the active account and config.json alone when it fails`, async () => {
        const text = JSON.stringify({ activeAccount: 1 });
        writeConfig(text);
        failLogins();

        const result = await login(deps);

        expect(result.success).toBe(false);
        expect(activeIds()).toEqual([1]);
        expect(readConfig()).toBe(text);
      });
    }

    it("makes a new account the only active one and creates no config.json", async () => {
      const result = await loginWithPhone(PHONE, deps);
      await nextCommandStart();

      expect(result.account?.id).toBe(2);
      expect(activeIds()).toEqual([2]);
      expect(existsSync(configPath())).toBe(false);
    });

    it("leaves a config.json without activeAccount byte for byte", async () => {
      const text = '{"cache":{"staleness":{"peers":"3d"}}}';
      writeConfig(text);

      await loginWithPhone(PHONE, deps);
      await nextCommandStart();

      expect(readConfig()).toBe(text);
      expect(activeIds()).toEqual([2]);
    });

    it.skipIf(isRoot)("fails with GENERAL_ERROR when activeAccount can't be written", async () => {
      const text = JSON.stringify({ activeAccount: 1 });
      writeConfig(text);
      chmodSync(configPath(), 0o444);
      const errorSpy = spyOn(console, "error");

      let printed: string | undefined;
      const failure = await loginWithPhone(PHONE, deps)
        .then(
          () => undefined,
          (err: Error & { code?: string; details?: unknown }) => err,
        )
        .finally(() => {
          printed = String(errorSpy.mock.calls.at(-1)?.[0]);
          errorSpy.mockRestore();
        });

      expect(failure?.code).toBe("GENERAL_ERROR");
      expect(failure?.message).toStartWith(
        "Logged in as account 2, but could not write activeAccount to",
      );
      expect(failure?.details).toEqual({
        path: configPath(),
        account_id: 2,
      });
      expect(JSON.parse(printed ?? "").error.suggestion).toBe(
        "Make config.json writable or remove activeAccount from it, then run tg accounts switch --id 2",
      );
      expect(readConfig()).toBe(text);
      expect(activeIds()).toEqual([1]);
    });

    it("leaves config.json alone when activeAccount already names the account", async () => {
      accountsDb.create({ phone: PHONE });
      const text = JSON.stringify({ activeAccount: 2 });
      writeConfig(text);

      await loginWithPhone(PHONE, deps);
      await nextCommandStart();

      expect(readConfig()).toBe(text);
      expect(activeIds()).toEqual([2]);
    });

    it("writes the account a QR login merges into, not the one it created", async () => {
      accountsDb.create({ phone: "+15550000003", user_id: 456 });
      writeConfig(JSON.stringify({ activeAccount: 1 }));

      const result = await loginWithQr("Again", deps);
      await nextCommandStart();

      expect(result.account?.id).toBe(2);
      expect(accountsDb.count()).toBe(2);
      expect(accountsDb.getById(2)?.phone).toBe("+15550000003");
      expect(JSON.parse(readConfig())).toEqual({ activeAccount: 2 });
      expect(activeIds()).toEqual([2]);
    });
  });

  describe("logout", () => {
    it("should logout and delete account", async () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });
      const client = deps.getClient(account.id);

      const result = await logout(account.id, deps);

      expect(client.call).toHaveBeenCalledWith({ _: "auth.logOut" });
      expect(result.success).toBe(true);
      expect(result.accountId).toBe(account.id);
      expect(result.phone).toBe("+1234567890");
      expect(accountsDb.getById(account.id)).toBeNull();
    });

    it("should logout active account if no ID specified", async () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });

      const result = await logout(undefined, deps);

      expect(result.success).toBe(true);
      expect(result.accountId).toBe(account.id);
    });

    it("should return error if no account found", async () => {
      const result = await logout(undefined, deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("No account found to logout");
    });

    it("should return error on API failure", async () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });
      deps.getClient = mock(() =>
        createMockClient({
          call: mock(() => Promise.reject(new Error("Network error"))),
        }),
      );

      const result = await logout(account.id, deps);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
    });
  });

  describe("getAuthStatus", () => {
    it("should return authenticated status", async () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });

      const result = await getAuthStatus(account.id, deps);

      expect(result.authenticated).toBe(true);
      expect(result.account?.phone).toBe("+1234567890");
      expect(result.account?.username).toBe("testuser");
      expect(result.account?.userId).toBe(123);
    });

    it("should return not authenticated if no account", async () => {
      const result = await getAuthStatus(undefined, deps);

      expect(result.authenticated).toBe(false);
      expect(result.message).toBe("No account configured");
    });

    it("should use active account if no ID specified", async () => {
      accountsDb.create({ phone: "+1234567890", is_active: true });

      const result = await getAuthStatus(undefined, deps);

      expect(result.account?.phone).toBe("+1234567890");
    });

    it("should return not authenticated if client not authorized", async () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });
      deps.getClient = mock(() =>
        createMockClient({
          getMe: mock(() => Promise.reject(new Error("AUTH_KEY_UNREGISTERED"))),
        }),
      );

      const result = await getAuthStatus(account.id, deps);

      expect(result.authenticated).toBe(false);
      expect(result.message).toContain("not authenticated");
      expect(result.account?.id).toBe(account.id);
      expect(result.account?.phone).toBe("+1234567890");
    });

    it("should return not authenticated on error", async () => {
      const account = accountsDb.create({
        phone: "+1234567890",
        is_active: true,
      });
      let lookups = 0;
      deps.getClient = mock(() =>
        createMockClient({
          getMe: mock(() => {
            lookups++;
            return lookups === 1
              ? Promise.resolve(createUser())
              : Promise.reject(new Error("Network error"));
          }),
        }),
      );

      const result = await getAuthStatus(account.id, deps);

      expect(result.authenticated).toBe(false);
      expect(result.message).toBe("Could not verify authentication status");
    });
  });
});
