import { describe, expect, it } from "bun:test";
import { encode } from "uqr";
import { renderQr } from "../utils/qr";

const URL = `tg://login?token=${"A".repeat(43)}`;

const HALVES: Record<string, [boolean, boolean]> = {
  " ": [false, false],
  "▀": [true, false],
  "▄": [false, true],
  "█": [true, true],
};

function readModules(text: string) {
  const rows: boolean[][] = [];
  for (const line of text.split("\n")) {
    expect(line.startsWith("\x1b[30;47m")).toBe(true);
    expect(line.endsWith("\x1b[0m")).toBe(true);
    const cells = Array.from(line.slice("\x1b[30;47m".length, -"\x1b[0m".length));
    const halves = cells.map((cell) => {
      const half = HALVES[cell];
      if (!half) throw new Error(`Unexpected character ${cell}`);
      return half;
    });
    rows.push(halves.map(([upper]) => upper));
    rows.push(halves.map(([, lower]) => lower));
  }
  return rows;
}

describe("renderQr", () => {
  it("prints exactly the encoder's modules, inside a four-module quiet zone", () => {
    const { data, size } = encode(URL, { border: 4 });
    const modules = readModules(renderQr(URL));

    expect(modules.length).toBe(size + 1);
    expect(modules.slice(0, size)).toEqual(data);
    expect(modules[size]).not.toContain(true);

    expect(modules.slice(0, 4).flat()).not.toContain(true);
    expect(modules.slice(size - 4).flat()).not.toContain(true);
    for (const row of modules) {
      expect([...row.slice(0, 4), ...row.slice(-4)]).not.toContain(true);
    }
    expect(modules[4]?.slice(4, 11).every((dark) => dark)).toBe(true);
  });

  it("uses two module rows per line", () => {
    const { size } = encode(URL, { border: 4 });
    expect(renderQr(URL).split("\n").length).toBe((size + 1) / 2);
  });
});
