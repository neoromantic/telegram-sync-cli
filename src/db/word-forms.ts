import type { Database } from "bun:sqlite";

import { fold, tokenize } from "../utils/search-snippet";
import { lightStem } from "../utils/word-stems";

/** At most this many words stand for one query word: the word as typed, then its most frequent forms */
export const MAX_FORMS = 30;

const MAX_YO_VARIANTS = 3;

/** The index words searched for one query word, and whether more forms were left out */
export interface WordForms {
  words: string[];
  cut: boolean;
}

/** For each plain word of a query, as typed, its forms in the index */
export type QueryForms = Map<string, WordForms>;

/** The vocabulary of message_search, one row per word: persistent, so read-only connections can read it */
export function createMessageSearchVocab(db: Database) {
  const exists = db
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_search_vocab'`)
    .get();
  if (exists) return;
  db.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS message_search_vocab USING fts5vocab(message_search, row)",
  );
}

function scanPrefixes(stem: string) {
  const letters = [...stem];
  let prefixes = [""];
  let yo = 0;
  for (const letter of letters.length > 1 ? letters.slice(0, -1) : letters) {
    if (letter === "е") {
      if (++yo > MAX_YO_VARIANTS) break;
      prefixes = prefixes.flatMap((p) => [`${p}е`, `${p}ё`]);
    } else {
      prefixes = prefixes.map((p) => p + letter);
    }
  }
  return prefixes;
}

function after(prefix: string) {
  const letters = [...prefix];
  const last = letters.pop()!.codePointAt(0)!;
  return letters.join("") + String.fromCodePoint(last + 1);
}

/**
 * The forms of each plain word of a query: the index's words with the same
 * light stem, found by a range scan of the vocabulary on the stem without
 * its last letter (with е and ё both, as the stem reads ё as е), then
 * filtered by stem. A one-letter word, which no other word stems to, is
 * only looked up as it is. A word that is several index words (`e-mail`)
 * is left out and matched as written.
 */
export function findQueryForms(db: Database, query: string) {
  const range = db.query("SELECT term, doc FROM message_search_vocab WHERE term >= ? AND term < ?");
  const exact = db.query("SELECT term, doc FROM message_search_vocab WHERE term = ?");
  const forms: QueryForms = new Map();
  for (const piece of query.split(/\s+/).filter(Boolean)) {
    const tokens = tokenize(piece);
    if (tokens.length !== 1 || forms.has(piece)) continue;
    const word = fold(tokens[0]!);
    const stem = lightStem(word);
    const found: Array<[string, number]> = [];
    if ([...word].length === 1) {
      found.push(...(exact.values(word) as Array<[string, number]>));
    } else {
      for (const prefix of scanPrefixes(stem)) {
        for (const [term, doc] of range.values(prefix, after(prefix)) as Array<[string, number]>) {
          if (lightStem(term) === stem) found.push([term, doc]);
        }
      }
    }
    found.sort(
      ([a, aDocs], [b, bDocs]) =>
        Number(b === word) - Number(a === word) || bDocs - aDocs || (a < b ? -1 : 1),
    );
    const limit = found[0]?.[0] === piece ? MAX_FORMS : MAX_FORMS - 1;
    forms.set(piece, {
      words: found.slice(0, limit).map(([term]) => term),
      cut: found.length > limit,
    });
  }
  return forms;
}
