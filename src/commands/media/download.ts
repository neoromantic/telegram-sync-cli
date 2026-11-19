import type { Database } from "bun:sqlite";
import { defineCommand } from "citty";

import { getAccountMediaDir } from "../../db";
import { createMessagesCache } from "../../db/messages-cache";
import { getClientForAccount } from "../../services/telegram";
import { exitAfterFlush } from "../../telemetry";
import { ErrorCodes } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { flagValues } from "../../utils/args";
import { formatBytes } from "../../utils/formatting";
import { error, getOutputFormat, info, rawFile, success } from "../../utils/output";
import { createProgress } from "../../utils/progress";
import { wrapClientCallWithRateLimits } from "../../utils/telegram-rate-limits";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
} from "../messages/helpers";
import { downloadBatch, type FileFailure } from "./batch";
import { type DownloadDeps, type DownloadResult, downloadMedia } from "./download-media";
import { DownloadInterruptedError, reportMediaError } from "./errors";
import {
  BATCH_NAME_TEMPLATE,
  copyOut,
  expandTemplate,
  isTemplate,
  outTarget,
  TEMPLATE_PLACEHOLDERS,
  templateDate,
  templateTarget,
  unknownPlaceholders,
} from "./out";

const CONTEXT = "cli:media.download";
const INTERRUPTED_EXIT_CODE = 130;

function reportInterrupted(err: DownloadInterruptedError) {
  const kept =
    err.downloaded === null
      ? ""
      : err.total === null
        ? `: ${formatBytes(err.downloaded)} kept`
        : `: ${formatBytes(err.downloaded)} of ${formatBytes(err.total)} kept`;
  info(`Download interrupted${kept}, run the command again to resume`);
  return exitAfterFlush(INTERRUPTED_EXIT_CODE);
}

function targetOf(out: string, result: DownloadResult, batch: boolean, cacheDb: Database) {
  if (!batch && !isTemplate(out)) return outTarget(out, result.fileName);
  const row = out.includes("{date}")
    ? createMessagesCache(cacheDb).get(result.chatId, result.messageId)
    : undefined;
  const values = {
    chat: String(result.chatId),
    id: String(result.messageId),
    date: row ? templateDate(row.date) : "unknown",
    name: result.fileName,
    kind: result.kind,
  };
  const name = batch ? expandTemplate(BATCH_NAME_TEMPLATE, values) : result.fileName;
  return isTemplate(out) ? templateTarget(out, values, name) : outTarget(`${out}/`, name);
}

function outputOf(result: DownloadResult, path: string) {
  const { path: cachePath, ...fields } = result;
  return { path, cachePath, ...fields };
}

function exitWith(code: number) {
  if (process.env.BUN_ENV === "test" || process.env.NODE_ENV === "test") {
    process.exitCode = code;
    return;
  }
  void exitAfterFlush(code);
}

export const downloadMediaCommand = defineCommand({
  meta: {
    name: "download",
    description:
      "Download the files of one or more messages into the account's media cache and print their paths (cache-first: a cached file needs no network)",
  },
  args: {
    chat: {
      type: "string",
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: "string",
      description:
        "Message ID; repeat it for several messages of the chat (one JSON line per file)",
      required: true,
    },
    out: {
      type: "string",
      description: `Also copy the file here: a directory (under its name; with several --id, as ${BATCH_NAME_TEMPLATE}), a file path, a name template with ${TEMPLATE_PLACEHOLDERS.map((name) => `{${name}}`).join(" ")}, or - for stdout (bytes only, no JSON)`,
    },
    thumb: {
      type: "boolean",
      description: "Download the file's small preview instead of the file",
      default: false,
    },
    fresh: {
      type: "boolean",
      description:
        "Fetch the message from Telegram again and check its content protection, even when the file is cached",
      default: false,
    },
    overwrite: {
      type: "boolean",
      description: "Replace an existing --out file",
      default: false,
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args, rawArgs }) {
    const ids = flagValues(rawArgs, "id");
    const messageIds = [
      ...new Set(
        (ids.length > 0 ? ids : [args.id]).map((id) =>
          parseIntegerArg(id, "id", { min: 1, max: MAX_MESSAGE_ID }),
        ),
      ),
    ];
    const batch = messageIds.length > 1;
    const out = args.out;
    if (out !== undefined && out.trim() === "") {
      error(ErrorCodes.INVALID_ARGS, "--out needs a directory, a file path or -", { out });
    }
    const unknown = out === undefined ? [] : unknownPlaceholders(out);
    if (unknown.length > 0) {
      error(ErrorCodes.INVALID_ARGS, `Unknown placeholder in --out: {${unknown[0]}}`, {
        out,
        placeholders: TEMPLATE_PLACEHOLDERS,
      });
    }
    if (batch && out === "-") {
      error(
        ErrorCodes.INVALID_ARGS,
        "--out - takes one --id: the bytes of several files would run together",
        { out, ids: messageIds },
      );
    }
    const { account } = openAccountCache(args.account);

    const controller = new AbortController();
    const stop = () => {
      if (controller.signal.aborted) {
        void exitAfterFlush(INTERRUPTED_EXIT_CODE);
        return;
      }
      controller.abort();
    };
    const history = openHistory(account.id, CONTEXT);
    const getClient = () =>
      wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: CONTEXT,
        accountId: account.id,
      });
    const deps: DownloadDeps = {
      cacheDb: history.cacheDb,
      mediaDir: getAccountMediaDir(account.id),
      getClient,
      history,
      signal: controller.signal,
      progress: (fileName) => createProgress(fileName),
    };
    const overwrite = args.overwrite ?? false;
    const options = { thumb: args.thumb ?? false, fresh: args.fresh ?? false };

    const published = batch ? new Set<string>() : undefined;
    const copy = (result: DownloadResult) =>
      out === undefined
        ? result.path
        : copyOut(
            result,
            targetOf(out, result, batch, history.cacheDb),
            overwrite,
            published,
            controller.signal,
          );

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      if (batch) {
        let processed = 0;
        function printLine(
          line:
            | { success: true; data: ReturnType<typeof outputOf> }
            | { success: false; error: FileFailure },
        ) {
          if (getOutputFormat() === "quiet") return;
          console.log(JSON.stringify(line));
          if (process.stderr.isTTY && ++processed < messageIds.length) {
            info(`Processed ${processed} of ${messageIds.length} files`);
          }
        }
        const failures = await downloadBatch(
          deps,
          { chat: args.chat, messageIds, ...options },
          {
            done: async (result) => {
              const path = await copy(result);
              printLine({ success: true, data: outputOf(result, path) });
            },
            failed: (_messageId, failure) => printLine({ success: false, error: failure }),
          },
        );
        const done = messageIds.length - failures;
        info(
          `Downloaded ${done} of ${messageIds.length} files${failures > 0 ? `, ${failures} failed` : ""}`,
        );
        exitWith(failures > 0 ? 1 : 0);
        return;
      }

      const result = await downloadMedia(deps, {
        chat: args.chat,
        messageId: messageIds[0]!,
        ...options,
      });
      if (out === "-") {
        await rawFile(result.path);
        return;
      }
      const path = await copy(result);
      success(outputOf(result, path));
    } catch (err) {
      if (err instanceof DownloadInterruptedError) return reportInterrupted(err);
      reportMediaError(err);
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  },
});
