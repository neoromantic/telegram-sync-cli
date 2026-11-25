import type { Database } from "bun:sqlite";

import { fold, tokenize } from "../utils/search-snippet";
import { isStemmable, lightStem } from "../utils/word-stems";

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

/** The vocabularies of message_search and transcript_search, one row per word: persistent, so read-only connections can read them */
export function createSearchVocabs(db: Database) {
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const index of ["message_search", "transcript_search"]) {
    if (exists.get(`${index}_vocab`)) continue;
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${index}_vocab USING fts5vocab(${index}, row)`);
  }
}

function yoVariants(word: string) {
  let variants = [""];
  let yo = 0;
  for (const letter of word) {
    if (letter === "е" || letter === "ё") {
      if (++yo > MAX_YO_VARIANTS) break;
      variants = variants.flatMap((v) => [`${v}е`, `${v}ё`]);
    } else {
      variants = variants.map((v) => v + letter);
    }
  }
  return variants;
}

function after(prefix: string) {
  const letters = [...prefix];
  const last = letters.pop()!.codePointAt(0)!;
  return letters.join("") + String.fromCodePoint(last + 1);
}

/**
 * The forms of each plain word of a query: the words of the message and
 * transcript indexes with the same light stem, found by a range scan of
 * both vocabularies on the stem without its last letter (with е and ё
 * both, as the stem reads ё as е), then filtered by stem. A word whose
 * stem has at most two letters (`ok`, `не`), where that scan would read a
 * large part of the vocabulary, is looked up only as typed (with е and ё
 * both), and a word with no stem (`2026`) only as it is. A word that is
 * several index words (`e-mail`) is left out and matched as written.
 */
export function findQueryForms(db: Database, query: string) {
  const vocab = (where: string) =>
    db.query(`SELECT term, sum(doc) AS doc FROM (
      SELECT term, doc FROM message_search_vocab WHERE ${where}
      UNION ALL SELECT term, doc FROM transcript_search_vocab WHERE ${where}
    ) GROUP BY term`);
  const range = vocab("term >= ?1 AND term < ?2");
  const exact = vocab("term = ?1");
  const forms: QueryForms = new Map();
  for (const piece of query.split(/\s+/).filter(Boolean)) {
    const tokens = tokenize(piece);
    if (tokens.length !== 1 || forms.has(piece)) continue;
    const word = fold(tokens[0]!);
    const stem = lightStem(word);
    const found: Array<[string, number]> = [];
    if (!isStemmable(word)) {
      found.push(...(exact.values(word) as Array<[string, number]>));
    } else if ([...stem].length <= 2) {
      for (const variant of yoVariants(word)) {
        found.push(...(exact.values(variant) as Array<[string, number]>));
      }
    } else {
      for (const prefix of yoVariants([...stem].slice(0, -1).join(""))) {
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
