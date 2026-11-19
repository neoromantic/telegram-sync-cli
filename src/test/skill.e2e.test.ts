import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { runCli, runCliSuccess } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const SKILL_PATH = join(import.meta.dir, "../../skills/telegram-sync-cli/SKILL.md");

const VALID_ENV = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "test-hash",
};

interface ValidateData {
  valid: boolean;
  account: { id: number; username: string | null; label: string | null } | null;
  accounts_total: number | null;
  daemon: {
    status: "running" | "stopped" | "unknown";
    pid: number | null;
    error?: string;
  };
  issues: string[];
}

describe("E2E: Skill Commands", () => {
  let env: TestEnvironment;

  afterEach(() => env.cleanup());

  const validate = async () => {
    const result = await runCliSuccess(["skill", "validate"], {
      env: { ...env.getCliOptions().env, ...VALID_ENV },
    });
    return (result.json as { data: ValidateData }).data;
  };

  it("install writes the repo SKILL.md into <dir>/telegram-sync-cli, <dir> as given", async () => {
    env = createTestEnvironment("skill-install");
    const dir = join(env.dataDir, "agent-skills ");

    const first = await runCliSuccess(["skill", "install", "--dir", dir], env.getCliOptions());
    const path = join(dir, "telegram-sync-cli", "SKILL.md");
    const expected = await Bun.file(SKILL_PATH).text();

    expect(first.json).toMatchObject({
      success: true,
      data: { path, overwritten: false },
    });
    expect(await Bun.file(path).text()).toBe(expected);
    expect(existsSync(join(env.dataDir, "agent-skills"))).toBe(false);

    const second = await runCliSuccess(["skill", "install", "--dir", dir], env.getCliOptions());
    expect(second.json).toMatchObject({ data: { overwritten: true } });
  });

  it("install needs --dir", async () => {
    env = createTestEnvironment("skill-install-no-dir");

    const result = await runCli(["skill", "install"], env.getCliOptions());

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("--dir");
  });

  it("install rejects an empty --dir before writing", async () => {
    env = createTestEnvironment("skill-install-empty-dir");
    const cwd = join(env.dataDir, "cwd");
    mkdirSync(cwd);

    for (const args of [["--dir"], ["--dir="]]) {
      const result = await runCli(["skill", "install", ...args], {
        ...env.getCliOptions(),
        cwd,
      });
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("--dir needs a directory");
    }
    expect(existsSync(join(cwd, "telegram-sync-cli"))).toBe(false);
  });

  it("install replaces an existing SKILL.md with other contents", async () => {
    env = createTestEnvironment("skill-install-replace");
    const dir = join(env.dataDir, "agent-skills");
    const path = join(dir, "telegram-sync-cli", "SKILL.md");
    mkdirSync(join(dir, "telegram-sync-cli"), { recursive: true });
    writeFileSync(path, "# A locally edited copy\n");

    const result = await runCliSuccess(["skill", "install", "--dir", dir], env.getCliOptions());

    expect(result.json).toMatchObject({ data: { path, overwritten: true } });
    expect(readFileSync(path, "utf8")).toBe(await Bun.file(SKILL_PATH).text());
  });

  it("install follows a skills directory that is a link", async () => {
    env = createTestEnvironment("skill-install-linked-root");
    const real = join(env.dataDir, "real-skills");
    const linked = join(env.dataDir, "linked-skills");
    mkdirSync(real);
    symlinkSync(real, linked);

    await runCliSuccess(["skill", "install", "--dir", linked], env.getCliOptions());

    expect(readFileSync(join(real, "telegram-sync-cli", "SKILL.md"), "utf8")).toBe(
      await Bun.file(SKILL_PATH).text(),
    );
  });

  it("install refuses a link inside the skills directory", async () => {
    env = createTestEnvironment("skill-install-inner-link");
    const other = join(env.dataDir, "other-tree");
    mkdirSync(join(other, "telegram-sync-cli"), { recursive: true });
    const otherFile = join(other, "telegram-sync-cli", "SKILL.md");
    writeFileSync(otherFile, "# Another tree\n");

    const dirLinked = join(env.dataDir, "skills-a");
    mkdirSync(dirLinked);
    symlinkSync(join(other, "telegram-sync-cli"), join(dirLinked, "telegram-sync-cli"));
    const fileLinked = join(env.dataDir, "skills-b");
    mkdirSync(join(fileLinked, "telegram-sync-cli"), { recursive: true });
    symlinkSync(otherFile, join(fileLinked, "telegram-sync-cli", "SKILL.md"));

    for (const [dir, link] of [
      [dirLinked, join(dirLinked, "telegram-sync-cli")],
      [fileLinked, join(fileLinked, "telegram-sync-cli", "SKILL.md")],
    ] as const) {
      const result = await runCli(["skill", "install", "--dir", dir], env.getCliOptions());
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: "GENERAL_ERROR",
          details: { reason: `${link} is a symbolic link`, path: link },
        },
      });
    }
    expect(readFileSync(otherFile, "utf8")).toBe("# Another tree\n");
  });

  it("validate reports the account the next command uses after tg config set activeAccount", async () => {
    env = createTestEnvironment("skill-validate-config-account");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001", is_active: true }, { phone: "+15550000002" }]);

    await runCliSuccess(["config", "set", "activeAccount", "2"], env.getCliOptions());
    const data = await validate();
    const info = await runCliSuccess(["accounts", "info"], env.getCliOptions());

    expect(data).toMatchObject({ valid: true, account: { id: 2 }, issues: [] });
    expect(info.json).toMatchObject({ data: { account: { id: 2 } } });
  });

  it("validate reports an invalid config.json as an issue", async () => {
    env = createTestEnvironment("skill-validate-bad-config");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001", is_active: true }]);
    writeFileSync(join(env.dataDir, "config.json"), '{"activeAccount":"one"}');

    const data = await validate();

    expect(data).toMatchObject({
      valid: false,
      account: null,
      accounts_total: 1,
    });
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]).toContain("config.json: Config file has invalid values");
    expect(data.issues[0]).toContain("activeAccount");
  });

  it("validate reads the accounts and the PID file of a read-only data directory", async () => {
    env = createTestEnvironment("skill-validate-read-only");
    const db = env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001" }]);
    db.close();
    writeFileSync(join(env.dataDir, "daemon.pid"), String(process.pid));
    chmodSync(env.dataDir, 0o555);

    let data: ValidateData;
    try {
      data = await validate();
    } finally {
      chmodSync(env.dataDir, 0o755);
    }

    expect(data).toMatchObject({
      valid: false,
      account: { id: 1 },
      accounts_total: 1,
      daemon: { status: "running", pid: process.pid },
      issues: ["Data directory is not writable"],
    });
  });

  it("validate reports an unreadable PID file as unknown", async () => {
    env = createTestEnvironment("skill-validate-pid-unreadable");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001" }]);
    const pidPath = join(env.dataDir, "daemon.pid");
    writeFileSync(pidPath, String(process.pid));
    chmodSync(pidPath, 0o000);

    const data = await validate();

    expect(data.daemon).toMatchObject({ status: "unknown", pid: null });
    expect(data.daemon.error).toContain("EACCES");
    expect(data).toMatchObject({ valid: true, account: { id: 1 } });
  });

  it("validate and install work with a corrupt data.db", async () => {
    env = createTestEnvironment("skill-corrupt-data-db");
    const dbPath = join(env.dataDir, "data.db");
    writeFileSync(dbPath, "not a database ".repeat(300));

    const data = await validate();
    expect(data).toMatchObject({
      valid: false,
      account: null,
      accounts_total: null,
      daemon: { status: "stopped", pid: null },
      issues: [`Could not read the accounts in ${dbPath}: file is not a database`],
    });

    const dir = join(env.dataDir, "agent-skills");
    const install = await runCliSuccess(["skill", "install", "--dir", dir], env.getCliOptions());
    expect(install.json).toMatchObject({ success: true });
  });

  it("validate leaves data.db as it found it", async () => {
    env = createTestEnvironment("skill-validate-no-writes");
    const db = env.initDatabase();
    env.seedAccounts([
      { phone: "+15550000001", user_id: 2001, is_active: true },
      { phone: "user:2001" },
    ]);

    const data = await validate();

    expect(data).toMatchObject({ account: { id: 1 }, accounts_total: 2 });
    expect(db.query("SELECT id, phone FROM accounts ORDER BY id").all()).toEqual([
      { id: 1, phone: "+15550000001" },
      { id: 2, phone: "user:2001" },
    ]);
  });

  it("validate withholds a legacy duplicate until the next account lookup resolves it", async () => {
    env = createTestEnvironment("skill-validate-legacy-config");
    const db = env.initDatabase();
    env.seedAccounts([
      { phone: "+15550000001", user_id: 1001, is_active: true },
      { phone: "+15550000002", user_id: 2002 },
      { phone: "user:2002" },
    ]);
    await runCliSuccess(["config", "set", "activeAccount", "3"], env.getCliOptions());

    const before = await validate();
    expect(before).toMatchObject({ valid: false, account: null, accounts_total: 3 });
    expect(before.issues[0]).toContain("tg accounts list");
    expect(db.query("SELECT id FROM accounts WHERE id = 3").get()).toEqual({ id: 3 });

    const info = await runCliSuccess(["accounts", "info"], env.getCliOptions());
    expect(info.json).toMatchObject({ data: { account: { id: 1 } } });
    expect(await validate()).toMatchObject({ valid: true, account: { id: 1 }, accounts_total: 2 });
  });

  it("validate reports an unreadable daemon.pid directory independently of the account", async () => {
    env = createTestEnvironment("skill-validate-pid-directory");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001" }]);
    mkdirSync(join(env.dataDir, "daemon.pid"));

    const data = await validate();

    expect(data).toMatchObject({
      valid: true,
      account: { id: 1 },
      daemon: { status: "unknown", pid: null },
    });
    expect(data.daemon.error).toBeTruthy();
  });

  it("validate reports a data.db that is not a file", async () => {
    env = createTestEnvironment("skill-validate-data-db-dir");
    const dbPath = join(env.dataDir, "data.db");
    mkdirSync(dbPath);

    const data = await validate();

    expect(data).toMatchObject({ valid: false, account: null, accounts_total: null });
    expect(data.issues).toEqual([`Could not read the accounts in ${dbPath}: not a file`]);
  });

  it("validate reports the active account and a stopped daemon", async () => {
    env = createTestEnvironment("skill-validate");
    env.initDatabase();
    env.seedAccounts([
      { phone: "+15550000001", username: "example_one", label: "home" },
      {
        phone: "+15550000002",
        username: "example_two",
        label: "work",
        is_active: true,
      },
    ]);

    const data = await validate();

    expect(data).toMatchObject({
      valid: true,
      account: { id: 2, username: "example_two", label: "work" },
      accounts_total: 2,
      daemon: { status: "stopped", pid: null },
      issues: [],
    });
  });

  it("validate reports a running daemon", async () => {
    env = createTestEnvironment("skill-validate-daemon");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001" }]);
    writeFileSync(join(env.dataDir, "daemon.pid"), String(process.pid));

    const data = await validate();

    expect(data.account?.id).toBe(1);
    expect(data.daemon).toEqual({ status: "running", pid: process.pid });
  });

  it("validate names a missing or ambiguous account as an issue", async () => {
    env = createTestEnvironment("skill-validate-accounts");
    env.initDatabase();

    const none = await validate();
    expect(none).toMatchObject({
      valid: false,
      account: null,
      accounts_total: 0,
      issues: ["No account: log in with tg auth login"],
    });

    env.seedAccounts([{ phone: "+15550000001" }, { phone: "+15550000002" }]);
    const two = await validate();
    expect(two.valid).toBe(false);
    expect(two.account).toBeNull();
    expect(two.issues).toEqual([
      "2 accounts and none is active: pass --account or run tg accounts switch --id <id>",
    ]);
  });
});
