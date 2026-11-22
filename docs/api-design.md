# API Design

## Philosophy: Generic API Access

Rather than manually mapping every Telegram API method to a CLI command, we provide:

1. **Generic `api` command** — Call any Telegram method directly
2. **Convenience commands** — High-level wrappers for common operations
3. **Agent-friendly output** — JSON output by default, with `pretty` and `quiet` modes

## Generic API Command

```bash
# Call any Telegram method directly
tg api account.checkUsername --username myuser
tg api messages.getHistory --peer @username --limit 10
tg api contacts.getContacts

# With JSON input for complex arguments
tg api messages.sendMessage --json '{"peer": "@user", "message": "Hello"}'

# Use a specific account
tg api account.getAuthorizations --account 2

# Raw output (no success wrapper)
tg api updates.getState --raw
```

With `--raw` the command prints only the result and exits 0, so a script can pipe it. A failed
call prints the usual error JSON to stderr and exits with its code. Either way `tg api` closes
its Telegram connection before it exits.

In [read-only mode](configuration.md#read-only-mode-and-allowed-chats) only methods named
`get…`, `search…`, `resolve…` or `check…` after the namespace run; others fail with `READ_ONLY`
before connecting. While `allowedChats` is set, `tg api` fails with `CHAT_NOT_ALLOWED`: a raw
call can name any chat.

This maps directly to mtcute's `client.call()`:

```typescript
await client.call({ _: "account.checkUsername", username: "myuser" });
```

### Argument Merging

The `api` command merges named CLI args with JSON (JSON wins on conflicts).

Method arguments go after the method, as `--name value` or `--name=value`; both build the same
call, and a negative number works either way (`--addOffset -10`). A flag followed by another
option, or last, is `true` (`--silent`), and `--no-name` is `false`. Any other value that starts
with `-` needs `=` (`--message=-hi`). Both forms type values the same way: `true`/`false`,
numbers and `{…}`/`[…]` JSON; a string that looks like one of these goes in `--json`.

tg keeps its own options out of the request: `--json`/`-j`, `--account`/`-a`, `--raw`/`-r`, and
the global `--format`/`-f`, `--verbose`/`-v`, `--quiet`/`-q` (also `--q`, `--f`, `--v`) and
`--help`/`-h`. Put them after the method. `--json`, `--account` and `--raw` also work between
`api` and the method, and the global options before `api`. Don't put `-f`/`--format` between
`api` and the method: its value is taken as the method. A method argument with one of those
names goes in `--json`, such as `q` in `contacts.search` and `messages.search` or `format` in
`account.getThemes`: `tg api contacts.search --json '{"q":"alice","limit":5}'`.

```bash
# Named args
tg api account.checkUsername --username myuser

# Nested args via dot notation
tg api messages.sendMessage --peer @myuser --message Hello --replyTo._ inputReplyToMessage --replyTo.replyToMsgId 42

# JSON merge
tg api messages.sendMessage --peer @myuser --json '{"message":"Hello"}'
```

### Argument Types

`tg api` reads the method's arguments from mtcute's TL schema (`@mtcute/core/tl/api-schema.json`)
and fixes up what a CLI can't write as a TL object:

- A chat given as a string or number where the method takes an `InputPeer`, `InputUser` or
  `InputChannel` (`peer`, `offsetPeer`, `channel`, `userId`, `id` of `users.getFullUser`, also
  in a vector such as `id` of `users.getUsers`) resolves as `tg send --to` does (`me`,
  `@username`, `+phone`, a marked ID; [Peer Resolution](#peer-resolution)), cache first, and
  becomes the input type the method takes. A chat of the wrong kind, such as a group where the
  method takes a user, is `INVALID_ARGS`.
- A `long` given as a number or a decimal string becomes the Long mtcute sends. Write a long
  above 2^53 as a string (`--json '{"hash":"9007199254740993"}'`): JSON numbers lose precision.
- A required `int` or `long` you leave out is 0 (`offsetId`, `offsetDate`, `addOffset`, `maxId`,
  `minId`, `hash`, also `limit`), a required `randomId` is a random Long and a required
  `offsetPeer` is `inputPeerEmpty`. Optional arguments stay out.

A full TL object (`{"_":"inputPeerSelf"}`) goes as given, and so does every argument of a method
the schema doesn't know.

```bash
tg api messages.getHistory --peer me --limit 1
tg api messages.getDialogs --limit 10
tg api users.getFullUser --id @username
tg api channels.getFullChannel --channel -1001234567890
```

## Convenience Commands

High-level commands for common operations:

```bash
# Authentication
tg auth login --phone +15551234567
tg auth login-qr
tg auth logout
tg auth status

# Account management
tg accounts list
tg accounts switch --id 1
tg accounts remove --id 1
tg accounts info --id 1

# Contacts (with caching)
tg contacts list --limit 50 --offset 0
tg contacts search --query "John"
tg contacts get --id @username
tg contacts get --id 123456789

# Chats/Dialogs (with caching)
tg chats list --limit 50 --type private
tg chats list --unread             # only chats with unread messages
tg chats search --query "query"   # cache-only
tg chats get --id @username        # username only
tg chats sync @examplenews         # sync a large group or channel too (--off, --auto)

# Messages: chat history (cache-first), full-text search and new messages (cache-only)
tg messages list --chat @username --limit 20
tg messages list --chat @username --before 1200
tg messages get --chat @username --id 1200 --context 3
tg messages search --query "hello"
tg messages search --query "hello" --chat @teamchat --sender @alice
tg messages search --query "hello" --includeDeleted
tg messages wait --chat @username --after 1200 --timeout 60   # the daemon's new messages
tg messages watch                                             # NDJSON, until Ctrl-C
tg messages unread --chat @username   # unread messages (cache, --fresh)
tg messages read --chat @username     # mark read on Telegram (--max-id)

# Messaging
tg send --to @username --message "Hello"
tg send --to @username -m "Hello" --silent
tg send --to @username -m "Reply" --reply-to 123
tg send --to me --file ./report.pdf --caption "Q3"   # one file: a photo or a document

# Media: a message's file into the account's media cache (cache-first)
tg media download --chat me --id 42 --out ./
tg media clean --older-than 30d

# Status
tg status

# SQL
tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg sql print-schema --table=users_cache

# Agent skill
tg skill install --dir ~/.claude/skills
tg skill validate
```

### Agent skill

[`skills/telegram-sync-cli/SKILL.md`](../skills/telegram-sync-cli/SKILL.md) tells a coding
agent how to use `tg`: when to reach for it, the read paths (`tg messages search`, `tg sql`),
checking that the cache covers a chat before reporting a total, confirming before `tg send`,
the error schema and the exit codes. Install it with the skills CLI:

```bash
bunx skills add neoromantic/telegram-sync-cli
```

or with `tg skill install --dir <skills dir>`, which writes the same file, embedded in `tg`, to
`<dir>/telegram-sync-cli/SKILL.md` and prints `{ path, bytes, overwritten }`. `--dir` is
required and can't be empty: it is the agent's skills directory, such as `~/.claude/skills`.
Install replaces a `SKILL.md` already there, local edits included. The skills directory may be
a symbolic link, but `telegram-sync-cli` and `SKILL.md` inside it may not: install refuses
them (`GENERAL_ERROR`, `details.path`), so a reinstall never writes into another tree. Both
commands, as described here, need tg 0.15.0 or later; 0.14.0 and older ignore `--dir` and
write `skill.json` into the data directory.

Every command in the skill's code blocks runs in `src/test/skill-examples.e2e.test.ts`, so
an example can't go stale.

`tg skill validate` checks what the skill needs, locally, without a network call or
credentials, and works with an invalid `config.json` or a broken `data.db`, which it reads
through a read-only connection and never changes:

- `env`: the API credentials in the environment;
- `data_dir`: that the data directory is writable;
- `account`, `accounts_total`: the account record the next command uses without `--account`,
  picked as every command picks it: `activeAccount` in `config.json`, else the active account,
  else the only one. If the choice depends on merging legacy login records, validation returns
  `account: null` and `valid: false`. Run `tg accounts list` to merge the records and retry;
- `daemon`: whether a live process holds `daemon.pid`.

The last two are local records. Neither says whether the account's session is still authorized
or whether the daemon is connected; `tg status` shows the connection. Each value is read on
its own, so one that can't be read leaves the others accurate: `accounts_total` is `null` when
`data.db` can't be read, and `daemon.status` is `unknown`, with `daemon.error`, when
`daemon.pid` can't.

```json
{
  "success": true,
  "data": {
    "valid": true,
    "env": {
      "telegram_api_id": {
        "present": true,
        "valid": true
      },
      "telegram_api_hash": {
        "present": true,
        "valid": true
      }
    },
    "data_dir": {
      "path": "/tmp/tg-example-data",
      "exists": true,
      "is_directory": true,
      "writable": true
    },
    "account": {
      "id": 1,
      "username": "example_one",
      "label": null
    },
    "accounts_total": 1,
    "daemon": {
      "status": "running",
      "pid": 23595
    },
    "issues": []
  }
}
```

`issues` lists what keeps `tg` from working: missing credentials, a data directory it can't
write, an invalid or unreadable `config.json` (every other command refuses to start until it is
fixed, so `account` is `null`), no account (`tg auth login`), several accounts and none active,
or a `data.db` it can't read, such as
`Could not read the accounts in /tmp/tg-example-data/data.db: file is not a database`. A
stopped daemon isn't an issue, since cache reads work without it, but the cache then holds only
what earlier commands fetched.

### Cache Behavior

All data-fetching commands support the `--fresh` flag:

```bash
# Use cached data (default)
tg contacts list

# Force fresh API fetch
tg contacts list --fresh
```

Response includes cache metadata (wrapped by `success`):

```json
{
  "success": true,
  "data": {
    "items": [],
    "source": "cache",
    "stale": false,
    "offset": 0,
    "limit": 50
  }
}
```

### Next Commands

A success answer may carry `next` beside `data`: commands that continue the read, each a
complete `tg` command line and one sentence on why. A paged list with more suggests its next
page, carrying the account and every filter it was given (relative times resolved to UTC); an
empty chat cache suggests the command that fills it, and a filtered `tg messages list` page that
the cache can't vouch for suggests what fills it and then the same page again:

```json
{
  "success": true,
  "data": { "items": [ … ], "offset": 0, "limit": 50, "hasMore": true, … },
  "next": [
    { "command": "tg contacts list --offset=50 --account=2", "why": "The next page of contacts." }
  ]
}
```

`next` sits beside `data`, not in it, because it is about the answer rather than part of the
command's own shape: every `data` field stays as it was, and a script that reads only `data`
sees no change. It is absent when there is nothing to suggest, and never names a command that
read-only mode or `allowedChats` would refuse. The commands, quoting rules and where each
appears: [cli-commands.md](cli-commands.md#next-commands).

## Output Modes

```bash
# JSON output (default)
tg contacts list
# {"success": true, "data": {...}}

# Pretty output for humans (pretty-printed JSON payload; next commands on stderr)
tg contacts list --format pretty

# Quiet mode (no output, just exit code)
tg send --to @user --message "Hi" --format quiet
# or
tg send --to @user --message "Hi" --quiet
```

## Error Handling

All errors are returned as JSON on stderr (unless `--quiet`). A flag the command doesn't declare
(`--acount 2`) and a value it takes nowhere (`--silent false` or `--silent=no`: a boolean flag
takes no value but `=true` or `=false`, so write `--silent` or `--no-silent`) are `INVALID_ARGS`
(exit 3) before the command runs.
`tg api` and `tg sql` pass their flags on and are not checked.

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limited for upload.getFile. Wait 42s before retrying.",
    "details": {
      "method": "upload.getFile",
      "wait_seconds": 42
    },
    "suggestion": "Wait 42s, then run the same command again to resume the download",
    "retryable": true
  }
}
```

- `code` and `message` are always there; `details` holds the code's own fields.
- `suggestion`, when there is one, says what to run or change. A command in it runs as written;
  "the same command" means the one that failed, unchanged.
- `retryable` is always there. `true` means the same command, run again unchanged, can
  succeed: after `details.wait_seconds` for `RATE_LIMITED`, at once for `NETWORK_ERROR` and
  for a download that waited too long for another tg process, and for a `tg api` call that
  Telegram failed on its side (`details.telegramErrorCode` 500 or -503). `false` means
  something has to change first, such as the arguments, the account or the daemon.

`RATE_LIMITED` always carries the wait in `details.wait_seconds` and the method in
`details.method`, whichever command hit it: the first FLOOD_WAIT from Telegram, and every
later call to that method while the account's wait runs, even from another tg process.

```json
{
  "success": false,
  "error": {
    "code": "ACCOUNT_NOT_FOUND",
    "message": "Account with ID 99 not found",
    "suggestion": "Run tg accounts list to see the accounts, then pass an ID, @username or label to --account",
    "retryable": false
  }
}
```

Exit codes:

- 0: Success
- 1: General error
- 2: Authentication required
- 3: Invalid arguments
- 4: Network error
- 5: Telegram API error / rate limited
- 6: Account not found

`tg media download` adds these codes, all exit 1 ([media.md](media.md)):

- `NO_MEDIA`: the message has no file to download, or no preview with `--thumb`;
  `details: { chatId, messageId, messageType }` or `{ chatId, messageId, reason: "no_thumbnail" }`.
- `MESSAGE_NOT_FOUND`: Telegram has no such message in the chat; `details: { chatId, messageId }`.
  `tg messages get` still reports a missing message as `TELEGRAM_ERROR`.
- `CONTENT_PROTECTED`: the chat, channel, private chat or message has content protection, or the
  media self-destructs; `details: { chatId, messageId, reason }`, `reason` being `message`,
  `chat`, `private_chat` or `self_destructing`.
- `MEDIA_UNSUPPORTED`: the file is served from Telegram's CDN, which tg doesn't support yet;
  `details: { reason: "cdn" }`.
- `FILE_EXISTS` includes `details.path`. A single ID requires `--overwrite` for an existing
  target. A batch accepts identical bytes and rejects conflicting output from two IDs even
  with `--overwrite`.

`tg media transcribe` adds `TRANSCRIBER_NOT_FOUND` (exit 1): no speech-to-text program or no
ffmpeg on `PATH`; `details: { chatId, messageId, searched, runner, ffmpeg }` (the message, the names looked for, and the path
found for each or `null`), with install commands for the OS (and for whisper.cpp the model download and
`tg config set transcribe.model`) as `suggestion`. A message that is
not a voice note or video note is `MEDIA_UNSUPPORTED` with `details.reason: "not_speech"`
([media.md](media.md#transcribe)).

A single download that stalls for 60 seconds or loses its connection is `NETWORK_ERROR` (exit 4) with
`details.resumable: true`; a flood wait over 10 seconds is `RATE_LIMITED` (exit 5) with
`details: { method: "upload.getFile", wait_seconds }`. Both are `retryable` and keep the partial
download for the next run. A download that waits more than 10 minutes for another tg process
downloading the same file is `GENERAL_ERROR`, also `retryable`. A download stopped with Ctrl-C
or SIGTERM exits 130. A batch keeps the JSON lines already printed. It pauses for flood waits of
up to 300 seconds and exits 1 if any file fails. The [batch download contract](media.md#several-messages)
gives the retry limits.

`DAEMON_NOT_RUNNING` (exit 1) is returned by `tg daemon stop` without a daemon, and by
`tg messages wait` and `watch` when the daemon doesn't run for the account, with
`details: { account_id }` and a suggestion to start it
([cli-commands.md](cli-commands.md#waiting-for-new-messages)).

[Read-only mode and allowed chats](configuration.md#read-only-mode-and-allowed-chats) add two
codes, both exit 1, checked before the command connects:

- `READ_ONLY`: read-only mode is on and the command changes something on Telegram;
  `details: { command }`, plus `method` for `tg api`.
- `CHAT_NOT_ALLOWED`: the chat is not in `allowedChats`, `details: { chat, id }` (as given, and
  its marked ID); or the command is `tg sql` or `tg api`, which can't be limited to chats,
  `details: { command }`.

`DAEMON_ALREADY_RUNNING` (exit 1) is returned by `tg db vacuum` for a cache that only a full
VACUUM can compact while the daemon runs, with `details: { account_id, auto_vacuum: "none" }`
and the commands to stop and restart the daemon as `suggestion`
([cli-commands.md](cli-commands.md#cache-maintenance)).

## Account Context

Every command runs in the context of one account, and each account has its own cache
(`accounts/<id>/cache.db`), so a command reads and writes only that account's data. The
account is the one `--account` selects, else the active account, else the only account:

- no account: `AUTH_REQUIRED` (exit 2);
- several accounts and none active: `NO_ACTIVE_ACCOUNT` (exit 1), with `details.accounts`
  listing `{ id, phone, username, label }` for each;
- a selector that matches nothing: `ACCOUNT_NOT_FOUND` (exit 6);
- an account whose cache can't be opened yet: `CACHE_UNAVAILABLE` (exit 1), with
  `details: { reason, path }`. `reason` is `shared_cache_in_use` (an older tg still holds the
  shared cache of 0.3 and older), `move_failed` or `owner_mismatch` (the file belongs to
  another account).

```bash
# Set active account
tg accounts switch --id 1

# Or specify per-command
tg contacts list --account 2
tg contacts list --account @myuser
tg contacts list --account "Work"
tg api messages.getHistory --account 2 --peer @user
```

## Peer Resolution

Peers can be specified in multiple formats:

- Username: `@username`
- Phone: `+15551234567`
- User ID: `123456789`
- Basic group ID: `-123456789`
- Channel or supergroup ID: `-1001234567890`

These are marked peer IDs, the format every command prints (`tg chats list`, `tg messages search`,
`tg sql`) and every cache table stores. A positive number is a user, so a bare number is looked
up in the cache as one first: a user with an access hash, then a private chat in `chats_cache`,
then a user known without an access hash, or a DM with sync state or cached messages. Next it may be
a group or channel ID as 0.2.0 printed it (N for basic group -N or channel -100…N), when the
cache knows that chat; a number that names both is `INVALID_ARGS`. If the cache doesn't know the
number, one with 10 or more digits is tried as a phone number and a shorter one is taken as a
user ID without an access hash, never as a basic group: basic group N is always `-N`. Write
phone numbers with `+` to skip the ID lookup. Negative IDs resolve from the cache, with the
chat's access hash, or from the ID alone with no API call. Telegram may refuse a user or channel
peer built without an access hash; cache reads don't need one. Users that an `@username` or
phone lookup returns are cached, so the next lookup by ID needs no API call.

A command that changes Telegram (`tg send`, `tg messages read`, a `tg api` method that is not a
read) resolves an `@username` with `contacts.resolveUsername`, never from the cache: a username
can move to another user or chat, and its previous owner keeps it in the cache until fetched
again. Pass an ID to skip that call. Reads stay cache-first and take the latest fetched owner
of a username.

Note: `tg chats get` fetches from Telegram by **@username only**; an ID works for a cached chat.
An ID the cache doesn't hold, or any ID with `--fresh`, is `INVALID_ARGS` (exit 3) before any
Telegram call, so it needs no account or credentials.
`tg chats get --id` and `tg chats sync` read a cached ID with the same check as `tg send --to` and
`tg messages --chat`: a positive number the cache knows as a user (a private chat, a cached user, a
DM with sync state or cached messages) is that user, and only otherwise a group or channel ID as
0.2.0 printed it.

## Type System

The CLI leverages mtcute's strict TypeScript types:

- Method names are validated against TL schema
- Arguments are type-checked
- Return types are known at compile time

## Implementation Notes

### Generic API Implementation

```typescript
// src/commands/api.ts (simplified)
export const apiCommand = defineCommand({
  args: {
    method: { type: "positional" },
    json: { type: "string" },
    account: { type: "string" },
    raw: { type: "boolean", default: false },
  },
  async run({ args }) {
    const { account } = openAccountCache(args.account);
    let client: TelegramClient | undefined;
    try {
      client = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: "cli:api",
        accountId: account.id,
      });
      const params = mergeArgs(args, args.json);
      // Typed by the TL schema: chats resolved, longs as Long, zeros filled
      const request = await buildApiRequest(args.method, params, resolveChat);
      const result = await client.call(request);
      await closeClient(client);

      if (args.raw) {
        raw(JSON.stringify(result, replacer, 2));
      } else {
        success({ method: args.method, result });
      }
    } catch (err) {
      await closeClient(client);
      error(ErrorCodes.TELEGRAM_ERROR, `API call failed: ${err.message}`, {
        method: args.method,
      });
    }
  },
});

// destroy() closes the connection, which would keep the process alive, and
// saves the session. A failure to close doesn't change the result.
async function closeClient(client: TelegramClient | undefined) {
  await client?.destroy().catch(() => {});
}
```

Every path closes the client before it prints, and `raw()`, `success()` and `error()` exit the
process after printing. A new command that connects to Telegram should do the same: a path that
prints with `console.log` and returns leaves the command running.

### Caching Pattern

Commands that fetch data follow a consistent caching pattern:

```typescript
// Example from src/commands/contacts.ts
if (!args.fresh) {
  const cached = usersCache.getByUsername(identifier);
  if (cached) {
    const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers);
    success({
      ...cachedData,
      source: "cache",
      stale,
    });
    return;
  }
}

// Fetch from API and cache
const result = await client.call({ _: "contacts.resolveUsername", username });
usersCache.upsert(apiUserToCacheInput(result));

success({ ...freshData, source: "api", stale: false });
```
