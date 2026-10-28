# Known gaps

Plans and known gaps live in [GitHub issues](https://github.com/neoromantic/telegram-sync-cli/issues).
What ships today is described in the [README](README.md) and [`docs/`](docs/).
The list is in priority order.

## Reliability

- [Storage north star: bounded size, big caches, offloading, SQLite alternatives](https://github.com/neoromantic/telegram-sync-cli/issues/80)
- [Background, resumable migrations for big caches](https://github.com/neoromantic/telegram-sync-cli/issues/89)
- [`tg db check` and `tg db backup`](https://github.com/neoromantic/telegram-sync-cli/issues/91)
- [A soft cache size budget per account](https://github.com/neoromantic/telegram-sync-cli/issues/98)
- [Option to cache live messages only in synced chats](https://github.com/neoromantic/telegram-sync-cli/issues/100)
- [`raw_json`: stop storing fileReference](https://github.com/neoromantic/telegram-sync-cli/issues/95)
- [`raw_json`: measure zstd with a trained dictionary](https://github.com/neoromantic/telegram-sync-cli/issues/97)
- [Archive old messages into separate files](https://github.com/neoromantic/telegram-sync-cli/issues/101)

## Features

- [Wait for new messages](https://github.com/neoromantic/telegram-sync-cli/issues/24)
- [Unread messages and mark as read](https://github.com/neoromantic/telegram-sync-cli/issues/25)
- [Transcribe voice messages and video notes](https://github.com/neoromantic/telegram-sync-cli/issues/102)
- [Download many attachments at once, with name templates](https://github.com/neoromantic/telegram-sync-cli/issues/104)
- [Search media on the server, beyond the cached history](https://github.com/neoromantic/telegram-sync-cli/issues/105)
- [Background media download in the daemon, with a disk quota](https://github.com/neoromantic/telegram-sync-cli/issues/99)
- [Extract text from documents and images (PDF, office files, OCR)](https://github.com/neoromantic/telegram-sync-cli/issues/103)
- [Edit, delete, forward and pin messages](https://github.com/neoromantic/telegram-sync-cli/issues/23)
- [Read-only mode and a chat allowlist for agents](https://github.com/neoromantic/telegram-sync-cli/issues/26)
- [Semantic search over messages](https://github.com/neoromantic/telegram-sync-cli/issues/82)
- [Search: find other word forms without a manual prefix](https://github.com/neoromantic/telegram-sync-cli/issues/92)
- [Search attachment names, kinds and text derived from attachments](https://github.com/neoromantic/telegram-sync-cli/issues/94)
- [Keep earlier versions of edited messages](https://github.com/neoromantic/telegram-sync-cli/issues/96)
- [AI integration (skills)](https://github.com/neoromantic/telegram-sync-cli/issues/3)

## Polish

- [`tg status --sizes`: cache size per chat](https://github.com/neoromantic/telegram-sync-cli/issues/90)
- [Search: re-index older messages after a person or chat is renamed](https://github.com/neoromantic/telegram-sync-cli/issues/93)
- [Pretty output for every command](https://github.com/neoromantic/telegram-sync-cli/issues/2)
- [Replace qrcode-terminal](https://github.com/neoromantic/telegram-sync-cli/issues/10)
