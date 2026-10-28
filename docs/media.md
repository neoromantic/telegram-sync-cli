# Media

> **Status: Implemented**

`tg send --file` sends one file. `tg media download` saves a message's file into the account's
media cache and prints its path. `tg messages list`, `get` and `search` show what file each
message has. The daemon downloads and uploads nothing.

## Attachments

Every message item has `attachment`: the message's file, or `null` when it has none.

```json
{
  "kind": "document",
  "source": "message",
  "fileName": "report.pdf",
  "mimeType": "application/pdf",
  "size": 482133,
  "duration": null,
  "width": null,
  "height": null,
  "uniqueFileId": "AgADexample42",
  "groupedId": null
}
```

- `kind`: `photo`, `video`, `round` (video note), `animation` (GIF), `voice`, `audio`,
  `sticker` or `document`.
- `source`: `message`, or `webpage` for the photo or file of a link preview.
- `fileName` is the name the sender gave a document; photos have none. `size` is in bytes (a
  photo's largest size), `duration` in seconds.
- `uniqueFileId` is the same for the same file in every chat. `groupedId` is the album ID;
  messages sent as one album share it.

`tg` reads it from the message's `raw_json` when it prints the item, so messages cached by
older versions have it too. Polls, locations, contacts and dice have no file:
`attachment: null`.

For `tg sql`, the table `message_attachments` has one row per cached message with a file,
written with the message. Messages cached by 0.6.0 and older get theirs from a
[background migration](database-schema.md#background-migrations), which the daemon or
`tg db migrate` runs. Columns:
[database-schema.md](database-schema.md#table-message_attachments).

## Download

```bash
tg media download --chat me --id 42                      # into the cache, prints the path
tg media download --chat @examplegroup --id 1200 --out ./downloads/
tg media download --chat -1001234567890 --id 77 --out ./photo.jpg
tg media download --chat me --id 42 --out - > report.pdf # the bytes alone on stdout
tg media download --chat me --id 42 --thumb              # the file's small preview
```

`--chat` takes the same forms as `tg messages list`. Output:

```json
{
  "success": true,
  "data": {
    "path": "/path/to/downloads/report.pdf",
    "cachePath": "/path/to/.telegram-sync-cli/accounts/1/media/AgADexample42/report.pdf",
    "fileName": "report.pdf",
    "mimeType": "application/pdf",
    "size": 482133,
    "kind": "document",
    "chatId": 5550001,
    "messageId": 42,
    "uniqueFileId": "AgADexample42",
    "groupedId": null,
    "cached": false,
    "resumedFrom": null,
    "thumb": null
  }
}
```

- `path` is the `--out` copy, or the cached file without `--out`; `cachePath` is always the
  cached file.
- `cached` is `true` when no bytes were downloaded in this run. `resumedFrom` is the byte
  offset a partial download continued from, else `null`.
- With `--thumb`, `path`, `fileName`, `mimeType`, `size` and `uniqueFileId` describe the
  preview, `kind` is `thumbnail` and `thumb` is `{ type, width, height }`.

How a run gets the file:

1. **From the cache.** When the message is cached, its file is in the media cache and the cache
   knows of no content protection, the command needs no network and no Telegram credentials.
   Each such run marks the file as used now, for `tg media clean --older-than`.
2. **From Telegram.** Otherwise, or with `--fresh`, it fetches the message again. That gives a
   fresh file reference and updates the cached message. It checks content protection (below),
   then downloads the file into the cache.

- A download writes to a partial file first. A failed or interrupted run keeps it, and the next
  run continues from its last whole 512 KB part (`resumedFrom`). The complete file is renamed
  into the cache, so the cache never holds half a file.
- A download that receives nothing for 60 seconds ends with `NETWORK_ERROR`,
  `details: { stalled_seconds: 60, downloaded_bytes, resumable: true }`. Run the command again
  to resume.
- Flood waits of up to 10 seconds are slept through. A longer one ends the command with
  `RATE_LIMITED`, `details: { method: "upload.getFile", wait_seconds }`, recorded for the
  account like any other call ([rate-limiting.md](rate-limiting.md)).
- Ctrl-C or SIGTERM keeps the partial file, prints how much is kept to stderr and exits 130,
  with no JSON.
- Progress goes to stderr, only when stderr is a terminal.
- Two runs that download the same file, such as a file and a forwarded copy, don't write it
  together: the second waits, then serves the finished file from the cache. It waits up to 10
  minutes, then ends with `GENERAL_ERROR`, `details: { lock, pid, waited_seconds }`. A running
  download refreshes its lock; a lock whose process is gone, or that nobody refreshed for a
  minute (a crashed run), is taken over.

### `--out`

- A directory (an existing one, or a path ending in `/`): the file is copied there under its
  cached name.
- A file path: the file is copied to that path; missing parent directories are created.
- `-`: the bytes go to stdout with no JSON. Errors still go to stderr as JSON.
- An existing target is `FILE_EXISTS` (exit 1), `details: { path }`. Pass `--overwrite` to
  replace it. `tg` never picks a numbered name.

### `--thumb`

Downloads the small preview instead of the file: size `m` (320 px) of a photo if it has one,
else its smallest size; the largest preview of a document. It goes into the same cache folder
as `thumb-<type>.jpg` (`.webp` for stickers). A file without a preview is `NO_MEDIA` with
`details.reason: "no_thumbnail"`.

## Content protection

Telegram's [content protection](https://core.telegram.org/api/content-protection) forbids saving
media from protected chats and messages. `tg media download` refuses with `CONTENT_PROTECTED`
(exit 1), `details: { chatId, messageId, reason }`:

| `reason` | When |
|----------|------|
| `message` | the message itself forbids saving |
| `chat` | the group or channel restricts saving content |
| `private_chat` | a private chat where you or the other person turned on protection |
| `self_destructing` | the media has a self-destruct timer |

A refused run downloads nothing. A file already cached stays in the cache, but the command
won't serve it either. A protection found online is kept: the message's in its cached row, the
chat's in `chat_content_protection`. Later runs refuse those files offline too, until an online
check (`--fresh`, or a download of a file the cache lacks) finds the protection turned off. When
Telegram sends the message without its chat, the protection last known holds. A chat object the
cache got after the last online check, from `tg chats get` or the daemon, counts too. A
protection turned on after that and never seen isn't known offline; `--fresh` checks again.

## Media cache

```
accounts/<id>/media/
└── <uniqueFileId>/
    ├── report.pdf           # the file: one copy per file per account
    ├── .report.pdf.part     # a partial download, continued by the next run
    ├── thumb-m.jpg          # a --thumb preview
    └── .lock                # a download is running: its pid, refreshed while it runs
```

The file keeps the sender's name, made safe for every file system (no folders, control or bidi
characters or reserved names, at most 200 bytes). A file without a name is `<kind>.<ext>`:
`photo.jpg`, `voice.ogg`, `file.pdf`, or `.bin` for a type `tg` doesn't know. The media cache
is counted apart from `cache.db`; `tg status --sizes` shows each account's
(`accounts.accounts[].media`, `storage.media_bytes`).

### `tg media clean`

```bash
tg media clean                      # only partial downloads untouched for a day
tg media clean --older-than 30d     # files not used for 30 days
tg media clean --chat @examplegroup # the files of one chat's messages
tg media clean --all                # everything
```

- Bare, it removes only partial downloads nobody wrote to for 24 hours, so it is always safe.
  Every run also removes those.
- `--older-than` takes a duration back from now (`30d`, `12h`), a date (`2026-10-01`) or a date
  and time (`2026-10-01T09:30`). A file counts as used when it was downloaded or served from
  the cache.
- `--chat` removes the files of that chat's cached messages; a file a message of another chat
  also holds stays (`sharedFiles`). Both come from `message_attachments`, so messages cached by
  0.6.0 and older count once their background migration has reached them (`tg db migrate`
  finishes it); a removed file downloads again. It combines with `--older-than`. `--all` doesn't combine with either
  (`INVALID_ARGS`).
- A folder whose download is running is skipped. The command never writes `cache.db` and opens
  no connection, unless `--chat` names a chat the cache doesn't know.

```json
{ "accountId": 1, "removedFiles": 3, "removedPartialFiles": 1, "freedBytes": 18350080,
  "keptFiles": 12, "sharedFiles": 1,
  "filters": { "all": false, "olderThan": "2026-09-28T09:30:00.000Z", "chat": null } }
```

## Send a file

```bash
tg send --to me --file ./report.pdf --caption "Q3"
tg send --to @username --file ./photo.jpg               # sent as a photo
tg send --to @username --file ./photo.jpg --force-document
```

- JPEG, PNG and WebP images up to 10 MB go as photos; everything else, GIFs and videos
  included, as documents with their file name. `--force-document` sends an image as a file.
- One file per message: a second `--file` is `INVALID_ARGS` (albums aren't supported yet).
  `--caption` is the text sent with the file; `--message` doesn't combine with `--file`.
- `--reply-to` and `--silent` work as for text. The sent message goes into the cache with its
  attachment.
- The result adds `file: { name, mimeType, size, sentAs }` (`sentAs`: `photo` or `document`)
  and `attachment`; its `uniqueFileId` is the media cache folder `tg media download` saves the
  file in.

## Limits

- Files Telegram serves from its CDN can't be downloaded yet: `MEDIA_UNSUPPORTED`,
  `details: { reason: "cdn" }`.
- `tg send` doesn't send albums, voice messages or video notes yet.
- The daemon downloads nothing.
- Follow-ups: attachment names in search
  ([#94](https://github.com/neoromantic/telegram-sync-cli/issues/94)), background downloads with
  a disk quota ([#99](https://github.com/neoromantic/telegram-sync-cli/issues/99)), voice
  transcription ([#102](https://github.com/neoromantic/telegram-sync-cli/issues/102)), text from
  documents and images ([#103](https://github.com/neoromantic/telegram-sync-cli/issues/103)),
  batch downloads with name templates
  ([#104](https://github.com/neoromantic/telegram-sync-cli/issues/104)) and server-side media
  search ([#105](https://github.com/neoromantic/telegram-sync-cli/issues/105)).
