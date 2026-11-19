import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttachmentInfo, MediaThumb } from "./attachment";
import {
  acquireDownloadLock,
  cachedFileName,
  cleanMedia,
  DownloadLockTimeoutError,
  findCachedFile,
  LOCK_STALE_MS,
  mediaPaths,
  PARTIAL_MAX_AGE_MS,
  readMediaUsage,
  sanitizeFileName,
  thumbPaths,
  touch,
} from "./media-cache";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

function attachment(overrides: Partial<AttachmentInfo> = {}) {
  const result: AttachmentInfo = {
    kind: "document",
    source: "message",
    fileName: "report.pdf",
    mimeType: "application/pdf",
    size: 4,
    duration: null,
    width: null,
    height: null,
    uniqueFileId: "AgADBAADexample",
    groupedId: null,
    ...overrides,
  };
  return result;
}

const thumb: MediaThumb = {
  type: "m",
  width: 320,
  height: 240,
  size: 3,
  uniqueFileId: "AQADBAADexamplem",
};

let mediaDir: string;

beforeEach(() => {
  mediaDir = mkdtempSync(join(tmpdir(), "tg-media-cache-"));
});

afterEach(() => {
  rmSync(mediaDir, { recursive: true, force: true });
});

function place(path: string, size: number, ageMs = 0) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, Buffer.alloc(size, 7));
  const at = new Date(NOW - ageMs);
  utimesSync(path, at, at);
  return path;
}

const DEAD_PID = 999_999;

function writeLock(folder: string, pid: number, ageMs = 0) {
  mkdirSync(join(mediaDir, folder), { recursive: true });
  const path = join(mediaDir, folder, ".lock");
  writeFileSync(path, String(pid));
  if (ageMs > 0) {
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
  }
  return path;
}

