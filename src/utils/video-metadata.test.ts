import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readVideoMetadata } from "./video-metadata";
import { fakeMp4 } from "../test/video-file.test-utils";

describe("readVideoMetadata", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tg-video-metadata-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function place(name: string, bytes: Uint8Array) {
    const path = join(root, name);
    writeFileSync(path, bytes);
    return path;
  }

  it("reads the duration and frame size of an MP4 whose index comes first", async () => {
    const path = place("lake.mp4", fakeMp4({ duration: 13.1, width: 1920, height: 1080 }));
    expect(await readVideoMetadata(path)).toEqual({
      duration: 13.1,
      width: 1920,
      height: 1080,
      streamable: true,
    });
  });

  it("reads 64-bit times", async () => {
    const path = place("long.mp4", fakeMp4({ duration: 7.5, width: 640, height: 360, long: true }));
    expect(await readVideoMetadata(path)).toMatchObject({ duration: 7.5, width: 640, height: 360 });
  });

  it("swaps width and height of a video stored sideways", async () => {
    const path = place(
      "phone.mov",
      fakeMp4({ duration: 4, width: 1920, height: 1080, sideways: true }),
    );
    expect(await readVideoMetadata(path)).toMatchObject({ width: 1080, height: 1920 });
  });

  it("is not streamable when the data comes before the index", async () => {
    const path = place(
      "recorded.mp4",
      fakeMp4({ duration: 4, width: 640, height: 360, dataFirst: true }),
    );
    expect(await readVideoMetadata(path)).toMatchObject({ duration: 4, streamable: false });
  });

  it("is null for a file without a video track, another format and a cut file", async () => {
    const audio = fakeMp4({ duration: 4, width: 0, height: 0, handler: "soun" });
    expect(await readVideoMetadata(place("voice.m4a", audio))).toBeNull();
    expect(
      await readVideoMetadata(place("clip.webm", new TextEncoder().encode("made-up bytes"))),
    ).toBeNull();
    const whole = fakeMp4({ duration: 4, width: 640, height: 360 });
    expect(await readVideoMetadata(place("cut.mp4", whole.slice(0, 120)))).toBeNull();
  });
});
