/**
 * `next` in a success answer: complete `tg` command lines that continue a
 * read, built from a command's parsed arguments so the account and every
 * filter carry over.
 */
import type { ArgsDef } from "citty";

import type { NextCommand } from "../types";
import { COMMAND_ACCESS } from "./access";

/** Characters a POSIX shell reads as themselves outside quotes */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** `value` as one POSIX shell word: as is when safe, else in single quotes */
export function shellQuote(value: string): string {
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command line for `tg <path>` with `values` for the args that `defs`
 * declares. Flags at their default are left out. A value goes as
 * `--name=value`, so one that starts with `-` stays the flag's value.
 * The global --format and --verbose are never carried: `next` is for the
 * JSON output, the default.
 */
export function tgCommand(path: string, defs: ArgsDef, values: Record<string, unknown>): string {
  const access = COMMAND_ACCESS[path];
  // Read-only mode would refuse a write, so next never suggests one
  if (!access || access.write) {
    throw new Error(`tg ${path} can't be suggested as a next command`);
  }

  const words = ["tg", ...path.split(" ")];
  for (const [name, def] of Object.entries(defs)) {
    const value = values[name];
    if (value === undefined || value === null) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`tg ${path}: --${name} is not a flag value`);
    }
    if (def.type === "positional") {
      throw new Error(`tg ${path}: positional --${name} is not supported`);
    }
    if (def.type === "boolean") {
      const fallback = "default" in def ? def.default === true : false;
      if (value === fallback) continue;
      words.push(value === true ? `--${name}` : `--no-${name}`);
      continue;
    }
    const text = String(value as string | number);
    if ("default" in def && text === String(def.default)) continue;
    words.push(`--${name}=${shellQuote(text)}`);
  }
  return words.join(" ");
}

/** One `next` entry */
export function nextCommand(
  path: string,
  defs: ArgsDef,
  values: Record<string, unknown>,
  why: string,
): NextCommand {
  return { command: tgCommand(path, defs, values), why };
}
