import type { ArgsDef } from "citty";

/**
 * Parse named arguments from argv-style array into an object
 * Supports: --key value, --key=value, --nested.key value
 */
export function parseNamedArgs(args: Record<string, unknown>) {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (key === "_" || key === "--") continue;

    if (key.includes(".")) {
      setNestedValue(result, key.split("."), value);
    } else {
      result[key] = parseValue(value);
    }
  }

  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown) {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1];
  if (lastKey !== undefined) {
    current[lastKey] = parseValue(value);
  }
}

function parseValue(value: unknown) {
  if (value === undefined || value === null || typeof value !== "string") {
    return value;
  }

  let parsed: unknown = value;

  if (value === "true") {
    parsed = true;
  } else if (value === "false") {
    parsed = false;
  } else if (/^-?\d+$/.test(value)) {
    parsed = parseInt(value, 10);
  } else if (/^-?\d+\.\d+$/.test(value)) {
    parsed = parseFloat(value);
  } else if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
  }

  return parsed;
}

/**
 * Merge CLI arguments with JSON input
 */
export function mergeArgs(cliArgs: Record<string, unknown>, jsonInput?: string) {
  const parsed = parseNamedArgs(cliArgs);

  if (jsonInput) {
    try {
      const jsonArgs = JSON.parse(jsonInput);
      const result: Record<string, unknown> = { ...parsed, ...jsonArgs };
      return result;
    } catch (e) {
      throw new Error(`Invalid JSON input: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  return parsed;
}

const NEGATIVE_NUMBER = /^-\d+(\.\d+)?$/;

interface ArgDef {
  type?: string;
  alias?: string | string[];
}

/**
 * What in rawArgs the command would drop without a word, or null: a flag
 * it doesn't declare (`--acount 2` would run on the active account), or a
 * value it takes nowhere, such as the `false` of `--silent false`, which
 * citty reads as `--silent`. A negative number is a value, not a flag
 * (positionalChat).
 */
export function undeclaredArg(rawArgs: string[], defs: Record<string, ArgDef>) {
  const flags = new Map<string, ArgDef>();
  let positionals = 0;
  for (const [name, def] of Object.entries(defs)) {
    if (def.type === "positional") positionals++;
    else for (const key of [name, def.alias ?? []].flat()) flags.set(key, def);
  }
  let boolean: string | null = null;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--") break;
    if (!arg.startsWith("-") || NEGATIVE_NUMBER.test(arg)) {
      if (--positionals < 0) {
        return boolean
          ? `${boolean} takes no value: pass ${boolean} or ${boolean.replace(/^--/, "--no-")}, not ${boolean} ${arg}`
          : `Unexpected argument ${arg}`;
      }
      boolean = null;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    const long = flag.startsWith("--");
    let def: ArgDef | undefined;
    for (const name of long ? [flag.slice(2)] : flag.slice(1).split("")) {
      def = flags.get(name);
      if (!def && name.startsWith("no-") && flags.get(name.slice(3))?.type === "boolean") {
        def = flags.get(name.slice(3));
      }
      if (!def) return `Unknown option ${long ? "--" : "-"}${name}`;
    }
    boolean = def?.type === "boolean" && eq < 0 && long ? flag : null;
    if (def?.type !== "boolean" && eq < 0) i++;
  }
  return null;
}

/**
 * Values of method arguments written as `--name value` after the method.
 * citty reads an undeclared `--name` without `=` as `true` and leaves the value as a positional.
 */
export function spacedFlagValues(rawArgs: string[], method: string, args: Record<string, unknown>) {
  const values = new Map<string, string>();
  for (let i = rawArgs.indexOf(method) + 1; i < rawArgs.length - 1; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--") break;
    const next = rawArgs[i + 1]!;
    const name = arg.slice(2);
    if (
      arg.startsWith("--") &&
      args[name] === true &&
      (!next.startsWith("-") || NEGATIVE_NUMBER.test(next))
    ) {
      values.set(name, next);
      i++;
    }
  }
  return values;
}

function stringFlagSpellings(defs: ArgsDef) {
  const spellings = new Set<string>();
  for (const [name, def] of Object.entries(defs)) {
    if (def.type !== "string") continue;
    spellings.add(`--${name}`);
    spellings.add(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    const aliases = "alias" in def ? def.alias : undefined;
    for (const alias of [aliases ?? []].flat()) {
      spellings.add(alias.length === 1 ? `-${alias}` : `--${alias}`);
    }
  }
  return spellings;
}

/**
 * Every value of a flag given more than once (`--name a --name=b`), up to a
 * bare `--`. citty keeps only the last value of a repeated string flag.
 * The value of another string flag of `defs` is skipped, as citty takes it:
 * `--query --type=voice` searches for the text `--type=voice`.
 */
export function flagValues(rawArgs: string[], name: string, defs: ArgsDef) {
  const flag = `--${name}`;
  const takesValue = stringFlagSpellings(defs);
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--") break;
    if (arg === flag) {
      values.push(rawArgs[i + 1] ?? "");
      i++;
    } else if (arg.startsWith(`${flag}=`)) {
      values.push(arg.slice(flag.length + 1));
    } else if (takesValue.has(arg)) {
      i++;
    }
  }
  return values;
}

export const outputFormatArg = {
  type: "enum" as const,
  alias: "f",
  description: "Output format: json, pretty, or quiet",
  options: ["json", "pretty", "quiet"],
  default: "json",
};

/**
 * A chat given as a positional arg (`tg chats sync <chat>`). The parser reads
 * a marked ID such as -100… as flags and takes the value of a flag it doesn't
 * know (the global --format pretty) as the positional, so a marked ID in
 * rawArgs wins.
 */
export function positionalChat(value: unknown, rawArgs: string[]) {
  const input = rawArgs.find((arg) => /^-\d+$/.test(arg)) ?? value;
  return typeof input === "string" ? input.trim() : undefined;
}
