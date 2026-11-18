import { defineCommand } from "citty";

import {
  ConfigError,
  getConfigPath,
  getConfigValue,
  isConfigKey,
  isConfigLeafKey,
  parseConfigValue,
  setConfigValue,
} from "../config";
import { ErrorCodes } from "../types";
import { error, success } from "../utils/output";

export const configGetCommand = defineCommand({
  meta: {
    name: "get",
    description: "Get a configuration value",
  },
  args: {
    key: {
      type: "positional",
      description: "Config key to read (e.g. cache.staleness.peers)",
      required: true,
    },
  },
  async run({ args }) {
    const key = args.key.trim();

    if (!isConfigKey(key)) {
      error(ErrorCodes.INVALID_ARGS, `Unsupported config key: ${key}`);
    }

    try {
      const value = await getConfigValue(key, { strict: true });
      success({ key, value: value ?? null });
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues });
      }
      throw err;
    }
  },
});

export const configSetCommand = defineCommand({
  meta: {
    name: "set",
    description: "Set a configuration value",
  },
  args: {
    key: {
      type: "positional",
      description: "Config key to update",
      required: true,
    },
    value: {
      type: "positional",
      description: "Value to set",
      required: true,
    },
  },
  async run({ args }) {
    const key = args.key.trim();

    if (!isConfigLeafKey(key)) {
      error(ErrorCodes.INVALID_ARGS, `Unsupported config key: ${key}`);
    }

    try {
      const value = parseConfigValue(key, args.value);
      await setConfigValue(key, value);
      success({ key, value });
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues });
      }
      throw err;
    }
  },
});

export const configPathCommand = defineCommand({
  meta: {
    name: "path",
    description: "Show the config file path",
  },
  async run() {
    success({ path: getConfigPath() });
  },
});

export const configCommand = defineCommand({
  meta: {
    name: "config",
    description: "Manage configuration values",
  },
  subCommands: {
    get: configGetCommand,
    set: configSetCommand,
    path: configPathCommand,
  },
});
