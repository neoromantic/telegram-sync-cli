import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { arch, cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isCyrillic, isLatin, lightStem } from "../src/utils/word-stems";
import { snowball, type Stemmer, stemText, tokens } from "./bench-search-stem";
import { buildDataset, generateMessage, rng } from "./bench-storage-data";

const { values: args } = parseArgs({
  options: {
    sentences: { type: "string", default: "50000" },
    messages: { type: "string", default: "100000" },
    seed: { type: "string", default: "1" },
    runs: { type: "string", default: "20" },
    cache: { type: "string" },
    "corpus-dir": { type: "string" },
    "no-tatoeba": { type: "boolean", default: false },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const SENTENCES = Number.parseInt(args.sentences ?? "", 10);
const MESSAGES = Number.parseInt(args.messages ?? "", 10);
const SEED = Number.parseInt(args.seed ?? "", 10);
const RUNS = Number.parseInt(args.runs ?? "", 10);
for (const [name, value] of Object.entries({ seed: SEED, runs: RUNS })) {
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(2);
  }
}
for (const [name, value] of Object.entries({ sentences: SENTENCES, messages: MESSAGES })) {
  if (!Number.isSafeInteger(value) || value < 0) {
    console.error(`--${name} must be 0 or a positive integer`);
    process.exit(2);
  }
}

interface FunctionDatabase {
  function(name: string, options: { deterministic: boolean }, fn: (text: string) => string): void;
}

if (!("function" in Database.prototype)) {
  console.error("bench:search needs Bun 1.4.4 or newer (Database.function)");
  process.exit(2);
}

// WARNING: set the data dir before importing src/db, so nothing can reach ~/.telegram-sync-cli.
const workDir = mkdtempSync(join(tmpdir(), "tg-bench-search-"));
process.env.TELEGRAM_SYNC_CLI_DATA_DIR = workDir;
process.env.TELEGRAM_SYNC_CLI_TELEMETRY = "0";

const { enableWal, initCacheSchema } = await import("../src/db/schema");
const { initSyncSchema } = await import("../src/db/sync-schema");
const { searchNewestFirst, toFts5Query } = await import("../src/db/messages-search");
const { findQueryForms } = await import("../src/db/word-forms");

function log(message: string) {
  console.error(`[bench:search] ${message}`);
}

function round(value: number, digits = 3) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function quantile(samples: number[], q: number) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

function mean(values: number[]) {
  const defined = values.filter((v) => !Number.isNaN(v));
  return defined.length ? defined.reduce((a, b) => a + b, 0) / defined.length : Number.NaN;
}

function shuffled<T>(items: readonly T[], r: () => number, take = items.length) {
  const out = [...items];
  const n = Math.min(take, out.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(r() * (out.length - i));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out.slice(0, n);
}

interface Corpus {
  name: string;
  private: boolean;
  texts: string[];
  languages: Language[];
}

type Language = "ru" | "en";

async function tatoeba(lang: "rus" | "eng") {
  const dir = args["corpus-dir"] ? resolve(args["corpus-dir"]) : join(workDir, "corpus");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${lang}_sentences.tsv.bz2`);
  if (!existsSync(file)) {
    log(`downloading Tatoeba ${lang} (CC BY 2.0 FR)`);
    const res = await fetch(
      `https://downloads.tatoeba.org/exports/per_language/${lang}/${lang}_sentences.tsv.bz2`,
    );
    if (!res.ok) throw new Error(`Tatoeba download failed: HTTP ${res.status}`);
    await Bun.write(file, res);
  }
  const text = await Bun.$`bunzip2 -c ${file}`.quiet().text();
  const all = text
    .split("\n")
    .map((line) => line.split("\t")[2])
    .filter((s): s is string => Boolean(s));
  return shuffled(all, rng(SEED * 7919 + lang.length), SENTENCES);
}

function madeUpTexts(count: number) {
  const data = buildDataset(SEED, count);
  const out: string[] = [];
  for (const chat of data.chats) {
    for (let i = 0; i < chat.size; i++) {
      const message = generateMessage(data, chat, i) as { message?: string };
      out.push(message.message ?? "");
    }
  }
  return out;
}

function cacheTexts(path: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query(
        "SELECT text FROM messages_cache WHERE text IS NOT NULL AND text <> '' ORDER BY date, rowid",
      )
      .values()
      .map(([text]) => text as string);
  } finally {
    db.close();
  }
}

interface Judged {
  lemmas: string[];
  top: string;
  content: boolean;
}

