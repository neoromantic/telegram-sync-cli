import { describe, expect, it } from "bun:test";

import { isCyrillic, isLatin, lightStem } from "./word-stems";

function stems(words: string) {
  return [...new Set(words.split(" ").map(lightStem))];
}

describe("lightStem", () => {
  it("gives the case forms of a Russian noun and adjective one stem", () => {
    expect(stems("квартира квартиру квартиры квартире квартирой квартирами квартирах")).toEqual([
      "квартир",
    ]);
    expect(stems("новый новая новое новые нового новой новому новую новым новыми новых")).toEqual([
      "нов",
    ]);
  });

  it("reads ё as е", () => {
    expect(stems("ещё еще")).toEqual(["еще"]);
    expect(stems("ёлка елка ёлкой")).toEqual(["елк"]);
  });

  it("strips only the plural s of an English word", () => {
    expect(stems("meeting meetings")).toEqual(["meeting"]);
    expect(stems("city cities")).toEqual(["city"]);
    expect(lightStem("bus")).toBe("bus");
    expect(lightStem("class")).toBe("class");
    expect(lightStem("goes")).toBe("goes");
    expect(lightStem("is")).toBe("is");
  });

  it("leaves words of other scripts and numbers as they are", () => {
    for (const word of ["2026", "東京", "αβγ", "ab12"]) expect(lightStem(word)).toBe(word);
  });

  it("keeps the forms it does not know apart (known limit: verb forms, irregular forms)", () => {
    expect(lightStem("meet")).not.toBe(lightStem("met"));
    expect(lightStem("идти")).not.toBe(lightStem("шёл"));
    expect(lightStem("делать")).not.toBe(lightStem("делаю"));
  });

  it("merges some different words that share a stem (known limit)", () => {
    expect(lightStem("брат")).toBe(lightStem("брать"));
    expect(lightStem("лет")).toBe(lightStem("лето"));
    expect(lightStem("как")).toBe(lightStem("какой"));
    expect(lightStem("больше")).toBe(lightStem("большой"));
    expect(lightStem("series")).toBe("sery");
  });
});

describe("isCyrillic and isLatin", () => {
  it("tell the script of a word, Cyrillic first for a mixed one", () => {
    expect(isCyrillic("привет")).toBe(true);
    expect(isLatin("hello")).toBe(true);
    expect(isLatin("hello мир")).toBe(false);
    expect(isCyrillic("2026") || isLatin("2026")).toBe(false);
  });
});