describe("sanitizeFileName", () => {
  it("keeps only the base name", () => {
    expect(sanitizeFileName("../../x.txt")).toBe("x.txt");
    expect(sanitizeFileName("folder\\sub\\notes.txt")).toBe("notes.txt");
  });

  it("replaces control and reserved characters", () => {
    expect(sanitizeFileName("a\u0000b\u001fc\u007f.txt")).toBe("a_b_c_.txt");
    expect(sanitizeFileName('what?*:<>|".txt')).toBe("what_______.txt");
  });

  it("replaces bidi controls that would hide the real extension", () => {
    expect(sanitizeFileName("report\u202efdp.exe")).toBe("report_fdp.exe");
    expect(sanitizeFileName("a\u2066b\u2069\u200e\u200f\u061c.txt")).toBe("a_b____.txt");
  });

  it("prefixes Windows device names", () => {
    expect(sanitizeFileName("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFileName("lpt1")).toBe("_lpt1");
    expect(sanitizeFileName("console.txt")).toBe("console.txt");
  });

  it("drops leading dots and trailing dots and spaces", () => {
    expect(sanitizeFileName(".hidden")).toBe("hidden");
    expect(sanitizeFileName("  notes. . ")).toBe("notes");
    expect(sanitizeFileName("...")).toBeNull();
    expect(sanitizeFileName("   ")).toBeNull();
  });

  it("cuts a long name to 200 bytes and keeps the extension", () => {
    const name = sanitizeFileName(`${"a".repeat(300)}.pdf`)!;
    expect(new TextEncoder().encode(name).length).toBe(200);
    expect(name.endsWith(".pdf")).toBe(true);

    const cyrillic = sanitizeFileName(`${"я".repeat(150)}.txt`)!;
    expect(new TextEncoder().encode(cyrillic).length).toBeLessThanOrEqual(200);
    expect(cyrillic.endsWith("я.txt")).toBe(true);
  });

  it("normalizes to NFC", () => {
    expect(sanitizeFileName("йод.txt".normalize("NFD"))).toBe("йод.txt".normalize("NFC"));
  });
});

describe("cache names and paths", () => {
  it("uses the sender's name, else <kind>.<ext>", () => {
    expect(cachedFileName(attachment())).toBe("report.pdf");
    expect(cachedFileName(attachment({ fileName: "..." }))).toBe("file.pdf");
    expect(
      cachedFileName(attachment({ kind: "photo", fileName: null, mimeType: "image/jpeg" })),
    ).toBe("photo.jpg");
  });

  it("never gives a file a preview's name", () => {
    expect(cachedFileName(attachment({ fileName: "thumb-m.jpg" }))).toBe("_thumb-m.jpg");
  });

  it("keeps the file, its partial download and the lock in one folder", () => {
    const paths = mediaPaths(mediaDir, attachment());
    const dir = join(mediaDir, "AgADBAADexample");
    expect(paths).toEqual({
      dir,
      file: join(dir, "report.pdf"),
      part: join(dir, ".report.pdf.part"),
      lock: join(dir, ".lock"),
    });
  });

  it("puts a preview in its file's folder", () => {
    expect(thumbPaths(mediaDir, attachment(), thumb).file).toBe(
      join(mediaDir, "AgADBAADexample", "thumb-m.jpg"),
    );
    expect(thumbPaths(mediaDir, attachment({ kind: "sticker" }), thumb).file).toBe(
      join(mediaDir, "AgADBAADexample", "thumb-m.webp"),
    );
  });

  it("refuses a unique file ID that is not a safe folder name", () => {
    expect(() => mediaPaths(mediaDir, attachment({ uniqueFileId: "../x" }))).toThrow(
      "Invalid unique file ID",
    );
  });
});

describe("findCachedFile and touch", () => {
  it("finds a file of any size when the size is unknown, and never a folder", () => {
    const path = place(join(mediaDir, "u1", "a.bin"), 4);
    expect(findCachedFile(path, null)).toEqual({ path, size: 4 });
    expect(findCachedFile(join(mediaDir, "u1"), null)).toBeNull();
  });

  it("touch never throws for a file it cannot touch", () => {
    expect(() => touch(join(mediaDir, "missing"))).not.toThrow();
  });
});

describe("acquireDownloadLock", () => {
  it("writes this pid and removes the lock on release", async () => {
    const lock = join(mediaDir, "u1", ".lock");
    const release = await acquireDownloadLock(lock);
    expect(await Bun.file(lock).text()).toBe(String(process.pid));
    release();
    expect(existsSync(lock)).toBe(false);
    release();
  });

  it("takes over a dead holder's lock", async () => {
    const lock = writeLock("u1", DEAD_PID);
    const release = await acquireDownloadLock(lock, {
      isAlive: (pid) => pid !== DEAD_PID,
    });
    expect(await Bun.file(lock).text()).toBe(String(process.pid));
    release();
  });

  it("waits while a live holder has it", async () => {
    const lock = writeLock("u1", 4242);
    let alive = true;
    let acquired = false;
    let checks = 0;
    const { promise: checkedThrice, resolve: thirdCheck } = Promise.withResolvers<void>();
    const pending = acquireDownloadLock(lock, {
      isAlive: () => {
        checks += 1;
        if (checks === 3) thirdCheck();
        return alive;
      },
      pollMs: 5,
    }).then((release) => {
      acquired = true;
      return release;
    });
    await checkedThrice;
    expect(acquired).toBe(false);

    alive = false;
    const release = await pending;
    expect(acquired).toBe(true);
    release();
  });

  it("ends with the abort reason", async () => {
    const lock = writeLock("u1", 4242);
    const controller = new AbortController();
    const pending = acquireDownloadLock(lock, {
      isAlive: () => true,
      pollMs: 5,
      signal: controller.signal,
    });
    controller.abort(new Error("interrupted"));
    await expect(pending).rejects.toThrow("interrupted");
    expect(await Bun.file(lock).text()).toBe("4242");
  });

  it("takes over a lock its holder stopped refreshing, even with a live pid", async () => {
    const lock = writeLock("u1", 4242, LOCK_STALE_MS + 1_000);
    const release = await acquireDownloadLock(lock, {
      isAlive: () => true,
      waitMs: 0,
    });
    expect(await Bun.file(lock).text()).toBe(String(process.pid));
    expect(readdirSync(join(mediaDir, "u1"))).toEqual([".lock"]);
    release();
  });

  it("refreshes the lock while it holds it", async () => {
    const lock = join(mediaDir, "u1", ".lock");
    vi.useFakeTimers();
    try {
      const release = await acquireDownloadLock(lock, { refreshMs: 5 });
      const old = new Date(Date.now() - LOCK_STALE_MS);
      utimesSync(lock, old, old);
      vi.advanceTimersByTime(30);
      expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(LOCK_STALE_MS / 2);
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up waiting after waitMs with the lock and its holder", async () => {
    const lock = writeLock("u1", 4242);
    const err = await acquireDownloadLock(lock, {
      isAlive: () => true,
      waitMs: 0,
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(err).toBeInstanceOf(DownloadLockTimeoutError);
    expect(err).toMatchObject({ lockPath: lock, holder: 4242 });
    expect(await Bun.file(lock).text()).toBe("4242");
  });

  it("never removes a live lock another process took over meanwhile", async () => {
    const lock = writeLock("u1", DEAD_PID);
    let tookOver = false;
    const isAlive = (pid: number) => {
      if (pid === DEAD_PID && !tookOver) {
        tookOver = true;
        writeFileSync(lock, "4242");
      }
      return pid === 4242;
    };
    const err = await acquireDownloadLock(lock, { isAlive, waitMs: 0 }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(err).toBeInstanceOf(DownloadLockTimeoutError);
    expect(await Bun.file(lock).text()).toBe("4242");
    expect(readdirSync(join(mediaDir, "u1"))).toEqual([".lock"]);
  });

  it("leaves a lock that is no longer this process's on release", async () => {
    const lock = join(mediaDir, "u1", ".lock");
    const release = await acquireDownloadLock(lock);
    writeFileSync(lock, "4242");
    release();
    expect(existsSync(lock)).toBe(true);
  });
});

describe("readMediaUsage", () => {
  it("counts files and previews, partial downloads apart, and no lock", () => {
    place(join(mediaDir, "u1", "report.pdf"), 10);
    place(join(mediaDir, "u1", "thumb-m.jpg"), 3);
    place(join(mediaDir, "u2", ".video.mp4.part"), 7);
    writeLock("u2", process.pid);
    place(join(mediaDir, "u3", "backup.part"), 5);

    expect(readMediaUsage(mediaDir)).toEqual({
      bytes: 18,
      files: 3,
      partial_bytes: 7,
      partial_files: 1,
    });
  });
});

describe("cleanMedia", () => {
  const base = {
    now: NOW,
    partialMaxAgeMs: PARTIAL_MAX_AGE_MS,
    isAlive: (pid: number) => pid !== DEAD_PID,
  };

  it("combines uniqueFileIds with olderThan", () => {
    const old = place(join(mediaDir, "mine", "old.pdf"), 10, 40 * DAY);
    const recent = place(join(mediaDir, "mine2", "new.pdf"), 5, DAY);

    cleanMedia(mediaDir, {
      ...base,
      olderThan: NOW - 30 * DAY,
      uniqueFileIds: new Set(["mine", "mine2"]),
    });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("skips a folder a live download holds, takes a dead one's lock", () => {
    const busy = place(join(mediaDir, "busy", "a.pdf"), 10);
    const busyPart = place(join(mediaDir, "busy", ".b.zip.part"), 4, 2 * DAY);
    writeLock("busy", process.pid);
    place(join(mediaDir, "dead", "c.pdf"), 3);
    writeLock("dead", DEAD_PID);

    const result = cleanMedia(mediaDir, { ...base, all: true });
    expect(result).toMatchObject({
      removedFiles: 1,
      removedPartialFiles: 0,
      keptFiles: 1,
    });
    expect(existsSync(busy)).toBe(true);
    expect(existsSync(busyPart)).toBe(true);
    expect(existsSync(join(mediaDir, "dead"))).toBe(false);
  });

  it("cleans a folder whose lock its holder stopped refreshing", () => {
    place(join(mediaDir, "gone", "a.pdf"), 10);
    writeLock("gone", process.pid, LOCK_STALE_MS + 1_000);

    const result = cleanMedia(mediaDir, { ...base, all: true });
    expect(result).toMatchObject({ removedFiles: 1, keptFiles: 0 });
    expect(existsSync(join(mediaDir, "gone"))).toBe(false);
  });

  it("removes empty folders", () => {
    mkdirSync(join(mediaDir, "empty"));
    cleanMedia(mediaDir, base);
    expect(existsSync(join(mediaDir, "empty"))).toBe(false);
  });
});