async function judge(words: string[]) {
  log(`judging ${words.length} distinct words with pymorphy3 and LemmInflect (local, uv)`);
  const proc = Bun.spawn(
    ["uv", "run", "-q", "--script", join(import.meta.dir, "bench-search-judge.py")],
    { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  );
  proc.stdin.write(`${words.join("\n")}\n`);
  await proc.stdin.end();
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error("the judge failed");
  const judged = new Map<string, Judged>();
  for (const line of out.split("\n")) {
    const [word, lemmas, top, content] = line.split("\t");
    if (!word || lemmas === undefined || top === undefined) continue;
    judged.set(word, { lemmas: lemmas.split(" "), top, content: content === "1" });
  }
  return judged;
}

const normLemma = (lemma: string) => lemma.toLowerCase().replaceAll("ё", "е");

type IndexName = "A" | "A_prefix" | "SNOW" | "SNOW_COL" | "LIGHT" | "TRI";

interface FtsTable {
  name: string;
  columns: string[];
  tokenize: string;
  extra?: string;
  values: (row: string) => string[];
}

const textOf = (row: string) => `COALESCE(${row}.text, '')`;

const INDEXES: Record<IndexName, FtsTable[]> = {
  A: [
    {
      name: "message_search",
      columns: ["text"],
      tokenize: "unicode61",
      values: (r) => [textOf(r)],
    },
  ],
  A_prefix: [
    {
      name: "message_search",
      columns: ["text"],
      tokenize: "unicode61",
      extra: "prefix='2 3'",
      values: (r) => [textOf(r)],
    },
  ],
  SNOW: [
    {
      name: "message_search",
      columns: ["text"],
      tokenize: "unicode61",
      values: (r) => [`tg_snowball(${textOf(r)})`],
    },
  ],
  SNOW_COL: [
    {
      name: "message_search",
      columns: ["text", "stems"],
      tokenize: "unicode61",
      values: (r) => [textOf(r), `tg_snowball(${textOf(r)})`],
    },
  ],
  LIGHT: [
    {
      name: "message_search",
      columns: ["text"],
      tokenize: "unicode61",
      values: (r) => [`tg_light(${textOf(r)})`],
    },
  ],
  TRI: [
    {
      name: "message_search",
      columns: ["text"],
      tokenize: "trigram remove_diacritics 1",
      values: (r) => [textOf(r)],
    },
    {
      name: "message_search_word",
      columns: ["text"],
      tokenize: "unicode61",
      values: (r) => [textOf(r)],
    },
  ],
};

const START_DATE = 1_700_000_000;

function registerStemFunctions(db: Database) {
  const fdb = db as unknown as FunctionDatabase;
  fdb.function("tg_snowball", { deterministic: true }, (text) => stemText(text, snowball));
  fdb.function("tg_light", { deterministic: true }, (text) => stemText(text, lightStem));
}

function ftsSize(db: Database) {
  const row = db
    .query("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'message_search%'")
    .get() as { bytes: number | null };
  return row.bytes ?? 0;
}

function timed<T>(fn: () => T) {
  const start = performance.now();
  const result = fn();
  return { ms: performance.now() - start, result };
}

interface IndexCost {
  index: IndexName;
  indexed_messages: number;
  bytes: number;
  bytes_per_message: number;
  rebuild_s: number;
  merge_s: number;
  history_messages_per_s: number;
  live_messages_per_s: number;
}

function buildIndex(corpus: Corpus, index: IndexName) {
  const path = join(workDir, `${corpus.name}-${index}.db`);
  const db = new Database(path);
  enableWal(db);
  initCacheSchema(db);
  initSyncSchema(db);
  registerStemFunctions(db);
  for (const [name] of db.query("SELECT name FROM sqlite_master WHERE type = 'trigger'").values()) {
    db.run(`DROP TRIGGER ${name as string}`);
  }
  db.run("DROP TABLE message_search");

  const n = corpus.texts.length;
  const holdout = Math.min(10_000, Math.floor(n / 10));
  const base = n - holdout;
  const insert = db.query(
    `INSERT INTO messages_cache (rowid, chat_id, message_id, text, date, fetched_at, raw_json)
     VALUES (?, ?, ?, ?, ?, 0, '{}')`,
  );
  const insertRow = (i: number) =>
    insert.run(i + 1, (i % 100) + 1, i + 1, corpus.texts[i] ?? "", START_DATE + i * 60);
  db.transaction(() => {
    for (let i = 0; i < base; i++) insertRow(i);
  })();

  const tables = INDEXES[index];
  for (const t of tables) {
    db.run(
      `CREATE VIRTUAL TABLE ${t.name} USING fts5(${t.columns.join(", ")},
        content='', contentless_delete=1, tokenize='${t.tokenize}'${t.extra ? `, ${t.extra}` : ""})`,
    );
    db.run(`INSERT INTO ${t.name}(${t.name}, rank) VALUES('automerge', 0)`);
  }
  const rebuild = timed(() =>
    db.transaction(() => {
      for (const t of tables) {
        db.run(
          `INSERT INTO ${t.name}(rowid, ${t.columns.join(", ")})
           SELECT rowid, ${t.values("m").join(", ")} FROM messages_cache m`,
        );
      }
    })(),
  );
  const optimize = () => {
    for (const t of tables) db.run(`INSERT INTO ${t.name}(${t.name}) VALUES('optimize')`);
  };
  const merge = timed(optimize);
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytes = ftsSize(db);

  db.run(`CREATE TRIGGER bench_ai AFTER INSERT ON messages_cache BEGIN
    ${tables
      .map(
        (t) =>
          `INSERT INTO ${t.name}(rowid, ${t.columns.join(", ")}) VALUES (new.rowid, ${t.values("new").join(", ")});`,
      )
      .join("\n")}
  END`);
  const historyCount = Math.floor(holdout / 2 / 100) * 100;
  const history = timed(() => {
    for (let p = 0; p < historyCount; p += 100) {
      db.transaction(() => {
        for (let i = base + p; i < base + p + 100; i++) insertRow(i);
      })();
    }
  });
  const live = timed(() => {
    for (let i = base + historyCount; i < n; i++) db.transaction(() => insertRow(i))();
  });
  optimize();
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");

  const cost: IndexCost = {
    index,
    indexed_messages: base,
    bytes,
    bytes_per_message: round(bytes / Math.max(1, base), 1),
    rebuild_s: round(rebuild.ms / 1000),
    merge_s: round(merge.ms / 1000),
    history_messages_per_s: Math.round(historyCount / (history.ms / 1000)),
    live_messages_per_s: Math.round((n - base - historyCount) / (live.ms / 1000)),
  };
  return {
    db,
    cost,
    close() {
      db.close();
      if (!args.keep)
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    },
  };
}

const quote = (word: string) => `"${word.replaceAll('"', '""')}"`;

function vocabulary(db: Database) {
  db.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS temp.bench_vocab USING fts5vocab(main, message_search, row)",
  );
  return {
    db,
    range: db.query("SELECT term FROM temp.bench_vocab WHERE term >= ? AND term < ?"),
    all: db.query("SELECT term FROM temp.bench_vocab"),
    counts: db.query("SELECT term, doc FROM temp.bench_vocab"),
  };
}

