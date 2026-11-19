import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";

import { loadConfig, type TranscribeConfigFile } from "../../config";
import { getAccountMediaDir } from "../../db";
import { getClientForAccount } from "../../services/telegram";
import { exitAfterFlush } from "../../telemetry";
import type { TranscriptSource } from "../../types";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { flagValues } from "../../utils/args";
import { getOutputFormat, info, success } from "../../utils/output";
import { createProgress } from "../../utils/progress";
import { wrapClientCallWithRateLimits } from "../../utils/telegram-rate-limits";
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  openHistory,
  parseIntegerArg,
} from "../messages/helpers";
import { MediaError, reportMediaError } from "./errors";
import { openLocalProvider } from "./local-provider";
import { type TranscribeOutcome, transcribeMessages } from "./transcription-pipeline";
import type { ProviderSetup } from "./transcription-provider";

const CONTEXT = "cli:media.transcribe";
const INTERRUPTED_EXIT_CODE = 130;

const PROVIDERS: Record<TranscriptSource, (config: TranscribeConfigFile) => ProviderSetup> = {
  local: (config) => openLocalProvider(config),
};

export const transcribeMediaCommand = defineCommand({
  meta: {
    name: "transcribe",
    description:
      "Transcribe voice notes and video notes with a speech-to-text program on this machine (whisper.cpp or an openai-whisper CLI), store the text and print it",
  },
  args: {
    chat: {
      type: "string",
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: "string",
      description: "Message ID; repeat for several",
      required: true,
    },
    language: {
      type: "string",
      description: "Language code of the speech (en, ru…); the program detects it by default",
    },
    force: {
      type: "boolean",
      description: "Transcribe again, even when a transcript is stored",
      default: false,
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args, rawArgs }) {
    const rawIds = flagValues(rawArgs ?? [], "id");
    const messageIds = [
      ...new Set(
        (rawIds.length > 0 ? rawIds : [args.id]).map((id) =>
          parseIntegerArg(id, "id", { min: 1, max: MAX_MESSAGE_ID }),
        ),
      ),
    ];
    const { account } = openAccountCache(args.account);

    const tmpRoot = mkdtempSync(join(tmpdir(), "tg-transcribe-"));
    process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));
    const controller = new AbortController();
    const stop = () => {
      if (controller.signal.aborted) process.exit(INTERRUPTED_EXIT_CODE);
      controller.abort();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);

    let outcomes: TranscribeOutcome[];
    try {
      const { config } = await loadConfig({ strict: true });
      const transcribe = config.transcribe ?? {};
      const history = openHistory(account.id, CONTEXT);
      const getClient = () =>
        wrapClientCallWithRateLimits(getClientForAccount(account.id), {
          context: CONTEXT,
          accountId: account.id,
        });
      outcomes = await transcribeMessages(
        {
          download: {
            cacheDb: history.cacheDb,
            mediaDir: getAccountMediaDir(account.id),
            getClient,
            history,
            signal: controller.signal,
            progress: (fileName) => createProgress(fileName),
          },
          setup: PROVIDERS.local(transcribe),
          language: args.language?.trim() || transcribe.language || null,
          force: args.force ?? false,
          tmpRoot,
        },
        args.chat,
        messageIds,
      );
      controller.signal.throwIfAborted();
    } catch (err) {
      if (controller.signal.aborted) {
        info("Transcription interrupted; transcripts made so far are stored");
        return exitAfterFlush(INTERRUPTED_EXIT_CODE);
      }
      reportMediaError(err);
    }

    if (outcomes.length === 1) {
      const [only] = outcomes;
      if (only instanceof MediaError) reportMediaError(only);
      success(only);
      return;
    }
    printBatch(outcomes);
  },
});

function printBatch(results: TranscribeOutcome[]) {
  let failed = 0;
  for (const result of results) {
    const line =
      result instanceof MediaError
        ? {
            success: false,
            error: {
              code: result.code,
              message: result.message,
              details: result.details,
              suggestion: result.suggestion,
              retryable: result.retryable,
            },
          }
        : { success: true, data: result };
    if (result instanceof MediaError) failed++;
    if (getOutputFormat() !== "quiet") console.log(JSON.stringify(line));
  }
  if (failed > 0) {
    info(`Transcribed ${results.length - failed} of ${results.length} messages, ${failed} failed`);
  }
  void exitAfterFlush(failed > 0 ? 1 : 0);
}
