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
| Cache file | 159 MB | 1.58 GB | 15.72 GB |
| Bytes per message | 1,580 | 1,569 | 1,571 |
| `raw_json` share of the file | 54% | 54% | 54% |
| History pages of 100, messages/s | 9,313 | 6,922 | 6,639 |
| Live messages, one per write, messages/s | 6,615 | 5,762 | 5,378 |
| The same pages again, messages/s (rows rewritten) | 26,273 (0) | 20,950 (0) | 22,727 (0) |
| `messages search`, rare word | 0.09 ms | 0.29 ms | 2.8 ms |
| `messages search`, common word | 25 ms | 10 ms | 21 ms |
| `messages search --offset 200`, common word | 26 ms | 296 ms | 64 ms |
| `messages search --sort relevance`, common word | 58 ms | 592 ms | 6.2 s |
| `messages list`, a page of 20 | 0.18 ms | 0.21 ms | 0.21 ms |
| `messages get --context 5` | 0.22 ms | 0.24 ms | 0.23 ms |
| CLI run: `tg status` | 92 ms | 98 ms | 127 ms |
| CLI run: `tg status --sizes` | 124 ms | 400 ms | 3.2 s |
| CLI run: `tg messages search`, rare word | 90 ms | 95 ms | 97 ms |
| CLI run: `tg messages search`, common word | 116 ms | 104 ms | 114 ms |
| `tg db migrate` on rows written by 0.5.0, rows/s | 58,828 | 53,393 | not run |
| Re-index of names, once per cache (#93), messages/s | 53,719 | 37,741 | not run |
| Search index rebuild | 0.8 s | 9.3 s | 1.8 min |
| `tg db vacuum`, daemon stopped | 0.6 s | 5.3 s | 1.4 min |
| `tg db vacuum`, extra disk at its peak | 314 MB | 3.37 GB | 30.62 GB |

"Common word" is in 30% of the messages, "rare word" in about 1 in 10,000 (8, 103 and 1,211
messages at the three sizes); `--offset 200` is its fifth page of 50. In-process times are the median of the runs, calling what the
command calls, without printing. A CLI run is a new process each time and adds about 90 ms to
start Bun and load tg (`tg --help` takes that long).
Every query time is in [All query times](#all-query-times).

What doesn't grow with the cache: writes, a page of `tg messages list` and `tg messages get
--context`, and the newest page of a search for a single word: a rare word sorts its few
matches, a common one goes through the newest messages until the page is full
([Search for a common word](#7-search-for-a-common-word)). A query that visits every match or
every row grows in step with the cache: `--sort relevance` or `--count` on a common word, a
prefix (`stem*`) or a phrase with many matches, a `tg sql` query that scans `messages_cache`,
and `tg status --sizes`, which reads every page. `tg status` counts the messages, which takes
33 ms of its run at 10M.

## Where the bytes go

1M messages:

| Table | Size | Bytes per message | Share of the file |
|---|---:|---:|---:|
| `messages_cache` | 1.45 GB | 1,438 | 91.7% |
| `message_search` | 104 MB | 104 | 6.6% |
| `message_attachments` | 21.7 MB | 22 | 1.4% |
| `users_cache` | 2.6 MB | 3 | 0.2% |
| `raw_json` (in `messages_cache`) | 853 MB | 849 | 54.1% |

`raw_json`, the Telegram object as mtcute gives it, is a bit over half of the file. The rest of
`messages_cache` is the message's own columns and its indexes. The search index is contentless
([search.md](search.md#a-contentless-index)): it holds tokens, not a second copy of the text.
The bytes per message are the same at every size:

| Bytes per message | 100,000 | 1M | 10M |
|---|---:|---:|---:|
| Cache file | 1,580 | 1,569 | 1,571 |
| `messages_cache` | 1,434 | 1,438 | 1,441 |
| `raw_json` | 849 | 849 | 849 |
| `message_search` | 118 | 104 | 102 |
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

The six questions of [#80](https://github.com/neoromantic/telegram-sync-cli/issues/80) and one
its benchmark raised (#118), the decision taken on each and the measurement behind it.

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
  migrations: 53,719 messages/s at 100,000 (1.9 s) and 37,741 messages/s at 1M (27 s alone, as
  `tg db migrate` runs it). The daemon gives migrations 250 ms of each second, so there it should
  take about four times as long, some 2 minutes for 1M; that wasn't measured. The longest batch
  took 139 ms at 100,000 and 1.04 s at 1M: FTS5 merging the big segments of its index, which
  history writes hit too ([search.md](search.md#names-after-a-rename)). Right after it the index
  took 19.7 MB instead of 11.8 MB at 100,000 and 106 MB instead of 104 MB at 1M, until its
  segments merge. A rename re-indexes
  only that peer's messages, at the same rate. The history writes queued no peer: a page caches
  its senders before its messages. The triggers that queue a rename cost about 9 µs per
  `users_cache` upsert even when they queue nothing: the same pages fetched again unchanged went
  from about 26,000 to 21,000 messages/s at 100,000; history pages and live messages showed no
  difference beyond the noise.
- **Search index.** A full rebuild (one transaction, holding the write lock) took 0.8 s at
  100,000, 9.3 s at 1M and 1.8 min at 10M. It shrank the index by 4% at 100,000, 1% at 1M and 1%
  at 10M: the index the triggers keep up to date doesn't bloat. That rebuild time is what a
  change of tokenizer for word forms (#92) costs once; a prefix query (`stem*`, which finds
  every form today) took 3.8 ms at 100,000, 53 ms at 1M and 433 ms at 10M.
- **VACUUM.** `tg db vacuum` with the daemon stopped took 0.6 s at 100,000, 5.3 s at 1M and
  1.4 min at 10M. At its peak it needed free disk of about twice the file's size, for the new
  copy plus the WAL (2.0× at 100,000, 2.2× at 1M and 2.0× at 10M). On a fresh cache it gave back
  3% at 100,000, 2% at 1M and 2% at 10M; after `tg db migrate` on the 1M cache written by 0.5.0
  it gave back 31% (2.22 GB to 1.52 GB).

### 7. Search for a common word

**Decision.** The newest page of a search no longer sorts every match when there are many: tg
goes through the newest messages by an index on `messages_cache(date DESC)` and asks the search
index about each until the page is full
([#118](https://github.com/neoromantic/telegram-sync-cli/issues/118),
[search.md](search.md#query-pattern)). The rows and their order stay the same. `--sort
relevance` and `--count` still read every match: making them fast would change their answer
(score only the newest matches, or count up to a cap), which this change doesn't do.

**Numbers.** The same runs, seed 1, of the code before this change and after it:

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

## All query times

Median of the in-process runs, with p95 in parentheses:

|  | 100,000 | 1M | 10M |
|---|---:|---:|---:|
| `messages search`, rare word | 0.09 ms (0.12 ms) | 0.29 ms (0.34 ms) | 2.8 ms (2.9 ms) |
| `messages search`, common word | 25 ms (26 ms) | 10 ms (11 ms) | 21 ms (21 ms) |
| `messages search --offset 200`, common word | 26 ms (28 ms) | 296 ms (303 ms) | 64 ms (65 ms) |
| `messages search`, two words | 0.23 ms (0.35 ms) | 1.0 ms (1.1 ms) | 15 ms (15 ms) |
| `messages search --phrase`, two common words | 1.6 ms (1.6 ms) | 24 ms (25 ms) | 235 ms (239 ms) |
| `messages search`, prefix `stem*` | 3.5 ms (3.5 ms) | 44 ms (45 ms) | 434 ms (438 ms) |
| `messages search --chat`, common word, biggest chat | 22 ms (24 ms) | 9.2 ms (9.4 ms) | 21 ms (21 ms) |
| `messages search --sort relevance`, common word | 58 ms (63 ms) | 592 ms (698 ms) | 6.2 s (7.1 s) |
| `messages search --sort relevance`, two words | 0.39 ms (0.44 ms) | 2.2 ms (2.4 ms) | 34 ms (35 ms) |
| `messages search --count`, common word | 45 ms (47 ms) | 215 ms (222 ms) | 1.9 s (2.0 s) |
| `messages search --count`, rare word | 0.12 ms (0.14 ms) | 0.38 ms (0.44 ms) | 4.7 ms (4.8 ms) |
| `messages search --snippet`, two words | 0.58 ms (0.63 ms) | 1.4 ms (1.6 ms) | 15 ms (17 ms) |
| `messages list`, newest page of 20 | 0.18 ms (0.23 ms) | 0.21 ms (0.38 ms) | 0.21 ms (0.28 ms) |
| `messages list --before`, a page in the middle | 0.19 ms (0.31 ms) | 0.20 ms (0.35 ms) | 0.19 ms (0.33 ms) |
| `messages get --context 5` | 0.22 ms (0.32 ms) | 0.24 ms (0.44 ms) | 0.23 ms (0.37 ms) |
| `tg sql`, aggregate over `message_search_text` | 0.11 ms (0.13 ms) | 0.84 ms (1.0 ms) | 15 ms (15 ms) |
| `tg sql`, aggregate that scans `messages_cache` | 181 ms (182 ms) | 2.2 s (2.3 s) | 23.9 s (24.7 s) |
| `tg status` | 0.74 ms (0.84 ms) | 3.4 ms (3.9 ms) | 33 ms (33 ms) |
| `tg status --sizes` | 33 ms (33 ms) | 325 ms (351 ms) | 3.1 s (3.1 s) |
| CLI run: `tg --help` | 87 ms (88 ms) | 88 ms (90 ms) | 87 ms (87 ms) |
| CLI run: `tg status` | 92 ms (93 ms) | 98 ms (99 ms) | 127 ms (128 ms) |
| CLI run: `tg status --sizes` | 124 ms (126 ms) | 400 ms (410 ms) | 3.2 s (3.2 s) |
| CLI run: `tg messages search`, rare word | 90 ms (92 ms) | 95 ms (96 ms) | 97 ms (98 ms) |
| CLI run: `tg messages search`, common word | 116 ms (117 ms) | 104 ms (105 ms) | 114 ms (114 ms) |
| CLI run: `tg sql`, aggregate over `message_search_text` | 91 ms (105 ms) | 94 ms (97 ms) | 110 ms (111 ms) |

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
  and `upsert`, one transaction per message, as the daemon writes an update. Deletes:
  `markDeleted`. The file is opened as tg opens it (`getAccountCacheDb`).
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
  `tg db migrate` runs it with the daemon stopped; `rebuildMessageSearchIndex` in process; `tg db vacuum` and `tg db migrate` as
  CLI runs, with free disk and the WAL size read every 25 ms while they run.
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

Time on the machine above: 22.8 s at 100,000, 4.0 min at 1M, 40.1 min at 10M (25.1 min of it
writing the history); with `--old-form` 15.1 s and 2.8 min. The 10M cache took 15.72 GB and
30.91 GB more during the VACUUM.

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
