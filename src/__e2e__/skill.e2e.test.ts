import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { runCliSuccess } from "./helpers/cli";
import { createTestEnvironment } from "./helpers/setup";

const VALID_ENV = {
  TELEGRAM_API_ID: "12345",
  TELEGRAM_API_HASH: "test-hash",
};

type SkillManifestPayload = {
  name: string;
  entrypoint: string;
  output: string;
};

type SkillValidatePayload = {
  valid: boolean;
  env: {
    telegram_api_id: { valid: boolean };
    telegram_api_hash: { valid: boolean };
  };
  data_dir: { path: string };
};

type SkillInstallPayload = {
  overwritten: boolean;
};

describe("E2E: Skill Commands", () => {
  it("prints the skill manifest", async () => {
    const env = createTestEnvironment("skill-manifest");

    try {
      const result = await runCliSuccess(["skill", "manifest"], {
        env: {
          ...env.getCliOptions().env,
          ...VALID_ENV,
        },
      });

      const payload = result.json as {
        success: boolean;
        data: SkillManifestPayload;
      };
      expect(payload.success).toBe(true);
      expect(payload.data).toMatchObject({
        name: "@goodit/telegram-sync-cli",
        entrypoint: "tg",
        output: "json",
      });
    } finally {
      env.cleanup();
    }
  });

  it("validates environment", async () => {
    const env = createTestEnvironment("skill-validate");

    try {
      const result = await runCliSuccess(["skill", "validate"], {
        env: {
          ...env.getCliOptions().env,
          ...VALID_ENV,
        },
      });

      const payload = result.json as {
        success: boolean;
        data: SkillValidatePayload;
      };
      expect(payload.success).toBe(true);
      expect(payload.data.valid).toBe(true);
      expect(payload.data.env.telegram_api_id.valid).toBe(true);
      expect(payload.data.env.telegram_api_hash.valid).toBe(true);
      expect(payload.data.data_dir.path).toBe(env.dataDir);
    } finally {
      env.cleanup();
    }
  });

  it("installs the manifest file", async () => {
    const env = createTestEnvironment("skill-install");

    try {
      const result = await runCliSuccess(["skill", "install"], {
        env: {
          ...env.getCliOptions().env,
          ...VALID_ENV,
        },
      });

      const payload = result.json as {
        success: boolean;
        data: SkillInstallPayload;
      };
      expect(payload.success).toBe(true);
      expect(payload.data.overwritten).toBe(false);

      const manifestPath = join(env.dataDir, "skill.json");
      const manifestText = await Bun.file(manifestPath).text();
      const manifest = JSON.parse(manifestText);

      expect(manifest.name).toBe("@goodit/telegram-sync-cli");
      expect(manifest.entrypoint).toBe("tg");
    } finally {
      env.cleanup();
    }
  });
});