type Vocab = ReturnType<typeof vocabulary>;

function nextString(prefix: string) {
  const last = prefix.codePointAt(prefix.length - 1) ?? 0;
  return prefix.slice(0, -1) + String.fromCodePoint(last + 1);
}

function expand(vocab: Vocab, word: string, stem: Stemmer) {
  const target = stem(word);
  const cut = target.slice(0, -1);
  const yo = cut.search(/[её]/);
  const prefix = yo < 0 ? cut : cut.slice(0, yo);
  const prefixes = prefix ? [prefix] : yo === 0 ? ["е", "ё"] : [];
  const terms = prefixes.length
    ? prefixes.flatMap((p) => vocab.range.values(p, nextString(p)).map(([t]) => t as string))
    : vocab.all.values().map(([t]) => t as string);
  return terms.filter((t) => stem(t) === target);
}

interface Candidate {
  name: string;
  index: IndexName;
  description: string;
  rewrite(words: string[], vocab: Vocab): string | null;
  phrase?(words: string[]): string;
  complexity: number;
}

function orGroup(terms: string[]) {
  return terms.length ? `(${terms.map(quote).join(" OR ")})` : null;
}

function expandAll(words: string[], vocab: Vocab, stem: Stemmer) {
  const groups = words.map((w) => orGroup(expand(vocab, w, stem)));
  return groups.every((g) => g !== null) ? groups.join(" AND ") : null;
}

const CANDIDATES: Candidate[] = [
  {
    name: "A",
    index: "A",
    description: "today: exact words",
    rewrite: (ws) => ws.map(quote).join(" "),
    phrase: (ws) => quote(ws.join(" ")),
    complexity: 0,
  },
  {
    name: "B1",
    index: "A",
    description: "automatic prefix of the whole word",
    rewrite: (ws) => ws.map((w) => `${quote(w)}*`).join(" "),
    phrase: (ws) => `${quote(ws.join(" "))}*`,
    complexity: 1,
  },
  {
    name: "B1p",
    index: "A_prefix",
    description: "B1 with prefix='2 3' indexes",
    rewrite: (ws) => ws.map((w) => `${quote(w)}*`).join(" "),
    phrase: (ws) => `${quote(ws.join(" "))}*`,
    complexity: 3,
  },
  {
    name: "B2",
    index: "A",
    description: "prefix of the Snowball stem, query only",
    rewrite: (ws) => ws.map((w) => `${quote(snowball(w))}*`).join(" "),
    complexity: 1,
  },
  {
    name: "C",
    index: "TRI",
    description: "second trigram index, stem as substring",
    rewrite: (ws) =>
      ws
        .map((w) => {
          const s = snowball(w);
          return quote(s.length >= 3 ? s : w);
        })
        .join(" "),
    complexity: 4,
  },
  {
    name: "D1",
    index: "SNOW",
    description: "Snowball stems in index and query",
    rewrite: (ws) => ws.map((w) => quote(snowball(w))).join(" "),
    phrase: (ws) => quote(ws.map(snowball).join(" ")),
    complexity: 3,
  },
  {
    name: "D1+",
    index: "SNOW_COL",
    description: "D1 as an extra column next to the text",
    rewrite: (ws) => `stems : (${ws.map((w) => quote(snowball(w))).join(" ")})`,
    phrase: (ws) => `stems : ${quote(ws.map(snowball).join(" "))}`,
    complexity: 2,
  },
  {
    name: "D2",
    index: "LIGHT",
    description: "light stemmers in index and query",
    rewrite: (ws) => ws.map((w) => quote(lightStem(w))).join(" "),
    phrase: (ws) => quote(ws.map(lightStem).join(" ")),
    complexity: 3,
  },
  {
    name: "E1",
    index: "A",
    description: "query words expanded to index words with the same Snowball stem",
    rewrite: (ws, v) => expandAll(ws, v, snowball),
    complexity: 1,
  },
  {
    name: "E2",
    index: "A",
    description: "query words expanded with the light stemmers, as tg messages search --forms does",
    rewrite: (ws, v) => {
      const query = ws.join(" ");
      return toFts5Query(query, { forms: findQueryForms(v.db, query) });
    },
    complexity: 1,
  },
];

