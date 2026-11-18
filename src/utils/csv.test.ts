import { describe, expect, it } from "bun:test";
import { stringify, stringifyTable } from "./csv";

describe("csv stringify", () => {
  it("stringifyTable delegates to stringify with headers", () => {
    const rows = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];

    const csv = stringifyTable(["id", "name"], rows);

    expect(csv.split("\n")[0]).toBe("id,name");
    expect(csv).toContain("1,Alice");
    expect(csv).toContain("2,Bob");
  });

  it("stringify respects includeHeader option", () => {
    const csv = stringify(
      [
        { id: 1, note: "hello" },
        { id: 2, note: "world" },
      ],
      ["id", "note"],
      { includeHeader: false },
    );

    expect(csv.startsWith("id")).toBe(false);
    expect(csv).toContain("1,hello");
  });
});
