import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DownloadResult } from "./download-media";
import { MediaError } from "./errors";
import { copyOut, lacksHardLinks, publishByCopy } from "./out";
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

    await publishByCopy(tmp, target);

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

  it("removes only a target it created when the copy fails", async () => {
    const missing = join(root, "missing.part");
    const taken = join(root, "taken.txt");
    const fresh = join(root, "fresh.txt");
    fs.writeFileSync(taken, "another writer");

    await expect(publishByCopy(missing, taken)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(publishByCopy(missing, fresh)).rejects.toMatchObject({ code: "ENOENT" });

    expect(fs.readFileSync(taken, "utf-8")).toBe("another writer");
    expect(fs.existsSync(fresh)).toBe(false);
  });
});

describe("copyOut collisions in a batch", () => {
  it("points at --overwrite for a file an earlier run left", async () => {
    const target = join(root, "out", "notes.txt");
    fs.mkdirSync(join(root, "out"));
    fs.writeFileSync(target, "edited copy");
    const err = await refusal(copyOut(cached(fakeBytes(70_000)), target, false, new Set()));
    expect(err.code).toBe(ErrorCodes.FILE_EXISTS);
    expect(err.suggestion).toContain("--overwrite");
  });

  it.each([false, true])(
    "asks for distinct paths when another file of the batch took it (overwrite %s)",
    async (overwrite) => {
      const target = join(root, "out", "notes.txt");
      const published = new Set<string>();
      await copyOut(cached(fakeBytes(70_000), 1), target, overwrite, published);
      const err = await refusal(
        copyOut(cached(fakeBytes(70_000, 3), 2), target, overwrite, published),
      );
      expect(err.code).toBe(ErrorCodes.FILE_EXISTS);
      expect(err.suggestion).toBe("use a distinct output path for each file");
    },
  );
});