interface Query {
  words: string[];
  gold: Set<number>;
  band?: string;
  language: Language;
  set: string;
}

const BANDS: Array<[string, number, number]> = [
  ["2-4", 2, 4],
  ["5-29", 5, 29],
  ["30-299", 30, 299],
  ["300+", 300, Number.POSITIVE_INFINITY],
];

const SCRIPT: Record<Language, RegExp> = { ru: /^[а-яё]{3,}$/, en: /^[a-z]{3,}$/ };

function buildQueries(corpus: Corpus, judged: Map<string, Judged>) {
  const lemmaDocs = new Map<string, Set<number>>();
  const messageTokens = corpus.texts.map((t) => tokens(t));
  messageTokens.forEach((words, i) => {
    for (const w of words) {
      for (const lemma of judged.get(w)?.lemmas ?? [w]) {
        let docs = lemmaDocs.get(lemma);
        if (!docs) lemmaDocs.set(lemma, (docs = new Set()));
        docs.add(i + 1);
      }
    }
  });
  const goldOf = (lemma: string) => lemmaDocs.get(normLemma(lemma)) ?? new Set<number>();

  const queries: Query[] = [];
  for (const language of corpus.languages) {
    const r = rng(SEED * 31 + (language === "ru" ? 1 : 2));
    const dictionary = new Map<string, string>();
    const forms = new Map<string, Set<string>>();
    for (const words of messageTokens) {
      for (const w of words) {
        const j = judged.get(w);
        if (!j?.content || !SCRIPT[language].test(j.top)) continue;
        const key = normLemma(j.top);
        if (!dictionary.has(key)) dictionary.set(key, j.top);
        let set = forms.get(key);
        if (!set) forms.set(key, (set = new Set()));
        set.add(w);
      }
    }
    const lemmas = [...dictionary.keys()].sort();
    for (const [band, low, high] of BANDS) {
      const inBand = lemmas.filter((l) => {
        const df = goldOf(l).size;
        return df >= low && df <= high;
      });
      for (const lemma of shuffled(inBand, r, 100)) {
        const gold = goldOf(lemma);
        queries.push({
          words: [dictionary.get(lemma) as string],
          gold,
          band,
          language,
          set: "dictionary form",
        });
        const seen = [...(forms.get(lemma) ?? [])].sort();
        const form = seen[Math.floor(r() * seen.length)] as string;
        queries.push({ words: [form], gold, band, language, set: "any form" });
      }
    }
    const eligible = (w: string) => {
      const j = judged.get(w);
      return j?.content && SCRIPT[language].test(j.top) && goldOf(j.top).size >= 2 ? j : null;
    };
    const order = shuffled(
      messageTokens.map((_, i) => i),
      r,
    );
    let pairs = 0;
    for (const i of order) {
      if (pairs >= 200) break;
      const lemmasHere = [
        ...new Set((messageTokens[i] ?? []).map(eligible).flatMap((j) => (j ? [j.top] : []))),
      ];
      if (lemmasHere.length < 2) continue;
      const [a, b] = shuffled(lemmasHere, r, 2) as [string, string];
      const gold = new Set([...goldOf(a)].filter((id) => goldOf(b).has(id)));
      queries.push({ words: [a, b], gold, language, set: "two words" });
      pairs++;
    }
  }
  return { queries, lemmaDocs };
}

interface Scores {
  recall: number;
  precision: number;
  f1: number;
  zero: number;
  recall50: number;
  precision50: number;
}

function score(found: Set<number>, gold: Set<number>) {
  let hits = 0;
  for (const id of found) if (gold.has(id)) hits++;
  const top = [...found].sort((a, b) => b - a).slice(0, 50);
  const topHits = top.filter((id) => gold.has(id)).length;
  const recall = gold.size ? hits / gold.size : Number.NaN;
  const precision = found.size ? hits / found.size : Number.NaN;
  return {
    recall,
    precision,
    f1: found.size && hits ? (2 * recall * precision) / (recall + precision) : 0,
    zero: found.size ? 0 : 1,
    recall50: gold.size ? topHits / Math.min(50, gold.size) : Number.NaN,
    precision50: top.length ? topHits / top.length : Number.NaN,
  };
}

function retrieve(db: Database, match: string | null) {
  if (match === null) return new Set<number>();
  return new Set(
    db
      .query("SELECT rowid FROM message_search WHERE message_search MATCH ?")
      .values(match)
      .map(([id]) => id as number),
  );
}

