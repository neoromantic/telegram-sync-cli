import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMessagesCache } from "./messages-cache";
import { toFts5Query } from "./messages-search";
import { initCacheSchema } from "./schema";
import { initSyncSchema } from "./sync-schema";
import { findQueryForms, MAX_FORMS } from "./word-forms";
import { lightStem } from "../utils/word-stems";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

const CHAT_ID = 777;

function seed(db: Database, texts: string[], firstId = 1) {
  createMessagesCache(db).upsertBatch(
    texts.map((text, i) => ({
      chat_id: CHAT_ID,
      message_id: firstId + i,
      from_id: CHAT_ID,
      text,
      message_type: "text",
      date: 1_760_000_000 + i,
      raw_json: "{}",
    })),
  );
}

function cacheWith(...texts: string[]) {
  const db = createAccountCacheDb();
  seed(db, texts);
  return db;
}

function formsOf(db: Database, query: string) {
  return Object.fromEntries(findQueryForms(db, query));
}

describe("findQueryForms", () => {
  it("finds the index words with the query word's stem, the word first, then the most frequent", () => {
    const db = cacheWith(
      "новая квартира",
      "сдаю квартиру",
      "о квартире",
      "о квартире опять",
      "квартал рядом",
      "квартет играет",
    );
    expect(formsOf(db, "квартира")).toEqual({
      квартира: { words: ["квартира", "квартире", "квартиру"], cut: false },
    });
    expect(formsOf(db, "квартирой").квартирой!.words).toEqual(["квартире", "квартира", "квартиру"]);
  });

  it("matches an English word with and without its plural s", () => {
    const db = cacheWith("the meetings ran late", "one meeting", "meet me");
    expect(formsOf(db, "meeting")).toEqual({
      meeting: { words: ["meeting", "meetings"], cut: false },
    });
  });

  it("reads ё as е both ways, also at the start of a word", () => {
    const db = cacheWith("ещё раз", "еще раз", "ёлка", "елки");
    for (const query of ["еще", "ещё"]) {
      expect(formsOf(db, query)[query]!.words.toSorted()).toEqual(["еще", "ещё"]);
    }
    expect(formsOf(db, "ёлка").ёлка!.words.toSorted()).toEqual(["елки", "ёлка"]);
  });

  it("keeps a word with no other form, and finds none for a word not in the index", () => {
    const db = cacheWith("привет мир");
    expect(formsOf(db, "привет ничего")).toEqual({
      привет: { words: ["привет"], cut: false },
      ничего: { words: [], cut: false },
    });
  });

  it("folds case and Latin diacritics as the index does, keyed by the word as typed", () => {
    const db = cacheWith("Café Meetings");
    expect(formsOf(db, "CAFÉ meeting")).toEqual({
      CAFÉ: { words: ["cafe"], cut: false },
      meeting: { words: ["meetings"], cut: false },
    });
  });

  it("leaves out a word that is several index words, and a repeated word", () => {
    const db = cacheWith("send an e-mail", "mail it");
    expect(formsOf(db, "e-mail mail mail")).toEqual({
      mail: { words: ["mail"], cut: false },
    });
  });

  it(`keeps at most ${MAX_FORMS} forms, the most frequent, and says the group was cut`, () => {
    const endings = ["а", "у", "ы", "е", "ой", "ом", "ами", "ах", "ям", "ях", "ями", "ия", "ию"];
    const more = ["ая", "яя", "юю", "ею", "их", "ою", "ую", "ых", "ея", "ам", "ем", "ей", "ев"];
    const rest = ["ий", "им", "ое", "ов", "ые", "ый", "ым", "ми", "иям", "иях", "оях", "оям"];
    const words = [...endings, ...more, ...rest].map((ending) => `жзк${ending}`);
    expect(new Set(words.map(lightStem))).toEqual(new Set(["жзк"]));
    expect(words.length).toBeGreaterThan(MAX_FORMS);
    const db = cacheWith(...words, "жзкой жзкам", "жзкой");

    const { words: found, cut } = formsOf(db, "жзку").жзку!;
    expect(cut).toBe(true);
    expect(found).toHaveLength(MAX_FORMS);
    expect(found.slice(0, 3)).toEqual(["жзку", "жзкой", "жзкам"]);

    const typed = "Жзку";
    const group = toFts5Query(typed, { forms: findQueryForms(db, typed) }).split(" OR ");
    expect(group).toHaveLength(MAX_FORMS);
    expect(group[0]).toBe('("Жзку"');
  });
});

describe("toFts5Query with forms", () => {
  it("is an AND of OR groups, one quoted word where there is one form", () => {
    const db = cacheWith("сдаю квартиру", "квартира", 'say "hi"');
    const query = "квартира привет e-mail";
    expect(toFts5Query(query, { forms: findQueryForms(db, query) })).toBe(
      '("квартира" OR "квартиру") AND "привет" AND "e-mail"',
    );
    const one = "сдаю";
    expect(toFts5Query(one, { forms: findQueryForms(db, one) })).toBe('"сдаю"');
  });

  it("keeps the word as typed, which the index may split otherwise than its forms", () => {
    const db = cacheWith("это мой дом", "это мои\u0306 кот");
    const typed = "мои\u0306";
    const match = toFts5Query(typed, { forms: findQueryForms(db, typed) });
    expect(match).toBe('("мои\u0306" OR "мой")');
    const found = db
      .query("SELECT count(*) AS n FROM message_search WHERE message_search MATCH ?")
      .get(match) as { n: number };
    expect(found.n).toBe(2);
  });
});

describe("message_search_vocab", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("survives a rebuild that drops and recreates the index", () => {
    const db = new Database(":memory:");
    initCacheSchema(db);
    initSyncSchema(db, { contentlessSearch: false });
    seed(db, ["сдаю квартиру"]);
    initSyncSchema(db, { contentlessSearch: true });
    seed(db, ["квартира"], 2);
    expect(formsOf(db, "квартира").квартира!.words.toSorted()).toEqual(["квартира", "квартиру"]);
  });

  it("reads on a read-only, query_only connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-word-forms-"));
    dirs.push(dir);
    const path = join(dir, "cache.db");
    const writer = new Database(path);
    initCacheSchema(writer);
    initSyncSchema(writer);
    seed(writer, ["сдаю квартиру", "квартира"]);
    const reader = new Database(path, { readonly: true });
    reader.run("PRAGMA query_only = ON");
    expect(formsOf(reader, "квартира").квартира!.words.toSorted()).toEqual([
      "квартира",
      "квартиру",
    ]);
    reader.close();
    writer.close();
  });
});
