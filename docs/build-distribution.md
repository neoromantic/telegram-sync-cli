# Build & Distribution

> **Status:** Implemented

## Overview

telegram-sync-cli ships two ways:

- npm: source (Bun-run TypeScript). The `tg` bin is an ESM shim (`bin/tg.js`,
  `#!/usr/bin/env bun`) that imports `src/index.ts`. Nothing is compiled at
  install time and there is no `postinstall` step. Requires Bun >= 1.4.
- GitHub Releases and Homebrew: standalone binaries (Bun runtime and SQLite
  included) for every platform below, built by the release workflow. The
  Homebrew formula `neoromantic/tap/tg` installs them; see
  [releasing.md](releasing.md).

## Build Commands

```bash
# Build native binary for current platform
bun run build

# Minified build with sourcemaps
bun run build:minify

# Cross-compile for all supported platforms
bun run build:all
```

Output:
- Current platform binary: `dist/tg` (built locally)
- Cross-build outputs: `dist/tg-<platform>` from `scripts/build-all.ts`

## Install / Test Commands

```bash
# Test that the compiled binary runs
bun run test:build

# Test global installation via bun link
bun run test:install
```

## Global Installation (Local)

```bash
# From local source
bun link

# From the npm registry (Bun >= 1.4 on PATH)
bun i -g @goodit/telegram-sync-cli
```

## Supported Platforms

- `bun-darwin-arm64`
- `bun-darwin-x64`
- `bun-linux-x64`
- `bun-linux-arm64`
- `bun-windows-x64`

## Notes

- The compiled binary includes the Bun runtime and SQLite; size is 70–100 MB.
- The npm tarball excludes the binary; `tg` runs from source with Bun.
- The version comes only from `package.json` (`src/version.ts` reads it).
- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are required only by commands that
  connect to Telegram; help, version and offline commands work without them.
