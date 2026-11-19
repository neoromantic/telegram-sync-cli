import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DownloadResult } from "./download-media";
import { MediaError } from "./errors";
import { copyOut, lacksHardLinks, publishByCopy, type PublishedFiles, templateTarget } from "./out";
import { ErrorCodes } from "../../types";
import { fakeBytes } from "../../test/photo-message.test-utils";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "tg-media-out-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function cached(bytes: Uint8Array, messageId = 1) {
  const path = join(root, `cache-${messageId}.bin`);
  fs.writeFileSync(path, bytes);
  return {
    path,
    fileName: "example-notes.txt",
    mimeType: "text/plain",
    size: bytes.length,
    kind: "document",
    chatId: 5_550_001,
    messageId,
    date: 1_760_000_000,
    uniqueFileId: `unique-${messageId}`,
    groupedId: null,
    cached: true,
    resumedFrom: null,
    thumb: null,
  } satisfies DownloadResult;
}

async function refusal(promise: Promise<unknown>) {
  const err = await promise.then(
    () => {
      throw new Error("expected the copy to be refused");
    },
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(MediaError);
  return err as MediaError;
}

describe("publishing without hard links", () => {
  it.each(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"])(
    "treats %s from link as no hard links",
    (code) => {
      expect(lacksHardLinks(Object.assign(new Error(`${code}: link`), { code }))).toBe(true);
    },
  );

  it.each(["EEXIST", "EACCES", "ENOSPC"])("leaves %s from link as a failure", (code) => {
    expect(lacksHardLinks(Object.assign(new Error(`${code}: link`), { code }))).toBe(false);
  });

  it("copies the file to a new target", async () => {
    const bytes = fakeBytes(70_000);
    const tmp = join(root, "copy.part");
    const target = join(root, "notes.txt");
    fs.writeFileSync(tmp, bytes);

    const published: PublishedFiles = new Map();
    const writing = publishByCopy(tmp, target, published);
    const { dev, ino } = fs.statSync(target, { bigint: true });
    expect(published.get(`${dev}:${ino}`)).toBeInstanceOf(Promise);
    await writing;

    expect(Buffer.compare(fs.readFileSync(target), bytes)).toBe(0);
  });

  it("refuses to replace an existing target and leaves it as it was", async () => {
    const tmp = join(root, "copy.part");
    const target = join(root, "notes.txt");
    fs.writeFileSync(tmp, fakeBytes(70_000));
    fs.writeFileSync(target, "edited copy");

    await expect(publishByCopy(tmp, target)).rejects.toMatchObject({ code: "EEXIST" });
    expect(fs.readFileSync(target, "utf-8")).toBe("edited copy");
  });

  it("never unlinks the public name after an exclusive write fails", async () => {
    const target = join(root, "notes.txt");
    using remove = spyOn(fs, "rmSync");
    await expect(publishByCopy(join(root, "missing.part"), target)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(remove.mock.calls.some(([path]) => path === target)).toBe(false);
  });

  it("interrupts an exclusive copy once the public name exists", async () => {
    const result = cached(fakeBytes(70_000));
    const target = join(root, "notes.txt");
    const controller = new AbortController();
    const writing = publishByCopy(result.path, target, undefined, controller.signal);
    controller.abort();
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
  });

  it("waits for an identical export in the batch to finish copying", async () => {
    const result = cached(fakeBytes(70_000));
    const target = join(root, "notes.txt");
    const published: PublishedFiles = new Map();
    fs.writeFileSync(target, new Uint8Array());
    const { dev, ino } = fs.statSync(target, { bigint: true });
    const writer = Promise.withResolvers<void>();
    published.set(`${dev}:${ino}`, writer.promise);
    const second = copyOut(result, target, false, published);
    fs.copyFileSync(result.path, target);
    writer.resolve();
    expect(await second).toBe(target);
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(result.path));
  });
});

describe("copyOut collisions in a batch", () => {
  it("points at --overwrite for a file an earlier run left", async () => {
    const target = join(root, "out", "notes.txt");
    fs.mkdirSync(join(root, "out"));
    fs.writeFileSync(target, "edited copy");
    const err = await refusal(copyOut(cached(fakeBytes(70_000)), target, false, new Map()));
    expect(err.code).toBe(ErrorCodes.FILE_EXISTS);
    expect(err.suggestion).toContain("--overwrite");
  });

  it.each([false, true])(
    "asks for distinct paths when another file of the batch took it (overwrite %s)",
    async (overwrite) => {
      const target = join(root, "out", "notes.txt");
      const published: PublishedFiles = new Map();
      await copyOut(cached(fakeBytes(70_000), 1), target, overwrite, published);
      const err = await refusal(
        copyOut(cached(fakeBytes(70_000, 3), 2), target, overwrite, published),
      );
      expect(err.code).toBe(ErrorCodes.FILE_EXISTS);
      expect(err.suggestion).toBe("use a distinct output path for each file");
    },
  );
});

describe("templateTarget", () => {
  const values = {
    chat: "5550001",
    id: "7",
    date: "2026-10-09",
    name: "example-notes.txt",
    kind: "document",
  };

  it("puts the file into a directory a placeholder names", () => {
    fs.mkdirSync(join(root, "out", "5550001"), { recursive: true });
    expect(templateTarget(join(root, "out", "{chat}"), values, "7_example-notes.txt")).toBe(
      join(root, "out", "5550001", "7_example-notes.txt"),
    );
  });

  it.each(["directory", "file"])("refuses a placeholder part that is a symlink to a %s", (kind) => {
    const outside = join(root, "outside");
    if (kind === "directory") fs.mkdirSync(outside);
    else fs.writeFileSync(outside, "kept");
    fs.mkdirSync(join(root, "out"));
    fs.symlinkSync(outside, join(root, "out", "example-notes.txt"));

    expect(() => templateTarget(join(root, "out", "{name}"), values, "example-notes.txt")).toThrow(
      expect.objectContaining({
        code: ErrorCodes.GENERAL_ERROR,
        details: { path: join(root, "out", "example-notes.txt") },
      }),
    );
  });
});
