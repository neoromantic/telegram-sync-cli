import { defineCommand } from "citty";

import { cleanMediaCommand } from "./media/clean";
import { downloadMediaCommand } from "./media/download";
import { transcribeMediaCommand } from "./media/transcribe";

/**
 * Media subcommand group: the account's cache of message files,
 * `accounts/<id>/media`
 */
export const mediaCommand = defineCommand({
  meta: {
    name: "media",
    description: "Files of messages, kept in the account's media cache",
  },
  subCommands: {
    download: downloadMediaCommand,
    clean: cleanMediaCommand,
    transcribe: transcribeMediaCommand,
  },
});

export { cleanMediaCommand, downloadMediaCommand, transcribeMediaCommand };
