import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ErrorCodes } from "../../types";
import { sanitizeFileName } from "../../utils/media-cache";
import type { DownloadResult } from "./download-media";
import { checkDownloadInterrupted, DownloadInterruptedError, MediaError } from "./errors";

export const TEMPLATE_PLACEHOLDERS = ["chat", "id", "date", "name", "kind"] as const;

export type TemplateValues = Record<(typeof TEMPLATE_PLACEHOLDERS)[number], string>;

/** The name a batch gives each file in an --out directory: never two alike */
export const BATCH_NAME_TEMPLATE = "{id}_{name}";

const PLACEHOLDER = /\{([^{}]*)\}/g;

export function isTemplate(out: string) {
  return /\{[^{}]*\}/.test(out);
}

/** Placeholders of the template tg doesn't know */
export function unknownPlaceholders(template: string) {
  const known = new Set<string>(TEMPLATE_PLACEHOLDERS);
  return [...template.matchAll(PLACEHOLDER)]
    .map((match) => match[1] ?? "")
    .filter((name) => !known.has(name));
}

/** A message date (Unix seconds) as the UTC day, 2026-10-09 */
export function templateDate(date: number) {
  return new Date(date * 1000).toISOString().slice(0, 10);
}

/**
 * The template with its placeholders filled. Each path segment that holds
 * a placeholder is made a safe file name as a whole, so a value never adds
 * a folder; segments without one stay as written.
 */
export function expandTemplate(template: string, values: TemplateValues) {
  return template
    .split(/[/\\]/)
    .map((segment) => {
      if (!isTemplate(segment)) return segment;
      const filled = segment.replace(PLACEHOLDER, (_, name: keyof TemplateValues) => values[name]);
      return sanitizeFileName(filled) ?? "_";
    })
    .join("/");
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Where --out puts the file: into a directory (an existing one, or a path
 * ending in a slash, created) under the file's name, else at that path
 */
export function outTarget(out: string, fileName: string) {
  const isDir = /[/\\]$/.test(out) || statOrNull(out)?.isDirectory() === true;
  return resolve(isDir ? join(out, fileName) : out);
}

async function digest(path: string, signal?: AbortSignal) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    checkDownloadInterrupted(signal);
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

function fileKey(path: string) {
  const st = statSync(path, { bigint: true, throwIfNoEntry: false });
  return st && `${st.dev}:${st.ino}`;
}

const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]);

function publishNew(tmp: string, target: string) {
  try {
    linkSync(tmp, target);
    return;
  } catch (err) {
    if (!NO_HARD_LINKS.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
  try {
    copyFileSync(tmp, target, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      rmSync(target, { force: true });
    }
    throw err;
  }
}

async function publishCopy(
  source: string,
  target: string,
  overwrite: boolean,
  published?: Set<string>,
  signal?: AbortSignal,
) {
  const tmp = join(dirname(target), `.tg-${randomUUID()}.part`);
  try {
    await Bun.write(tmp, Bun.file(source));
    checkDownloadInterrupted(signal);
    if (overwrite) {
      const previous = published && fileKey(target);
      if (previous && published?.has(previous)) return false;
      renameSync(tmp, target);
    } else {
      publishNew(tmp, target);
    }
    if (published) published.add(fileKey(target)!);
    return true;
  } catch (err) {
    if (!overwrite && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export async function copyOut(
  result: DownloadResult,
  target: string,
  overwrite: boolean,
  published?: Set<string>,
  signal?: AbortSignal,
) {
  try {
    mkdirSync(dirname(target), { recursive: true });
    const exists = !overwrite && statSync(target, { throwIfNoEntry: false });
    if (!exists && (await publishCopy(result.path, target, overwrite, published, signal))) {
      return target;
    }
    const file = statSync(target, { throwIfNoEntry: false });
    if (
      published &&
      file?.isFile() &&
      file.size === result.size &&
      (await digest(target, signal)) === (await digest(result.path, signal))
    ) {
      checkDownloadInterrupted(signal);
      return target;
    }
  } catch (err) {
    if (err instanceof DownloadInterruptedError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new MediaError(ErrorCodes.GENERAL_ERROR, `Failed to write --out: ${message}`, {
      path: target,
    });
  }
  const key = fileKey(target);
  throw new MediaError(
    ErrorCodes.FILE_EXISTS,
    `File already exists: ${target}`,
    { path: target },
    key && published?.has(key)
      ? "use a distinct output path for each file"
      : "pass --overwrite or another --out",
  );
}