function bootstrap(a: number[], b: number[], seed: number) {
  const pairs = a.flatMap((x, i) => {
    const y = b[i] as number;
    return Number.isNaN(x) || Number.isNaN(y) ? [] : [y - x];
  });
  if (!pairs.length) return { diff: Number.NaN, low: Number.NaN, high: Number.NaN, n: 0 };
  const r = rng(seed);
  const means: number[] = [];
  for (let s = 0; s < 2000; s++) {
    let sum = 0;
    for (let i = 0; i < pairs.length; i++) sum += pairs[Math.floor(r() * pairs.length)] as number;
    means.push(sum / pairs.length);
  }
  return {
    diff: round(mean(pairs)),
    low: round(quantile(means, 0.025)),
    high: round(quantile(means, 0.975)),
    n: pairs.length,
  };
}

const KEYBOARD: Record<Language, string[]> = {
  ru: ["йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю"],
  en: ["qwertyuiop", "asdfghjkl", "zxcvbnm"],
};

function neighbours(language: Language, ch: string) {
  const rows = KEYBOARD[language];
  const out: string[] = [];
  rows.forEach((row, y) => {
    const x = row.indexOf(ch === "ё" ? "е" : ch);
    if (x < 0) return;
    for (const [dy, dx] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, -1],
    ] as const) {
      const c = rows[y + dy]?.[x + dx];
      if (c) out.push(c);
    }
  });
  return out.length ? out : [...(rows[1] ?? "")];
}

const TYPO_KINDS = [
  "substitution",
  "deletion",
  "insertion",
  "transposition",
  "ё→е",
  "й→и",
] as const;
type TypoKind = (typeof TYPO_KINDS)[number];

function typo(word: string, language: Language, kind: TypoKind, r: () => number) {
  const chars = [...word];
  const at = (n: number) => Math.floor(r() * n);
  for (let attempt = 0; attempt < 20; attempt++) {
    const c = [...chars];
    if (kind === "substitution") {
      const p = at(c.length);
      const options = neighbours(language, c[p] as string);
      c[p] = options[at(options.length)] as string;
    } else if (kind === "deletion") {
      c.splice(at(c.length), 1);
    } else if (kind === "insertion") {
      const p = at(c.length + 1);
      const options = neighbours(language, c[Math.min(p, c.length - 1)] as string);
      c.splice(p, 0, options[at(options.length)] as string);
    } else if (kind === "transposition") {
      const p = at(c.length - 1);
      [c[p], c[p + 1]] = [c[p + 1] as string, c[p] as string];
    } else if (kind === "ё→е") {
      return word.replaceAll("ё", "е");
    } else {
      return word.replace("й", "и");
    }
    const out = c.join("");
    if (out !== word) return out;
  }
  return null;
}

function osa(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = Array.from({ length: m + 1 }, () => 0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = Array.from({ length: m + 1 }, () => 0);
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, (prev2[j - 2] as number) + 1);
      }
      cur[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m] as number;
}

function trigrams(word: string) {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function similarity(a: Set<string>, b: Set<string>) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const maxEdits = (word: string) => (word.length < 4 ? 0 : word.length < 8 ? 1 : 2);

type FuzzyMethod = "F-DL" | "F-TRI";

function correct(vocab: Vocab, word: string, method: FuzzyMethod) {
  const terms = vocab.all.values().map(([t]) => t as string);
  if (method === "F-DL") {
    const k = maxEdits(word);
    return k ? terms.filter((t) => osa(t, word, k) <= k) : [];
  }
  const grams = trigrams(word);
  return terms.filter((t) => similarity(trigrams(t), grams) >= 0.3);
}

function withForms(vocab: Vocab, terms: string[]) {
  const stems = new Set<string>();
  const out = new Set<string>();
  for (const t of terms) {
    const s = snowball(t);
    if (stems.has(s)) continue;
    stems.add(s);
    for (const f of expand(vocab, t, snowball)) out.add(f);
  }
  return [...out];
}

function summarise(rows: Scores[]) {
  return {
    queries: rows.length,
    recall: round(mean(rows.map((s) => s.recall))),
    precision: round(mean(rows.map((s) => s.precision))),
    f1: round(mean(rows.map((s) => s.f1))),
    zero_results: round(mean(rows.map((s) => s.zero))),
    recall_50: round(mean(rows.map((s) => s.recall50))),
    precision_50: round(mean(rows.map((s) => s.precision50))),
  };
}

interface Timing {
  median_ms: number;
  p95_ms: number;
  runs: number;
}

function time(fn: () => unknown) {
  fn();
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    median_ms: round(quantile(samples, 0.5)),
    p95_ms: round(quantile(samples, 0.95)),
    runs: RUNS,
  };
}

