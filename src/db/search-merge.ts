import type { Database } from "bun:sqlite";

import type { BatchLimits } from "./background-migrations";

const MERGE_STEP_PAGES = 16;

export type SearchMergeMode = "rest" | "bulk";

const LEVEL_SEGMENTS: Record<SearchMergeMode, number> = { rest: 2, bulk: 4 };

const DELETED_SHARE = 0.1;

const STRUCTURE_ROWID = 10;

const SET_OPTION = "INSERT INTO message_search(message_search, rank) VALUES(?, ?)";

function readOption(db: Database, option: string) {
  const row = db.query("SELECT v FROM message_search_config WHERE k = ?").get(option) as {
    v: unknown;
  } | null;
  return row?.v;
}

/**
 * Stop merges inside writes, once per cache: a cache that has `automerge` 0
 * is only read. Only contentless-delete tables (SQLite 3.43+) know
 * `deletemerge`; caches from 0.9.0 to 0.11.1 have it at 0 already (#141).
 */
export function configureSearchMerges(db: Database, contentless: boolean) {
  if (readOption(db, "automerge") === 0) return;
  db.transaction(() => {
    if (readOption(db, "automerge") === 0) return;
    const set = db.query(SET_OPTION);
    set.run("usermerge", LEVEL_SEGMENTS.rest);
    if (contentless) set.run("deletemerge", 0);
    set.run("automerge", 0);
  }).immediate();
}

const merged = new WeakMap<Database, { mode: SearchMergeMode; structure: Uint8Array }>();

function readStructure(db: Database) {
  const row = db
    .query("SELECT block FROM message_search_data WHERE id = ?")
    .get(STRUCTURE_ROWID) as { block: Uint8Array };
  return row.block;
}

function readVarint(bytes: Uint8Array, at: number) {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i] ?? 0;
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) {
      const result: [number, number] = [value, at + i + 1];
      return result;
    }
  }
  const result: [number, number] = [value * 256 + (bytes[at + 8] ?? 0), at + 9];
  return result;
}

function deletedShare(structure: Uint8Array) {
  const counted = [0xff, 0, 0, 1].every((byte, i) => structure[4 + i] === byte);
  if (!counted) return 0;
  let at = 8;
  const next = () => {
    const [value, end] = readVarint(structure, at);
    at = end;
    return value;
  };
  const levels = next();
  next();
  next();
  let entries = 0;
  let deleted = 0;
  for (let level = 0; level < levels; level++) {
    next();
    const segments = next();
    for (let segment = 0; segment < segments; segment++) {
      for (let field = 0; field < 6; field++) next();
      deleted += next();
      entries += next();
    }
  }
  return entries > 0 ? deleted / entries : 0;
}

/** Whether the index may have segments to merge in `mode`; only reads */
export function isSearchMergeDue(db: Database, mode: SearchMergeMode = "rest") {
  const last = merged.get(db);
  if (last?.mode !== mode) return true;
  return !Buffer.from(readStructure(db)).equals(last.structure);
}

export interface MergeBatchResult {
  /** 'merge' steps that did work */
  steps: number;
  /** Whether nothing is left to merge */
  finished: boolean;
}

/**
 * Merge in one write transaction: 'merge' steps until FTS5 finds nothing
 * to merge, and none started after `maxMs`. FTS5 says a step did nothing
 * when it changed fewer than 2 rows. In 'rest', a tenth of the entries
 * deleted then starts a merge of every segment into one (a negative
 * 'merge'), which the next steps go on with. A stop between batches loses
 * nothing: FTS5 records a merge in progress and the next step continues it.
 */
export function runSearchMergeBatch(
  db: Database,
  limits: Pick<BatchLimits, "maxMs" | "now">,
  mode: SearchMergeMode = "rest",
) {
  const now = limits.now ?? Date.now;
  const merge = db.query(`INSERT INTO message_search(message_search, rank) VALUES('merge', ?)`);
  const changes = db.query("SELECT total_changes() AS n");
  const totalChanges = () => (changes.get() as { n: number }).n;

  return db
    .transaction(() => {
      if (readOption(db, "usermerge") !== LEVEL_SEGMENTS[mode]) {
        db.query(SET_OPTION).run("usermerge", LEVEL_SEGMENTS[mode]);
      }
      const started = now();
      let steps = 0;
      let mergeAll = mode === "rest";
      for (;;) {
        const before = totalChanges();
        merge.run(MERGE_STEP_PAGES);
        if (totalChanges() - before < 2) {
          const structure = readStructure(db);
          if (!mergeAll || deletedShare(structure) < DELETED_SHARE) {
            merged.set(db, { mode, structure });
            return { steps, finished: true };
          }
          mergeAll = false;
          merge.run(-MERGE_STEP_PAGES);
        }
        steps += 1;
        if (now() - started >= limits.maxMs) return { steps, finished: false };
      }
    })
    .immediate();
}
