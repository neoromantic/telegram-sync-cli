import type { ArgsDef } from "citty";

import type { MessageFilter } from "../../db/messages-history";
import { ErrorCodes } from "../../types";
import { flagValues } from "../../utils/args";
import { MESSAGE_TYPE_FILTERS } from "../../utils/message-type";
import { error } from "../../utils/output";
import { parseTimeBound } from "../../utils/time-bounds";

export const TYPE_ARG_DESCRIPTION = `Only messages of these types, comma-separated or repeated: ${MESSAGE_TYPE_FILTERS.join(", ")}. round and animation are the round video messages and GIFs that video also covers`;

export const SINCE_ARG_DESCRIPTION =
  "Only messages sent at or after: a date (2026-10-01), a date and time (2026-10-01T09:30) or a duration back from now (24h, 7d)";

export const UNTIL_ARG_DESCRIPTION =
  "Only messages sent before: a date and time, a duration back from now, or a date (its whole day included)";

/**
 * Every --type value, from `--type voice,round` and `--type voice --type
 * round` alike, or undefined without the flag. citty keeps only the last
 * of a repeated flag, so they are read from rawArgs.
 */
export function parseTypeArg(rawArgs: string[], defs: ArgsDef) {
  const given = flagValues(rawArgs, "type", defs);
  if (given.length === 0) return undefined;

  const types = [...new Set(given.flatMap((value) => value.split(",")).map((v) => v.trim()))];
  const known: readonly string[] = MESSAGE_TYPE_FILTERS;
  const unknown = types.filter((type) => !known.includes(type));
  if (unknown.length > 0 || types.length === 0) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid --type: ${given.join(",")}`,
      { type: given.join(",") },
      `Use one or more of ${MESSAGE_TYPE_FILTERS.join(", ")}, comma-separated`,
    );
  }
  return types;
}

function parseBound(value: string | undefined, name: "since" | "until", now: number) {
  if (value === undefined) return undefined;
  const seconds = parseTimeBound(value, { now, end: name === "until" });
  if (seconds === null) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid --${name}: ${value}`,
      { [name]: value },
      "Use a date (2026-10-01), a date and time (2026-10-01T09:30, local unless it ends with Z or an offset) or a duration back from now (30m, 24h, 7d, 2w)",
    );
  }
  return seconds;
}

/**
 * A resolved bound as `next` carries it: UTC to the second, so a relative
 * bound (`60s`) keeps the window the first page read
 */
export function formatTimeBound(seconds: number | undefined) {
  if (seconds === undefined) return undefined;
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

/** --since and --until as Unix seconds; INVALID_ARGS unless since < until */
export function parseTimeWindow(args: { since?: string; until?: string }, now = Date.now()) {
  const since = parseBound(args.since, "since", now);
  const until = parseBound(args.until, "until", now);
  if (since !== undefined && until !== undefined && since >= until) {
    error(
      ErrorCodes.INVALID_ARGS,
      `--since (${args.since}) must be earlier than --until (${args.until})`,
    );
  }
  return { since, until } satisfies Pick<MessageFilter, "since" | "until">;
}
