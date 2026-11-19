import { defineCommand } from "citty";
import { accountsCommand } from "./commands/accounts";
import { apiCommand } from "./commands/api";
import { authCommand } from "./commands/auth";
import { chatsCommand } from "./commands/chats";
import { configCommand } from "./commands/config";
import { contactsCommand } from "./commands/contacts";
import { daemonCommand } from "./commands/daemon";
import { dbCommand } from "./commands/db";
import { mediaCommand } from "./commands/media";
import { messagesCommand } from "./commands/messages";
import { sendCommand } from "./commands/send";
import { skillCommand } from "./commands/skill";
import { sqlCommand } from "./commands/sql";
import { statusCommand } from "./commands/status";
import { telemetryCommand } from "./commands/telemetry";
import { meCommand, userCommand } from "./commands/user";
import { ConfigError, ConfigReadError, syncActiveAccountFromConfig } from "./config";
import { endRun, reportErrorType, reportLocalError, startTelemetry } from "./telemetry";
import { ErrorCodes, type OutputFormat } from "./types";
import { outputFormatArg } from "./utils/args";
import { error, getOutputFormat, setOutputFormat } from "./utils/output";
import { VERSION } from "./version";

export const main = defineCommand({
  meta: {
    name: "tg",
    version: VERSION,
    description: "Telegram Sync CLI - Agent-friendly Telegram client",
  },
  args: {
    format: outputFormatArg,
    verbose: {
      type: "boolean",
      alias: "v",
      description: "Enable verbose output",
      default: false,
    },
    quiet: {
      type: "boolean",
      alias: "q",
      description: "Minimal output (errors only)",
      default: false,
    },
  },
  async setup({ args, rawArgs }) {
    const format = args.format as OutputFormat;
    if (format === "json" || format === "pretty" || format === "quiet") {
      setOutputFormat(format);
    }

    if (args.quiet) {
      setOutputFormat("quiet");
    }

    if (args.verbose) {
      process.env.VERBOSE = "1";
    }

    startTelemetry(rawArgs, { quiet: getOutputFormat() === "quiet" });

    const subCommand = rawArgs.find(
      (arg, i) => !arg.startsWith("-") && rawArgs[i - 1] !== "-f" && rawArgs[i - 1] !== "--format",
    );
    if (
      subCommand === "config" ||
      subCommand === "skill" ||
      subCommand === "telemetry" ||
      subCommand === "daemon"
    ) {
      return;
    }

    try {
      await syncActiveAccountFromConfig();
    } catch (err) {
      if (err instanceof ConfigError || err instanceof ConfigReadError) {
        reportLocalError(err);
      }
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues });
      }
      if (err instanceof ConfigReadError) {
        error(
          ErrorCodes.GENERAL_ERROR,
          err.message,
          { path: err.path },
          "Make config.json readable or remove it",
        );
      }
      reportErrorType(err);
      throw err;
    }
  },
  cleanup: endRun,
  subCommands: {
    auth: authCommand,
    accounts: accountsCommand,
    contacts: contactsCommand,
    config: configCommand,
    chats: chatsCommand,
    send: sendCommand,
    daemon: daemonCommand,
    db: dbCommand,
    messages: messagesCommand,
    media: mediaCommand,
    api: apiCommand,
    me: meCommand,
    user: userCommand,
    status: statusCommand,
    skill: skillCommand,
    sql: sqlCommand,
    telemetry: telemetryCommand,
  },
});