function pickShapes(corpus: Corpus, vocab: Vocab) {
  const counts = vocab.counts
    .values()
    .map(([term, doc]) => ({ term: term as string, doc: doc as number }))
    .filter((c) => /^\p{L}{3,}$/u.test(c.term))
    .sort((a, b) => b.doc - a.doc || (a.term < b.term ? -1 : 1));
  const n = corpus.texts.length;
  const closest = (target: number) =>
    counts.reduce((best, c) => (Math.abs(c.doc - target) < Math.abs(best.doc - target) ? c : best));
  const bigrams = new Map<string, number>();
  for (const text of corpus.texts) {
    const ws = tokens(text);
    for (let i = 0; i + 1 < ws.length; i++) {
      const a = ws[i] as string;
      const b = ws[i + 1] as string;
      if (a.length >= 3 && b.length >= 3)
        bigrams.set(`${a} ${b}`, (bigrams.get(`${a} ${b}`) ?? 0) + 1);
    }
  }
  const phrase = [...bigrams].reduce((best, e) => (e[1] > best[1] ? e : best), ["", 0])[0];
  return {
    rare: [closest(Math.max(1, n / 10_000)).term],
    common: [closest(n * 0.3).term],
    mid: [closest(n * 0.07).term],
    two_words: [counts[10]?.term ?? "", counts[100]?.term ?? ""],
    phrase: phrase.split(" "),
    docs: {
      rare: closest(Math.max(1, n / 10_000)).doc,
      common: closest(n * 0.3).doc,
      mid: closest(n * 0.07).doc,
    },
  };
}

interface FuzzyRow {
  base: "exact" | "forms";
  method: FuzzyMethod | "none";
  mode: "always" | "fallback" | "none";
  typo: Scores[];
  clean: Scores[];
  ms: number[];
}

function runFuzzy(db: Database, vocab: Vocab, queries: Query[], language: Language) {
  const r = rng(SEED * 101 + (language === "ru" ? 1 : 2));
  const kinds: TypoKind[] =
    language === "ru"
      ? [...TYPO_KINDS]
      : ["substitution", "deletion", "insertion", "transposition"];
  const items: Array<{ word: string; typed: string; gold: Set<number>; kind: TypoKind }> = [];
  let k = 0;
  for (const q of queries) {
    const word = q.words[0] as string;
    if ([...word].length < 4) continue;
    const applicable = kinds.filter(
      (kind) => (kind !== "ё→е" || word.includes("ё")) && (kind !== "й→и" || word.includes("й")),
    );
    const kind = applicable[k++ % applicable.length] as TypoKind;
    const typed = typo(word, language, kind, r);
    if (typed) items.push({ word, typed, gold: q.gold, kind });
  }

  const exactTerms = (w: string) => [w];
  const formTerms = (w: string) => expand(vocab, w, snowball);
  const corrections = new Map<string, { terms: string[]; ms: number }>();
  const corrected = (w: string, method: FuzzyMethod, base: "exact" | "forms") => {
    const key = `${method} ${base} ${w}`;
    let hit = corrections.get(key);
    if (!hit) {
      const start = performance.now();
      const found = correct(vocab, w, method);
      const terms = base === "forms" ? withForms(vocab, found) : found;
      hit = { terms, ms: performance.now() - start };
      corrections.set(key, hit);
    }
    return hit;
  };
  const rows: FuzzyRow[] = [];
  const byKind = new Map<string, Scores[]>();
  for (const base of ["exact", "forms"] as const) {
    const baseTerms = base === "exact" ? exactTerms : formTerms;
    const lookup = (terms: string[]) => retrieve(db, orGroup(terms));
    rows.push({
      base,
      method: "none",
      mode: "none",
      typo: items.map((it) => score(lookup(baseTerms(it.typed)), it.gold)),
      clean: items.map((it) => score(lookup(baseTerms(it.word)), it.gold)),
      ms: [],
    });
    for (const method of ["F-DL", "F-TRI"] as const) {
      for (const mode of ["always", "fallback"] as const) {
        const ms: number[] = [];
        const run = (w: string) => {
          const plain = baseTerms(w);
          const plainFound = lookup(plain);
          if (mode === "fallback" && plainFound.size) return plainFound;
          const fix = corrected(w, method, base);
          ms.push(fix.ms);
          return lookup([...new Set([...plain, ...fix.terms])]);
        };
        const typoScores = items.map((it) => score(run(it.typed), it.gold));
        rows.push({
          base,
          method,
          mode,
          typo: typoScores,
          clean: items.map((it) => score(run(it.word), it.gold)),
          ms,
        });
        if (base === "forms" && method === "F-DL" && mode === "always") {
          items.forEach((it, i) => {
            const list = byKind.get(it.kind) ?? [];
            list.push(typoScores[i] as Scores);
            byKind.set(it.kind, list);
          });
        }
      }
    }
  }
  return {
    language,
    typo_queries: items.length,
    vocabulary: vocab.all.values().length,
    rows: rows.map((row) => ({
      base: row.base,
      method: row.method,
      mode: row.mode,
      typo: summarise(row.typo),
      clean: summarise(row.clean),
      correction_ms: row.ms.length
        ? {
            median: round(quantile(row.ms, 0.5)),
            p95: round(quantile(row.ms, 0.95)),
            n: row.ms.length,
          }
        : null,
    })),
    forms_dl_always_recall_by_kind: Object.fromEntries(
      [...byKind].map(([kind, s]) => [
        kind,
        { n: s.length, recall: round(mean(s.map((x) => x.recall))) },
      ]),
    ),
  };
}

