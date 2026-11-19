/**
 * Search benchmark for other word forms and typos (#92). Opt-in, never part of tests or CI.
 *
 *   bun run bench:search                        # Tatoeba ru + en and made-up messages
 *   bun run bench:search --cache <cache.db>     # also a real cache, opened read-only
 *
 * DEFINITION (fixed before any candidate was run; changes after results are listed at the end)
 *
 * Question 1: should a plain query find other forms of its words, and how?
 * Question 2 (separate): should a query find words with a typo?
 *
 * Candidates, each a different index or query rewrite; every one keeps unicode61 tokens:
 *   A    today: unicode61 index, every query word quoted ("w")
 *   B1   automatic prefix on the whole word ("w"*); B1p the same with FTS5 prefix='2 3' indexes
 *   B2   the word cut by the Snowball stemmer, then a prefix ("stem(w)"*); no index change
 *   C    a second, trigram index; each word as its Snowball stem, a substring (3+ characters)
 *   D1   Snowball (ru, en/Porter2) stems in the index and in the query; D1+ the same as an extra
 *        index column next to the unchanged text (same results, other cost)
 *   D2   light stemmers in the index and in the query: Savoy's light Russian stemmer (Lucene's
 *        RussianLightStemmer) and Lucene's minimal English (plural) stemmer, with ё read as е
 *   E1   no index change: each query word becomes an OR of the index's own words (fts5vocab)
 *        that have its Snowball stem; E2 the same with the light stemmers
 * Cyrillic words go to the Russian stemmer, Latin words to the English one, others stay.
 *
 * Corpora:
 *   - Quality: Tatoeba sentences (CC BY 2.0 FR), Russian and English, fetched at run time into
 *     a temp dir and never committed; a seeded sample of --sentences per language (50,000).
 *   - Cost: the storage benchmark's generator (`--messages`, 100,000 made-up messages; its
 *     Cyrillic words are syllables with random endings, fine for cost, not for quality) and
 *     the Tatoeba sample (real vocabulary).
 *   - Real cache (`--cache`): its message texts, opened read-only, copied to a temp dir; only
 *     aggregate numbers are printed, never a word or a message.
 *
 * Judge (gold standard, independent of every candidate): a dictionary lemmatizer run locally
 * with uv: pymorphy3 (OpenCorpora dictionary) for Cyrillic words, LemmInflect for Latin words.
 * A word's lemmas are all the lemmas the judge gives it (every parse, every part of speech);
 * ё is read as е. A message is relevant to a query word with lemma L when one of its words
 * has L among its lemmas; to a query of several words when that holds for every word.
 *
 * Queries, per language, seeded:
 *   - Single words: content-word lemmas (no prepositions, conjunctions, particles,
 *     interjections, pronouns; 3+ letters, the language's script) in four bands of message
 *     frequency: 2-4, 5-29, 30-299, 300+; up to 100 lemmas per band. Typed as the dictionary
 *     form (primary) and, separately, as a random form seen in the corpus.
 *   - Two words: 200 queries, the dictionary forms of two content words of one message.
 *
 * Quality measures, per query: the set R of all matches of the candidate's MATCH, the gold set
 * G. recall |R∩G|/|G|, precision |R∩G|/|R| (no result: recall 0, precision left out and the
 * zero-result rate reported), F1 (0 when R is empty), and recall/precision of the first 50
 * newest first (the CLI's default page). Macro means over queries, differences against A
 * with a paired bootstrap 95% interval (2,000 resamples), broken down by band.
 *
 * Cost measures (text column only, the part that changes): index size from dbstat after a
 * full merge, the full rebuild (what a migration costs), writes through triggers as tg
 * writes (history pages of 100 in one transaction, live messages one per transaction),
 * in-process query time (median, p95) of the storage benchmark's shapes (rare word, common
 * word, mid word, two words, phrase) through tg's own search code (searchNewestFirst), the
 * query rewrite included.
 *
 * Thresholds. A candidate is a significant improvement when it passes every one:
 *   Q1 Russian single words, dictionary form: macro recall at least +0.15 over A, and the 95%
 *      interval of the gain above 0. Reason: today a query misses every other form; a Russian
 *      noun has up to 12, and on short Russian documents stemming raised MAP by 80-90%
 *      (Dolamic and Savoy 2009). A gain under 0.15 is what users get by typing a prefix.
 *   Q2 Russian two-word queries: macro recall at least +0.15 over A.
 *   Q3 Macro precision, and precision of the first 50, at most 0.05 below A, in Russian and in
 *      English. Reason: 1 wrong result in 20 is noise an agent reading 50 results will act on.
 *   Q4 English macro recall not below A.
 *   C1 Index at most 1.5 times A's (on the 1M storage benchmark: about +50 MB of 1.58 GB).
 *   C2 Writes (history pages and live messages) at least 0.8 times A's rate.
 *   C3 Full rebuild at most 2 times A's time.
 *   C4 Query median at most 2 times A's for each shape, and p95 under 50 ms at 100,000.
 *   C5 At most one new runtime dependency (pure JS, permissive, under 100 KB), or at most
 *      2,000 lines in the repo; no native extension.
 * Not worth the complication: Russian single-word recall gain under +0.05, or no candidate
 * passes. Between +0.05 and +0.15: marginal, reported as such.
 * Choice among those that pass: the best Russian single-word macro F1; within 0.02 of it, the
 * simplest (query rewrite only, then an extra column, then a replaced index, then a second
 * index). Recorded besides, not a threshold: whether the cache stays writable by older tg
 * versions and by other SQLite clients, and whether exact search stays available.
 *
 * Typos (question 2). The single-word dictionary-form queries of 4+ letters, one typo each,
 * the kind chosen in turn: a keyboard neighbour substituted, a letter deleted, a keyboard
 * neighbour inserted, two neighbours swapped; for Russian also е for ё and и for й where the
 * word has them. The gold set is the intended word's. Methods, on top of the forms winner:
 *   F-DL  index words within Damerau (OSA) distance k of the typed word, k 0 under 4 letters,
 *         1 for 4-7, 2 for 8+ (Typesense's defaults), then their forms
 *   F-TRI index words with trigram similarity 0.3 or more (pg_trgm's default), then their forms
 * each always on, or only when the query finds nothing (fallback).
 * Build it when: recall on typed-with-typo queries at least +0.30 over no correction,
 * precision on them at least 0.70, and the time of the correction p95 under 50 ms. On by
 * default only if, always on, precision on correctly typed queries drops at most 0.05;
 * otherwise as the fallback if that passes, else not at all.
 */
