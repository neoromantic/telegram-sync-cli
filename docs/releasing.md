# Releasing

A release is a `vX.Y.Z` tag on `main`. Pushing the tag runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which publishes everything.

## Steps

1. Start from a green `main`. Open a PR with one commit, `chore(release): X.Y.Z`, that:
   - sets `version` in `package.json` to `X.Y.Z`;
   - renames `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] - YYYY-MM-DD`, adds a new empty
     `## [Unreleased]` above it, and updates the compare links at the bottom.
2. Merge the PR once `ci` is green.
3. Tag the merge commit and push the tag:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

## What the workflow does

1. `verify` (Linux): checks that the tag matches `package.json` and isn't a prerelease, that
   `CHANGELOG.md` has a section for it, then runs `check`, `test`, `test:e2e`, and builds and
   runs the Linux binary.
2. `release` (macOS), in the `release` environment:
   1. builds every binary with `bun run build:all`, runs the darwin-arm64 one and writes
      `checksums.txt`;
   2. attests the binaries' build provenance;
   3. publishes the npm package with trusted publishing (GitHub OIDC, Node 24), unless that
      version is already on npm;
   4. creates the GitHub Release as a draft with the binaries, `checksums.txt` and the
      `CHANGELOG.md` section as notes, then publishes it;
   5. writes `Formula/tg.rb` in [`neoromantic/homebrew-tap`](https://github.com/neoromantic/homebrew-tap)
      after `brew audit --strict --online` passes. The formula comes from
      [`.github/scripts/formula.sh`](../.github/scripts/formula.sh); don't edit it in the tap.

Every step can be re-run: a version already on npm is skipped, a published release is left
alone, and the tap keeps a formula that is already current or newer.

## Check the release

```bash
gh release view vX.Y.Z --json isDraft,assets --jq '{isDraft, assets: [.assets[].name]}'
npm view @goodit/telegram-sync-cli@X.Y.Z version dist.attestations.provenance
brew install neoromantic/tap/tg && tg --version
```

Before tagging, run the live smoke suite (`bun run test:integration`, see
[testing.md](testing.md)) when Telegram calls, sync or the daemon changed.

## One-time setup

Done once per repo, listed here so it can be checked or redone:

- npm trusted publisher for `@goodit/telegram-sync-cli`: GitHub repo
  `neoromantic/telegram-sync-cli`, workflow `release.yml`, environment `release`.
- GitHub environment `release`, limited to `v*` tags, with the secret `HOMEBREW_TAP_KEY`: the
  private half of a write deploy key on `neoromantic/homebrew-tap`.
