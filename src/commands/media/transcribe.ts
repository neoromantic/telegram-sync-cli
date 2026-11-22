import { stopLocalProcesses } from "./local-process";
import { openDownloadDeps } from "./download-deps";
import { type ArgsDef, defineCommand } from "citty";

import { loadConfig } from "../../config";
import { exitAfterFlush } from "../../telemetry";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { flagValues } from "../../utils/args";
import { getOutputFormat, info, success } from "../../utils/output";
import { CHAT_ARG_DESCRIPTION, MAX_MESSAGE_ID, parseIntegerArg } from "../messages/helpers";
import { MediaError, reportMediaError } from "./errors";
import { openLocalProvider } from "./local-provider";
import { type TranscribeOutcome, transcribeMessages } from "./transcription-pipeline";

const CONTEXT = "cli:media.transcribe";
const INTERRUPTED_EXIT_CODE = 130;

const transcribeArgs = {
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
} satisfies ArgsDef;

export const transcribeMediaCommand = defineCommand({
  meta: {
    name: "transcribe",
    description:
      "Transcribe voice notes and video notes with a speech-to-text program on this machine (whisper.cpp or an openai-whisper CLI), store the text and print it",
  },
  args: transcribeArgs,
  async run({ args, rawArgs }) {
    const rawIds = flagValues(rawArgs, "id", transcribeArgs);
    const messageIds = [
      ...new Set(
        (rawIds.length > 0 ? rawIds : [args.id]).map((id) =>
          parseIntegerArg(id, "id", { min: 1, max: MAX_MESSAGE_ID }),
        ),
      ),
    ];
    const { account } = openAccountCache(args.account);

    const controller = new AbortController();
    const stop = () => {
      if (controller.signal.aborted) {
        stopLocalProcesses();
        void exitAfterFlush(INTERRUPTED_EXIT_CODE);
        return;
      }
      controller.abort();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);

    let outcomes: TranscribeOutcome[];
    try {
      const { config } = await loadConfig({ strict: true });
      const transcribe = config.transcribe ?? {};
      outcomes = await transcribeMessages(
        {
          download: openDownloadDeps(account.id, CONTEXT, controller.signal),
          setup: openLocalProvider(transcribe.local ?? {}),
          language: args.language?.trim() || transcribe.language || null,
          force: args.force ?? false,
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
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
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