function corpusStats(corpus: Corpus) {
  const counts = new Map<string, number>();
  let chars = 0;
  let withText = 0;
  for (const text of corpus.texts) {
    if (text) withText++;
    chars += text.length;
    for (const w of tokens(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  let once = 0;
  let cyrillic = 0;
  let latin = 0;
  for (const [w, c] of counts) {
    if (c === 1) once++;
    if (isCyrillic(w)) cyrillic++;
    else if (isLatin(w)) latin++;
  }
  return {
    messages: corpus.texts.length,
    with_text: withText,
    text_mb: round(chars / 1e6, 2),
    chars_per_message: round(chars / Math.max(1, withText), 1),
    distinct_words: counts.size,
    words_once: once,
    distinct_cyrillic: cyrillic,
    distinct_latin: latin,
  };
}

async function main() {
  const corpora: Corpus[] = [];
  if (!args["no-tatoeba"] && SENTENCES > 0) {
    corpora.push({
      name: "tatoeba-ru",
      private: false,
      texts: await tatoeba("rus"),
      languages: ["ru"],
    });
    corpora.push({
      name: "tatoeba-en",
      private: false,
      texts: await tatoeba("eng"),
      languages: ["en"],
    });
  }
  if (MESSAGES > 0) {
    log(`generating ${MESSAGES} made-up messages`);
    corpora.push({ name: "made-up", private: false, texts: madeUpTexts(MESSAGES), languages: [] });
  }
  if (args.cache) {
    log("reading the cache's message texts read-only");
    corpora.push({
      name: "cache",
      private: true,
      texts: cacheTexts(resolve(args.cache)),
      languages: ["ru", "en"],
    });
  }

  const words = new Set<string>();
  for (const c of corpora)
    if (c.languages.length) for (const t of c.texts) for (const w of tokens(t)) words.add(w);
  const judged = words.size ? await judge([...words]) : new Map<string, Judged>();

  const probe = new Database(":memory:");
  const sqliteVersion = (probe.query("SELECT sqlite_version() AS v").get() as { v: string }).v;
  probe.close();

  const results = [];
  for (const corpus of corpora) {
    log(`${corpus.name}: ${corpus.texts.length} messages`);
    const { queries } = corpus.languages.length
      ? buildQueries(corpus, judged)
      : { queries: [] as Query[] };
    const costs: IndexCost[] = [];
    const quality: Record<string, Record<string, Scores[]>> = {};
    const latency: Record<string, Record<string, Timing | null>> = {};
    let shapes: ReturnType<typeof pickShapes> | null = null;
    let fuzzy: ReturnType<typeof runFuzzy>[] = [];
    for (const index of Object.keys(INDEXES) as IndexName[]) {
      log(`${corpus.name}: index ${index}`);
      const built = buildIndex(corpus, index);
      costs.push(built.cost);
      const vocab = vocabulary(built.db);
      if (index === "A") shapes = pickShapes(corpus, vocab);
      for (const candidate of CANDIDATES.filter((c) => c.index === index)) {
        for (const q of queries) {
          const key = `${q.language} / ${q.set}`;
          const byCandidate = (quality[key] ??= {});
          (byCandidate[candidate.name] ??= []).push(
            score(retrieve(built.db, candidate.rewrite(q.words, vocab)), q.gold),
          );
        }
        const s = shapes;
        if (s) {
          latency[candidate.name] = {
            rare: time(() =>
              searchNewestFirst(built.db, candidate.rewrite(s.rare, vocab) ?? '""', { limit: 50 }),
            ),
            common: time(() =>
              searchNewestFirst(built.db, candidate.rewrite(s.common, vocab) ?? '""', {
                limit: 50,
              }),
            ),
            mid: time(() =>
              searchNewestFirst(built.db, candidate.rewrite(s.mid, vocab) ?? '""', { limit: 50 }),
            ),
            two_words: time(() =>
              searchNewestFirst(built.db, candidate.rewrite(s.two_words, vocab) ?? '""', {
                limit: 50,
              }),
            ),
            phrase: candidate.phrase
              ? time(() =>
                  searchNewestFirst(built.db, candidate.phrase?.(s.phrase) ?? '""', { limit: 50 }),
                )
              : null,
          };
        }
      }
      if (index === "A") {
        fuzzy = corpus.languages.map((language) =>
          runFuzzy(
            built.db,
            vocab,
            queries.filter((q) => q.language === language && q.set === "dictionary form"),
            language,
          ),
        );
      }
      built.close();
    }

    const summary: Record<string, Record<string, unknown>> = {};
    for (const [key, byCandidate] of Object.entries(quality)) {
      const baseline = byCandidate.A ?? [];
      summary[key] = Object.fromEntries(
        Object.entries(byCandidate).map(([name, rows], i) => [
          name,
          {
            ...summarise(rows),
            recall_gain: bootstrap(
              baseline.map((s) => s.recall),
              rows.map((s) => s.recall),
              SEED + i,
            ),
            precision_change: bootstrap(
              baseline.map((s) => s.precision),
              rows.map((s) => s.precision),
              SEED + 100 + i,
            ),
            recall_by_band: Object.fromEntries(
              BANDS.map(([band]) => {
                const idx = queries
                  .filter((q) => `${q.language} / ${q.set}` === key)
                  .map((q, j) => (q.band === band ? j : -1))
                  .filter((j) => j >= 0);
                return [
                  band,
                  idx.length ? round(mean(idx.map((j) => rows[j]?.recall ?? Number.NaN))) : null,
                ];
              }),
            ),
          },
        ]),
      );
    }
    const baseCost = costs.find((c) => c.index === "A");
    results.push({
      corpus: corpus.name,
      stats: corpusStats(corpus),
      shapes: corpus.private ? { docs: shapes?.docs } : shapes,
      costs: costs.map((c) => ({
        ...c,
        size_vs_A: baseCost ? round(c.bytes / baseCost.bytes, 2) : null,
        rebuild_vs_A: baseCost ? round(c.rebuild_s / baseCost.rebuild_s, 2) : null,
        history_vs_A: baseCost
          ? round(c.history_messages_per_s / baseCost.history_messages_per_s, 2)
          : null,
        live_vs_A: baseCost ? round(c.live_messages_per_s / baseCost.live_messages_per_s, 2) : null,
      })),
      latency,
      quality: summary,
      fuzzy,
    });
  }

  const report = {
    benchmark: "bench:search",
    machine: { os: `${process.platform} ${release()}`, arch: arch(), cpu: cpus()[0]?.model ?? "" },
    bun: Bun.version,
    sqlite: sqliteVersion,
    seed: SEED,
    runs: RUNS,
    candidates: CANDIDATES.map(({ name, index, description, complexity }) => ({
      name,
      index,
      description,
      complexity,
    })),
    results,
  };
  const json = JSON.stringify(report, null, 2);
  if (args.out) await Bun.write(args.out, json);
  console.log(json);
  console.log(markdown(report));
}

function markdown(report: {
  bun: string;
  sqlite: string;
  machine: { os: string; arch: string; cpu: string };
  results: Array<{
    corpus: string;
    stats: ReturnType<typeof corpusStats>;
    costs: Array<IndexCost & { size_vs_A: number | null }>;
    latency: Record<string, Record<string, Timing | null>>;
    quality: Record<string, Record<string, unknown>>;
    fuzzy: ReturnType<typeof runFuzzy>[];
  }>;
}) {
  const lines = [
    `## bench:search (Bun ${report.bun}, SQLite ${report.sqlite}, ${report.machine.os} ${report.machine.arch}, ${report.machine.cpu})`,
  ];
  for (const r of report.results) {
    const s = r.stats;
    lines.push(
      "",
      `### ${r.corpus}: ${s.messages} messages, ${s.chars_per_message} chars each, ${s.distinct_words} distinct words (${s.words_once} once)`,
      "",
      "| Index | B/message | vs A | Rebuild s | Merge s | History msg/s | Live msg/s |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...r.costs.map(
        (c) =>
          `| ${c.index} | ${c.bytes_per_message} | ${c.size_vs_A} | ${c.rebuild_s} | ${c.merge_s} | ${c.history_messages_per_s} | ${c.live_messages_per_s} |`,
      ),
      "",
      "| Candidate | rare | common | mid | two words | phrase |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...Object.entries(r.latency).map(
        ([name, t]) =>
          `| ${name} | ${["rare", "common", "mid", "two_words", "phrase"]
            .map((k) => (t[k] ? `${t[k]?.median_ms} / ${t[k]?.p95_ms}` : "n/a"))
            .join(" | ")} |`,
      ),
    );
    for (const [key, byCandidate] of Object.entries(r.quality)) {
      lines.push(
        "",
        `#### ${key}`,
        "",
        "| Candidate | Queries | Recall | Precision | F1 | No result | R@50 | P@50 | Recall gain [95% CI] | Precision change [95% CI] |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
        ...Object.entries(byCandidate).map(([name, v]) => {
          const q = v as ReturnType<typeof summarise> & {
            recall_gain: ReturnType<typeof bootstrap>;
            precision_change: ReturnType<typeof bootstrap>;
          };
          const ci = (b: ReturnType<typeof bootstrap>) => `${b.diff} [${b.low}, ${b.high}]`;
          return `| ${name} | ${q.queries} | ${q.recall} | ${q.precision} | ${q.f1} | ${q.zero_results} | ${q.recall_50} | ${q.precision_50} | ${ci(q.recall_gain)} | ${ci(q.precision_change)} |`;
        }),
      );
    }
    for (const f of r.fuzzy) {
      lines.push(
        "",
        `#### Typos, ${f.language}: ${f.typo_queries} queries, vocabulary ${f.vocabulary}`,
        "",
        "| Base | Method | Mode | Typo recall | Typo precision | Typo no result | Clean recall | Clean precision | Correction ms p50 / p95 |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ...f.rows.map(
          (row) =>
            `| ${row.base} | ${row.method} | ${row.mode} | ${row.typo.recall} | ${row.typo.precision} | ${row.typo.zero_results} | ${row.clean.recall} | ${row.clean.precision} | ${row.correction_ms ? `${row.correction_ms.median} / ${row.correction_ms.p95}` : ""} |`,
        ),
      );
    }
  }
  return lines.join("\n");
}

try {
  await main();
} finally {
  if (!args.keep) rmSync(workDir, { recursive: true, force: true });
}
