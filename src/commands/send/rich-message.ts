import type { tl } from "@mtcute/bun";

import { ErrorCodes } from "../../types";
import { error } from "../../utils/output";

export type RichFormat = "markdown" | "html";

/** What to change when Telegram refuses a rich message, by its error name */
export const richErrorHints: Record<string, string> = {
  RICH_MESSAGE_UNSUPPORTED:
    "Rich sending is unavailable for this account or chat. Omit the formatting flag to send plain text.",
  RICH_MESSAGE_EMPTY: "Add visible content to the rich message.",
  RICH_MESSAGE_TEXT_TOO_LONG: "Shorten the rich message text to 32768 characters or fewer.",
  RICH_MESSAGE_BLOCKS_TOO_MANY: "Use at most 500 blocks.",
  RICH_MESSAGE_MEDIA_TOO_MANY: "Use at most 50 media attachments.",
  RICH_MESSAGE_TABLE_COLS_TOO_MANY: "Use at most 20 table columns.",
};

export function richMessage(text: string, format: RichFormat) {
  const result: tl.TypeInputRichMessage =
    format === "markdown"
      ? { _: "inputRichMessageMarkdown", markdown: text }
      : { _: "inputRichMessageHTML", html: text };
  return result;
}

/** The format --markdown or --html asks for; null for plain text */
export function readRichFormat(args: { markdown?: boolean; html?: boolean }) {
  if (args.markdown && args.html) {
    error(ErrorCodes.INVALID_ARGS, "Use --markdown or --html, not both");
  }
  return args.markdown ? "markdown" : args.html ? "html" : null;
}
