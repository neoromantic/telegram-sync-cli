# Storage

How tg stores an account's cache, what it costs on disk and in time, and the decisions behind
it ([#80](https://github.com/neoromantic/telegram-sync-cli/issues/80)). Every number here comes
from `bun run bench:storage` on made-up data, on one machine (see [Method](#method)). Nothing is
extrapolated: a size that wasn't run says so.

The tables themselves are in [database-schema.md](database-schema.md), search in
[search.md](search.md).

## At a glance

|  | 100,000 | 1M | 10M |
|---|---:|---:|---:|
| Cache file | 159 MB | 1.58 GB | 15.73 GB |
| Bytes per message | 1,582 | 1,570 | 1,572 |
| `raw_json` share of the file | 54% | 54% | 54% |
| History pages of 100, messages/s | 8,905 | 7,879 | 7,363 |
| Search index merges after those pages | 1.5 s | 20 s | 3.9 min |
| Live messages, one per write, messages/s | 6,250 | 6,849 | 6,579 |
| The same pages again, messages/s (rows rewritten) | 24,048 (0) | 23,637 (0) | 22,160 (0) |
| `messages search`, rare word | 0.07 ms | 0.25 ms | 2.8 ms |
| `messages search`, common word | 0.71 ms | 2.2 ms | 6.8 ms |
| `messages search`, a word in 7% of messages | 8.0 ms | 4.2 ms | 9.1 ms |
| `messages search --offset 200`, common word | 2.2 ms | 5.1 ms | 13 ms |
| `messages search --sort relevance`, common word | 56 ms | 695 ms | 6.3 s |
| `messages list`, a page of 20 | 0.18 ms | 0.20 ms | 0.23 ms |
| `messages get --context 5` | 0.22 ms | 0.21 ms | 0.24 ms |
| CLI run: `tg status` | 96 ms | 97 ms | 129 ms |
| CLI run: `tg status --sizes` | 128 ms | 404 ms | 3.3 s |
| CLI run: `tg messages search`, rare word | 93 ms | 93 ms | 98 ms |
| CLI run: `tg messages search`, common word | 95 ms | 95 ms | 98 ms |
| `tg db migrate` on rows written by 0.5.0, rows/s | 58,828 | 53,393 | not run |
| Re-index of names, once per cache (#93), messages/s | 46,915 | 35,438 | 28,500 |
| Search index rebuild | 0.75 s | 7.8 s | 1.4 min |
| `tg db vacuum`, daemon stopped | 0.7 s | 4.8 s | 1.1 min |
| `tg db vacuum`, extra disk at its peak | 322 MB | 3.11 GB | 30.94 GB |

"Common word" is in 30% of the messages, "rare word" in about 1 in 10,000 (8, 103 and 1,211
messages at the three sizes); `--offset 200` is its fifth page of 50. In-process times are the median of the runs, calling what the
command calls, without printing. A CLI run is a new process each time and adds about 90 ms to
start Bun and load tg (`tg --help` takes that long).
Every query time is in [All query times](#all-query-times).

What doesn't grow with the cache: writes, a page of `tg messages list` and `tg messages get
--context`, and the newest page of a search for a single word: a rare word sorts its few
matches, one in a few percent of the messages or more goes through the newest messages until
the page is full ([Search for a common word](#7-search-for-a-common-word)). The search index
merges in the background after writes ([8](#8-merging-the-search-index)). A query that visits every match or
every row grows in step with the cache: `--sort relevance` or `--count` on a common word, a
prefix (`stem*`) or a phrase with many matches, a `tg sql` query that scans `messages_cache`,
and `tg status --sizes`, which reads every page. `tg status` counts the messages, which takes
34 ms of its run at 10M.

## Where the bytes go

1M messages:

| Table | Size | Bytes per message | Share of the file |
|---|---:|---:|---:|
| `messages_cache` | 1.45 GB | 1,438 | 91.7% |
| `message_search` | 105 MB | 105 | 6.7% |
| `message_attachments` | 21.7 MB | 22 | 1.4% |
| `users_cache` | 2.6 MB | 3 | 0.2% |
| `raw_json` (in `messages_cache`) | 853 MB | 849 | 54.1% |

`raw_json`, the Telegram object as mtcute gives it, is a bit over half of the file. The rest of
`messages_cache` is the message's own columns and its indexes. The search index is contentless
([search.md](search.md#a-contentless-index)): it holds tokens, not a second copy of the text.
The bytes per message are the same at every size:

| Bytes per message | 100,000 | 1M | 10M |
|---|---:|---:|---:|
| Cache file | 1,582 | 1,570 | 1,572 |
| `messages_cache` | 1,434 | 1,438 | 1,441 |
| `raw_json` | 849 | 849 | 849 |
| `message_search` | 109 | 105 | 104 |
| `message_attachments` | 21 | 22 | 22 |

`raw_json` by message type, 1M messages:

| Type | Messages | Share | Average `raw_json` |
|---|---:|---:|---:|
| `text` | 826,601 | 82.2% | 685 B |
| `photo` | 100,403 | 10.0% | 1,891 B |
| `webpage` | 20,254 | 2.0% | 1,518 B |
| `document` | 20,246 | 2.0% | 918 B |
| `video` | 15,247 | 1.5% | 1,843 B |
| `voice` | 12,237 | 1.2% | 899 B |
| `sticker` | 8,296 | 0.8% | 1,022 B |
| `service` | 1,716 | 0.2% | 324 B |

A photo's `raw_json` is about 1.9 KB, most of it the stripped thumbnail (400–900 bytes, as
base64) and the list of sizes.

## Decisions

The six questions of [#80](https://github.com/neoromantic/telegram-sync-cli/issues/80) and two
its benchmark raised (#118, #149), the decision taken on each and the measurement behind it.

### 1. `raw_json`

**Decision.** Keep the whole TL object, never a normalized subset: `tg sql` reads any field
with `json_extract`, and a field tg doesn't know today is still there tomorrow. Byte fields as
base64 ([#86](https://github.com/neoromantic/telegram-sync-cli/issues/86)), Long values as
decimal strings ([#108](https://github.com/neoromantic/telegram-sync-cli/issues/108)), no
`fileReference` ([#95](https://github.com/neoromantic/telegram-sync-cli/issues/95)); rows that
older versions wrote get the same form through a background migration
([#89](https://github.com/neoromantic/telegram-sync-cli/issues/89)). The stripped thumbnail
stays: after a message is deleted on Telegram it is the only trace of the picture. Compression
with a trained zstd dictionary only if it saves a lot and `tg sql` keeps working
([#97](https://github.com/neoromantic/telegram-sync-cli/issues/97)).

**Numbers.** The same made-up messages, written as tg 0.5.0 and older wrote them, then brought
to the current form:

|  | 100,000 | 1M |
|---|---:|---:|
| Cache file written by 0.5.0 | 223 MB | 2.22 GB |
| Bytes per message | 2,225 | 2,218 |
| `raw_json` per message | 1,489 B | 1,491 B |
| `tg db migrate` | 1.7 s (100,301 rows) | 18.8 s (1,003,001 rows) |
| `raw_json` per message after it | 849 B | 849 B |
| Then `tg db vacuum` | 0.6 s, 154 MB | 5.4 s, 1.52 GB |
| Bytes per message after both | 1,538 | 1,524 |
| Written by this version, for comparison | 1,564 | 1,553 |

The old form wrote each byte of a byte field as its own JSON key, so the same cache was 43%
bigger. Base64 does almost all of the change; Long values as decimal strings and dropping
`fileReference` took a further 2% off the file: the same 1M messages in the form 0.6 and 0.7
write took 1,586 bytes per message, now 1,553.

Compression, on an even sample of about 20,000 rows of the 1M cache (nothing written back):

| `raw_json` | Bytes per message | Saving |
|---|---:|---:|
| As stored | 845 |  |
| gzip, each row | 507 | 40% |
| zstd, each row | 517 | 39% |
| zstd, the whole sample as one stream | 170 | 80% |

- Compressing each row on its own saves about 40%, and `tg sql` could no longer read the row
  with `json_extract`.
- The whole sample as one zstd stream is about 170 bytes per message. That is the most a shared
  dictionary could approach, and more than it would save on real messages: the made-up words
  are built from 60 syllables, so they repeat far more than real text does. #97 has to measure
  a trained dictionary on real-shaped data before anything changes.

### 2. Media metadata

**Decision.** A per-account `message_attachments` table, one row per message with a file,
written with the message ([#22](https://github.com/neoromantic/telegram-sync-cli/issues/22),
[database-schema.md](database-schema.md#table-message_attachments)). File references expire, so
they aren't kept (#95). The search index gets file names and kinds from it
([#94](https://github.com/neoromantic/telegram-sync-cli/issues/94)).

**Numbers.** About 16% of the made-up messages have a file. `message_attachments` takes 22
bytes per message of the whole cache, 1.4% of the file.

### 3. Offloading old data

**Decision.** Messages are never deleted automatically. No eviction with re-fetch: a message
deleted on Telegram exists only in the local copy, and re-fetching would lose it. No hard size
cap that deletes. An archive into separate files only if the main file turns out too big or too
slow ([#101](https://github.com/neoromantic/telegram-sync-cli/issues/101)).

**Numbers.** At 10M messages the file is 15.72 GB. A page of `tg messages list` takes 0.21 ms,
`tg messages get --context 5` 0.23 ms, a search for a rare word 2.8 ms and the newest page of a
common word 21 ms, so reading a chat or finding something specific doesn't need the old
messages gone. What slows down is a query over every match or row: `--sort relevance` on a
common word takes 6.2 s, `--count` on it 1.9 s and a `tg sql` aggregate that scans
`messages_cache` 23.9 s. An archive wouldn't make a search over the whole
history faster, since that search would have to read the archive too; it would only make the
main file smaller. So no archive now; #101 stays open for a cache that outgrows the disk.

### 4. Limits

**Decision.** A soft budget that warns and points at the biggest chats
([#98](https://github.com/neoromantic/telegram-sync-cli/issues/98),
[#90](https://github.com/neoromantic/telegram-sync-cli/issues/90)), and an option to stop
caching live messages in chats with sync off
([#100](https://github.com/neoromantic/telegram-sync-cli/issues/100)). The default doesn't
change.

**Numbers.** On this mix a message costs about 1.57 KB of disk whatever the size of the cache,
so 1 GB holds about 640,000 messages. More photos, links and long texts cost more per message;
`tg status --sizes` shows the real split of a cache, and a budget should use the file size, not
a message count. Reading the file's size is cheap:
a CLI run of `tg status` takes 92 ms at 100,000, 98 ms at 1M and 127 ms at 10M.

### 5. Storage engine

**Decision.** Stay on SQLite through `bun:sqlite`: no native dependency, one binary for all five
targets, FTS5 built in. DuckDB needs a native package and is weak at the daemon's many small
writes; libSQL/Turso adds nothing clear for a single-user local cache; Parquet only makes sense
for an archive (#101). Revisit only if the 10M benchmark hits a wall.

**Numbers.** In pages of 100, history is written at 9,313 messages/s at 100,000, 6,922
messages/s at 1M and 6,639 messages/s at 10M; live messages, one per transaction, at 6,615
messages/s at 100,000, 5,762 messages/s at 1M and 5,378 messages/s at 10M. So a write takes well
under a millisecond however big the cache gets. History pages lost about a fifth to the index
that finds the newest page of a common word ([below](#7-search-for-a-common-word)). Reads that
use an index stay under a millisecond at 10M, except search, which FTS5 handles within SQLite.
The other engines weren't benchmarked: the decision rests on packaging (native packages,
cross-compiling five targets), and these numbers show no wall to move away from.

### 6. Big caches

**Decision.** Migrations that rewrite every row run in the background in small batches (#89).
Integrity checks and backups: [#91](https://github.com/neoromantic/telegram-sync-cli/issues/91).
Word forms in search: [#92](https://github.com/neoromantic/telegram-sync-cli/issues/92). Names
in the index after a rename re-index in the same batches (#93).
Edit history: [#96](https://github.com/neoromantic/telegram-sync-cli/issues/96).

**Numbers.**

- **WAL.** Every connection sets `journal_size_limit` to 64 MB, so the WAL shrinks back after a
  checkpoint. `tg db migrate` keeps it small: its peak was 5.1 MB on the 1M cache, because each
  batch of at most 500 rows or 50 ms commits on its own. A full VACUUM writes the whole new file
  through the WAL: its peak was 155 MB at 100,000, 1.54 GB at 1M and 15.33 GB at 10M, about the
  size of the file.
- **Migration time.** `tg db migrate` rewrote 58,828 rows/s on the 100,000-message cache written
  by 0.5.0 and 53,393 rows/s on the 1M one (2.22 GB), 18.8 s in all, and left no row in the old
  form. The daemon runs the same batches with pauses for its own work, so it takes longer; that
  wasn't measured. A 10M cache in the old form wasn't run: the 10M run of the current form took
  31.0 min by itself, and the rate is about the same at 100,000 and 1M. Before #89 every
  migration ran in one transaction on open; a full pass that holds the write lock is like the
  search index rebuild below.
- **Names in the index.** The one-off re-index of names (`message_search_names`, #93) does a
  message at a time, a delete and an insert in the index, in the same batches as the other
  migrations, with a batch of index merges after each: 46,915 messages/s at 100,000 (2.1 s),
  35,438 at 1M (28 s) and 28,500 at 10M (5.9 min), merges included, as `tg db migrate` runs it
  alone. The daemon gives migrations 250 ms of each second, so there it should take about four
  times as long; that wasn't measured. The longest batch took 18 ms at 100,000, 32 ms at 1M and
  315 ms at 10M; 0.11.1, which let FTS5 merge inside these writes, took 1.04 s at 1M
  ([8](#8-merging-the-search-index)). A rename re-indexes only that peer's messages, at the same
  rate. The history writes queued no peer: a page caches its senders before its messages. The
  triggers that queue a rename cost about 9 µs per `users_cache` upsert even when they queue
  nothing: the same pages fetched again unchanged went from about 26,000 to 21,000 messages/s at
  100,000; history pages and live messages showed no difference beyond the noise.
- **Search index.** A full rebuild (one transaction, holding the write lock) took 0.75 s at
  100,000, 7.8 s at 1M and 1.4 min at 10M, and left the index within 4% of its size: the index
  the triggers keep up to date doesn't bloat while it is merged
  ([8](#8-merging-the-search-index)). That rebuild time is what a change of tokenizer for word
  forms (#92) costs once; a prefix query (`stem*`, which finds every form today) took 3.6 ms at
  100,000, 43 ms at 1M and 437 ms at 10M.
- **VACUUM.** `tg db vacuum` with the daemon stopped took 0.7 s at 100,000, 4.8 s at 1M and
  1.1 min at 10M. At its peak it needed free disk of about twice the file's size, for the new
  copy plus the WAL (1.9× at 100,000 and 1.8× at 1M and 10M). After the benchmark's two
  re-indexes of names it gave back 9% at 100,000 and 8% at 1M and 10M; after `tg db migrate` on
  the 1M cache written by 0.5.0 it gave back 31% (2.22 GB to 1.52 GB).

### 7. Search for a common word

**Decision.** The newest page of a search no longer sorts every match when there are many: tg
goes through the newest messages by an index on `messages_cache(date DESC)` and asks the search
index which of them match until the page is full
([#118](https://github.com/neoromantic/telegram-sync-cli/issues/118),
[search.md](search.md#query-pattern)). Since #149 it asks about runs of nearby rowids instead of
one message at a time, from a few percent of matches on, and sorts once the walk has taken a
quarter of what sorting takes. The rows and their order stay the same. `--sort
relevance` and `--count` still read every match: making them fast would change their answer
(score only the newest matches, or count up to a cap), which this change doesn't do.

**Numbers.** The same runs, seed 1, of the code before #118 and after it:

|  | 1M before | 1M after | 10M before | 10M after |
|---|---:|---:|---:|---:|
| `messages search`, common word | 315 ms | 10 ms | 3.0 s | 21 ms |
| `messages search --offset 200`, common word | 288 ms | 296 ms | 3.0 s | 64 ms |
| `messages search --chat`, common word, biggest chat | 211 ms | 9.2 ms | 2.1 s | 21 ms |
| CLI run: `tg messages search`, common word | 374 ms | 104 ms | 3.1 s | 114 ms |
| `messages search`, rare word | 0.24 ms | 0.29 ms | 3.0 ms | 2.8 ms |
| `messages search --phrase`, two common words | 24 ms | 24 ms | 251 ms | 235 ms |
| `messages search`, prefix `stem*` | 44 ms | 44 ms | 477 ms | 434 ms |
| `messages search --count`, common word (the page and the count) | 574 ms | 215 ms | 5.9 s | 1.9 s |
| `messages search --sort relevance`, common word | 627 ms | 592 ms | 6.6 s | 6.2 s |
| History pages of 100, messages/s | 8,797 | 6,922 | 8,420 | 6,639 |
| Live messages, one per write, messages/s | 6,315 | 5,762 | 5,632 | 5,378 |
| Cache file | 1.56 GB | 1.58 GB | 15.57 GB | 15.72 GB |

- **The page.** tg counts the matches in the index up to T = √(900 × page × messages): 212,000
  for a page of 50 at 1M, 671,000 at 10M. With T or more it goes through at most page ×
  messages / T of the newest messages and asks the index about each, so a page of 50 of a word
  in 30% of the messages, about 170 messages to go through, takes 10 ms at 1M and 21 ms at 10M.
  With fewer it sorts the matches as before: at 100,000 messages the common word does (25 ms),
  and so does its fifth page at 1M, whose T is 474,000. Asking the index about one message
  costs as much as sorting tens to hundreds of matches, which sets the 900: when the walk finds
  too few matches, as for a word only in old messages, counting and walking add at most about
  30% to the sort ([search.md](search.md#query-pattern)). A prefix always sorts: asking about
  one message would read every word it starts. Phrases, two words, prefixes and rare words take
  as long as before.
- **`--count`** joins chats and senders only for `--chat @name` or `--sender @name`; the count
  itself went from about 260 ms to 200 ms at 1M and from 2.9 s to 1.9 s at 10M. Its answer is
  the same.
- **`--sort relevance`** spends most of its time in FTS5's bm25 for every match: on a 1M cache,
  scoring the 300,000 matches of the common word took 545 ms of the 740 ms of the whole query,
  before anything is joined or sorted. Only scoring fewer matches would make it fast.
- **What it costs.** The index takes 14 bytes per message (0.9% of the file). History pages
  are written about a fifth slower (8,420 to 6,639 messages/s at 10M): a page lands its dates
  all over the index. Live messages land at its newest end and lost about 5%, within the noise.
  History sync takes about 90 messages a second from Telegram at most (#133), so writes stay
  some 70 times faster than it needs. The first open of a cache written before this change
  builds the index: 4.3 s on the 10M cache, under the write lock like the other index builds
  ([database-schema.md](database-schema.md#migrations)).

**The walk since #149.** On a copy of a real cache of 1.16M messages the most common word was
in 19% of them, under that T, so no search walked; and asking the index about one message
costs about 3 µs per segment of the index, 10–40 µs on a merged one. tg now counts up to
T = √(20 × page × messages), 31,600 for a page of 50 at 1M and 100,000 at 10M, reads the newest
messages in chunks, asks the index once per run of rowids at most 32 apart, and sorts once the
walk has taken 0.25 µs per counted match, a quarter of the least the sort takes
([search.md](search.md#query-pattern)). 0.11.1 against now:

|  | 1M 0.11.1 | 1M now | 10M 0.11.0 | 10M now |
|---|---:|---:|---:|---:|
| `messages search`, common word | 11 ms | 2.2 ms | 21 ms | 6.8 ms |
| `messages search --offset 200`, common word | 308 ms | 5.1 ms | 64 ms | 13 ms |
| `messages search --chat`, common word, biggest chat | 9.1 ms | 1.1 ms | 21 ms | 3.0 ms |
| CLI run: `tg messages search`, common word | 103 ms | 95 ms | 114 ms | 98 ms |
| `messages search`, rare word | 0.30 ms | 0.25 ms | 2.8 ms | 2.8 ms |
| History pages of 100, messages/s | 7,062 | 7,879 | 6,639 | 7,363 |
| Live messages, one per write, messages/s | 4,676 | 6,849 | 5,378 | 6,579 |

The 10M column of 0.11.0 is the run above; 0.11.1 searches the same way. A word in 7% of the
messages walks now and sorted before: on one 1M cache file it took 85 ms in 0.11.1 and takes
6.7 ms, a word in 4.4% 54 ms and 9.2 ms. The worst case is a walk that finds nothing, such as
`--sender` of someone with no recent messages, and then sorts: 64 ms against 72 ms, and 41 ms
against 49 ms, on that file. On the index 0.11.1 left after its re-index (#149), where a
question takes milliseconds, the budget stops the walk: a word in 30% took 488 ms in 0.11.1 and
363 ms now, one in 4.4% 74 ms and 82 ms ([search.md](search.md#query-pattern)).
On one 10M cache file, 0.11.1 against now: a word in 4.4% took 586 ms and takes 6.4 ms, one in 7%
29 ms and 8.6 ms, a word in 30% 18 ms and 6.5 ms; the worst cases 678 ms against 695 ms and
442 ms against 448 ms.

### 8. Merging the search index

**Decision.** Writes no longer merge the segments of the search index; the daemon merges them
after the sync work of each tick and `tg db migrate` at the end of its run, in short batches,
and merges the whole index once a tenth of its entries are deleted
([#142](https://github.com/neoromantic/telegram-sync-cli/issues/142),
[#149](https://github.com/neoromantic/telegram-sync-cli/issues/149),
[search.md](search.md#keeping-the-index-merged)). A cache whose index 0.11.1 left with the old
entries of every message is cleaned once.

**Numbers.** "One question" is asking the index whether one of the 2,000 newest messages has the
common word.

|  | 100,000 | 1M | 10M |
|---|---:|---:|---:|
| Index after the writes, merged after each | 11.0 MB, 4 segments, 9.8 µs a question | 105 MB, 7, 19 µs | 1.04 GB, 9, 24 µs |
| Merges after the history pages, in all | 1.5 s | 20 s | 3.9 min |
| Longest merge batch after them | 69 ms | 146 ms | 227 ms |
| Re-index of names: longest batch | 18 ms | 32 ms | 315 ms |
| Re-index of names: longest merge batch between its batches | 73 ms | 90 ms | 693 ms |
| Index after it | 11.1 MB, 1, 8.0 µs | 104 MB, 2, 9.6 µs | 1.06 GB, 5, 29 µs |
| Re-index as 0.11.1 did it: longest batch | 87 ms | 282 ms | 661 ms |
| Index after it | 21.9 MB, 7, 363 µs | 202 MB, 14, 3.8 ms | 2.00 GB, 13, 51 ms |
| `messages search`, common word, on that index | 31 ms | 331 ms | 3.4 s |
| Cleaning it up | 0.24 s, 4 batches | 2.6 s, 33 batches | 61 s, 774 batches |
| Longest batch of the clean-up | 81 ms | 110 ms | 597 ms |
| Index after it | 11.0 MB, 1, 7.8 µs | 104 MB, 1, 8.8 µs | 1.06 GB, 2, 14 µs |

- **The state #149 found.** 0.11.1 merged inside writes, a level once it had four segments, and
  kept deleted entries until then. Its re-index of every message in batches of 250, as the
  daemon cuts them at 50 ms, left a level of three segments whose entries were all deleted:
  twice the index, and a question took milliseconds. In batches of 500 its merges happened to
  reach them (106 MB at 1M). The question's cost is those deleted entries more than the
  segments: on 1M messages, 41 segments and none deleted took 67 µs a question, 4 segments of
  which two held only deleted entries 4.6 ms, one segment 7–10 µs.
- **Writes.** No write merges now, so the re-index batches, live messages (17 ms at most) and
  history pages hold the lock only for their own rows. A few history pages still took over
  100 ms: 5 of 10,486 at 1M (up to 282 ms) and 31 of 105,673 at 10M (up to 529 ms). Writing only
  the history of 1M messages gave 6 such pages with 0.11.1 and 2 now, 1 with WAL checkpoints
  off, so they aren't index merges; what they are wasn't found.
- **Merges.** A merge step copies a word's whole list of entries, so the batches that merge
  the biggest segments take as long as the most common words: up to 146 ms at 1M and 0.7 s at
  10M. They run between other writes, and another writer waits for one at most. Only a smaller
  entry list would make them shorter: FTS5's `detail=column` keeps no positions, but phrase
  search (`"…"`) would then match words in any order (#142).
- **Cost.** Merging after every history page took 15% to 17% of the time of the writes at 1M
  and 10M; history sync takes about 90 messages a second from Telegram (#133), some 70 times
  less than tg writes with the merges. The daemon merges at most 250 ms a second, shared with
  the background migrations.

## All query times

Median of the in-process runs, with p95 in parentheses:

|  | 100,000 | 1M | 10M |
|---|---:|---:|---:|
| `messages search`, rare word | 0.07 ms (0.09 ms) | 0.25 ms (0.31 ms) | 2.8 ms (3.1 ms) |
| `messages search`, common word | 0.71 ms (1.2 ms) | 2.2 ms (2.3 ms) | 6.8 ms (6.9 ms) |
| `messages search`, a word in 7% of messages | 8.0 ms (8.4 ms) | 4.2 ms (4.4 ms) | 9.1 ms (9.1 ms) |
| `messages search`, a word in 7%, `--sender` with no recent messages | 6.0 ms (6.2 ms) | 71 ms (72 ms) | 679 ms (689 ms) |
| `messages search --offset 200`, common word | 2.2 ms (2.3 ms) | 5.1 ms (5.2 ms) | 13 ms (14 ms) |
| `messages search`, two words | 0.22 ms (0.24 ms) | 0.96 ms (1.1 ms) | 16 ms (18 ms) |
| `messages search --phrase`, two common words | 1.6 ms (1.7 ms) | 23 ms (23 ms) | 238 ms (244 ms) |
| `messages search`, prefix `stem*` | 3.6 ms (3.7 ms) | 43 ms (45 ms) | 437 ms (440 ms) |
| `messages search --chat`, common word, biggest chat | 0.49 ms (0.51 ms) | 1.1 ms (1.3 ms) | 3.0 ms (3.2 ms) |
| `messages search --sort relevance`, common word | 56 ms (60 ms) | 695 ms (727 ms) | 6.3 s (7.2 s) |
| `messages search --sort relevance`, two words | 0.36 ms (0.39 ms) | 2.5 ms (2.6 ms) | 31 ms (34 ms) |
| `messages search --count`, common word | 20 ms (22 ms) | 202 ms (211 ms) | 1.9 s (1.9 s) |
| `messages search --count`, rare word | 0.08 ms (0.10 ms) | 0.31 ms (0.42 ms) | 4.6 ms (4.7 ms) |
| `messages search --snippet`, two words | 0.53 ms (0.60 ms) | 1.4 ms (1.5 ms) | 15 ms (16 ms) |
| `messages list`, newest page of 20 | 0.18 ms (0.23 ms) | 0.20 ms (0.26 ms) | 0.23 ms (0.29 ms) |
| `messages list --before`, a page in the middle | 0.19 ms (0.21 ms) | 0.19 ms (0.21 ms) | 0.20 ms (0.33 ms) |
| `messages get --context 5` | 0.22 ms (0.32 ms) | 0.21 ms (0.34 ms) | 0.24 ms (0.24 ms) |
| `tg sql`, aggregate over `message_search_text` | 0.09 ms (0.11 ms) | 0.79 ms (0.82 ms) | 15 ms (15 ms) |
| `tg sql`, aggregate that scans `messages_cache` | 188 ms (193 ms) | 2.2 s (2.3 s) | 24.7 s (25.8 s) |
| `tg status` | 0.75 ms (0.92 ms) | 3.1 ms (3.4 ms) | 34 ms (36 ms) |
| `tg status --sizes` | 33 ms (33 ms) | 318 ms (322 ms) | 3.2 s (3.2 s) |
| CLI run: `tg --help` | 92 ms (104 ms) | 89 ms (91 ms) | 88 ms (88 ms) |
| CLI run: `tg status` | 96 ms (97 ms) | 97 ms (98 ms) | 129 ms (129 ms) |
| CLI run: `tg status --sizes` | 128 ms (129 ms) | 404 ms (409 ms) | 3.3 s (3.4 s) |
| CLI run: `tg messages search`, rare word | 93 ms (103 ms) | 93 ms (94 ms) | 98 ms (98 ms) |
| CLI run: `tg messages search`, common word | 95 ms (96 ms) | 95 ms (95 ms) | 98 ms (99 ms) |
| CLI run: `tg sql`, aggregate over `message_search_text` | 94 ms (95 ms) | 94 ms (103 ms) | 110 ms (112 ms) |

## Method

- **Data.** A made-up account: one user per 500 messages (50 to 20,000) and one chat per 1,000
  messages (30 to 10,000). Chat sizes follow a Zipf curve, so a few chats are big and most are
  small: at 1M the biggest supergroup has 134,072 messages, the biggest channel 66,796 and the
  biggest private chat 44,530. About 60% of the chats are private, 10% basic groups, 15%
  supergroups and 15% channels. A message has 3–40 words, most short, drawn with a Zipf
  distribution from 30,000 made-up Latin and Cyrillic words; Cyrillic words take endings, so
  `stem*` finds several forms. About 10% are photos, 1.5% videos, 1.5% voice messages, 2%
  files, 1% stickers and 2% link previews (example.com); 10% are replies, 5% edited, 3%
  forwarded, and 1% are marked deleted afterwards. Every object has the shape mtcute's reader
  gives: each flag a boolean, Long IDs, byte fields as `Uint8Array`. Names and words are built
  from syllables. The seed (`--seed`, default 1) fixes every value.
- **Writes**, through tg's own code. History: `cacheHistoryResponse`, which `tg messages list`
  uses to cache a `messages.getHistory` page (`parseRawMessage`, `toRawJson`, `upsertBatch`
  with the attachment rows, the page's senders and its history range), one transaction per page
  of 100, newest page first. Re-fetch: the newest pages again, unchanged. Live: `parseRawMessage`
  and `upsert`, one transaction per message, as the daemon writes an update. After each page and
  each live message, a batch of search index merges when one is due, as the daemon runs them
  after its writes, timed apart from the writes. Deletes: `markDeleted`. The file is opened as
  tg opens it (`getAccountCacheDb`).
- **Old form** (`--old-form`). The same messages, users and chats with `raw_json` by plain
  `JSON.stringify` and every file a `document`, no attachment rows and the migrations pending,
  as a cache written by 0.5.0 or older looks to this version. Then `tg db migrate` and
  `tg db vacuum` run as CLI commands.
- **Sizes**, after a TRUNCATE checkpoint, from `dbstat` with indexes and FTS5 shadow tables
  counted under their table, as `tg status --sizes` reports them. MB and GB are 10^6 and 10^9
  bytes.
- **Queries**, in one process, calling the functions each command calls: one first run, then
  `--runs` runs (20 at 100,000 and 1M, 5 at 10M; at most 5 for `tg sql` and `tg status`),
  median and p95. `tg sql` goes through a read-only connection, as the command opens it. CLI
  rows start `bun src/index.ts` as a new process each time, `--cli-runs` times (5, or 3 at
  10M).
- **Maintenance.** The one-off re-index of names (`message_search_names`) in process, as
  `tg db migrate` runs it with the daemon stopped: its batches with a merge batch after each,
  then merges until none is due. Then once more as 0.11.1 ran it, with FTS5 merging inside the
  writes (`automerge` 4, `deletemerge` 0) in batches of 250 messages, the searches on the index
  it leaves, and the merges that clean it up. The search index's size, its segments, and a
  question to it (whether one of the 2,000 newest messages has the common word, the mean of
  2,000) after each step. `rebuildMessageSearchIndex` in process; `tg db vacuum` and
  `tg db migrate` as CLI runs, with free disk and the WAL size read every 25 ms while they run.
- **Machine.** macOS 27 (Darwin 27.0), arm64, Bun 1.4.4, SQLite 3.54.0 (on macOS Bun uses the
  system SQLite). The queries ran right after the file was written, so they are warm-cache
  times.
- **Not covered.** Real messages (other words, another media mix), the daemon and the CLI
  writing at the same time, a cold page cache, Linux and Windows (Bun's bundled SQLite).

## Re-running the benchmark

```bash
bun run bench:storage                                   # 100,000 messages
bun run bench:storage --messages 1000000 --out 1m.json  # also write the JSON to a file
bun run bench:storage --messages 1000000 --old-form     # time tg db migrate on old rows
```

| Option | Default | |
|---|---|---|
| `--messages N` | 100000 | Messages in the generated history; live messages come on top |
| `--seed S` | 1 | Fixes every generated value |
| `--runs R` | 20 | Timed runs per in-process query, after one first run |
| `--cli-runs R` | 5 | Timed runs per CLI command |
| `--old-form` | off | Write the history as 0.5.0 and older did, then time `tg db migrate` |
| `--out file` | none | Also write the JSON result to `file` |
| `--keep` | off | Leave the temp folder with the cache |

It prints progress to stderr, then the JSON result and a Markdown summary to stdout. It needs
no Telegram credentials, works in a new folder under `$TMPDIR` (set as
`TELEGRAM_SYNC_CLI_DATA_DIR`, never `~/.telegram-sync-cli`) and removes it at the end. It isn't
part of `bun run test` or CI.

It needs free disk for the cache (about 1.6 KB per message, 2.2 KB with `--old-form`) and about
twice that again for `tg db vacuum` at the end.

Time on the machine above: 29 s at 100,000, 4.8 min at 1M, 50.4 min at 10M (26.5 min of it
writing the history and merging after it); with `--old-form` 15.1 s and 2.8 min. The 10M cache
took 15.73 GB and 30.94 GB more during the VACUUM.

Compare runs on the same machine only. To measure a change, run the same `--messages` and
`--seed` before and after it.

## Follow-up issues

Open:

- [#90](https://github.com/neoromantic/telegram-sync-cli/issues/90) tg status --sizes: cache size per chat
- [#91](https://github.com/neoromantic/telegram-sync-cli/issues/91) tg db check and tg db backup
- [#92](https://github.com/neoromantic/telegram-sync-cli/issues/92) Search: find other word forms without a manual prefix
- [#94](https://github.com/neoromantic/telegram-sync-cli/issues/94) Search attachment names, kinds and text derived from attachments
- [#96](https://github.com/neoromantic/telegram-sync-cli/issues/96) Keep earlier versions of edited messages
- [#97](https://github.com/neoromantic/telegram-sync-cli/issues/97) raw_json: measure zstd with a trained dictionary
- [#98](https://github.com/neoromantic/telegram-sync-cli/issues/98) A soft cache size budget per account
- [#100](https://github.com/neoromantic/telegram-sync-cli/issues/100) Option to cache live messages only in synced chats
- [#101](https://github.com/neoromantic/telegram-sync-cli/issues/101) Archive old messages into separate files

Done:

- [#22](https://github.com/neoromantic/telegram-sync-cli/issues/22) Send and download media
- [#86](https://github.com/neoromantic/telegram-sync-cli/issues/86) raw_json: store byte arrays as base64
- [#89](https://github.com/neoromantic/telegram-sync-cli/issues/89) Background, resumable migrations for big caches
- [#93](https://github.com/neoromantic/telegram-sync-cli/issues/93) Search: re-index older messages after a person or chat is renamed
- [#95](https://github.com/neoromantic/telegram-sync-cli/issues/95) raw_json: stop storing fileReference
- [#108](https://github.com/neoromantic/telegram-sync-cli/issues/108) raw_json: write Long values as decimal strings
- [#118](https://github.com/neoromantic/telegram-sync-cli/issues/118) Search for a common word takes seconds on a big cache
- [#142](https://github.com/neoromantic/telegram-sync-cli/issues/142) Search index merges can hold the write lock for hundreds of ms on a big cache
- [#149](https://github.com/neoromantic/telegram-sync-cli/issues/149) Search index keeps the old entries of every re-indexed message
