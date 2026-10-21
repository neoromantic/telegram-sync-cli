#!/bin/sh
# Put a release's formula in the Homebrew tap, neoromantic/homebrew-tap, so
# that `brew install neoromantic/tap/tg` finds it. The release workflow runs
# it after the GitHub Release is published.
#
#   .github/scripts/tap.sh TAG CHECKSUMS
#
# TAP_KEY holds the private half of the tap's deploy key, which can write to
# it: the release environment's secret HOMEBREW_TAP_KEY. A release older than
# the tap's leaves it alone, and running it again for the same release
# changes nothing, so a job that failed here can be rerun.
set -eu

tag=${1:?usage: tap.sh TAG CHECKSUMS}
sums=${2:?usage: tap.sh TAG CHECKSUMS}

fail() {
	echo "tap.sh: $*" >&2
	exit 1
}

[ -n "${TAP_KEY:-}" ] || fail "TAP_KEY is empty: add the tap's deploy key as the release environment's secret HOMEBREW_TAP_KEY, then rerun this job"

root=$(cd "$(dirname "$0")/../.." && pwd)
work=${RUNNER_TEMP:?RUNNER_TEMP must name a scratch directory}/tap
rm -rf "$work"
mkdir -p "$work"
audit=
cleanup() {
	rm -rf "$work"
	if [ -n "$audit" ]; then
		brew untap "$audit" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

sh "$root/.github/scripts/formula.sh" "$tag" "$sums" >"$work/tg.rb"

# Published files can take a moment to download; Homebrew must not find the
# formula before them.
base=https://github.com/neoromantic/telegram-sync-cli/releases/download/$tag
tries=0
for asset in tg-darwin-arm64 tg-darwin-x64 tg-linux-arm64 tg-linux-x64; do
	until curl -fsSIL -o /dev/null "$base/$asset"; do
		tries=$((tries + 1))
		[ "$tries" -lt 30 ] || fail "$base/$asset does not download after 5 minutes"
		sleep 10
	done
done

# The key in a file only this user reads, and GitHub's published host key,
# so ssh trusts nothing a network could hand it.
key=$work/key
known=$work/known_hosts
(umask 077 && printf '%s\n' "$TAP_KEY" >"$key")
echo "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl" >"$known"
export GIT_SSH_COMMAND="ssh -i '$key' -o IdentitiesOnly=yes -o UserKnownHostsFile='$known' -o StrictHostKeyChecking=yes"

git clone --quiet --depth 1 --branch main git@github.com:neoromantic/homebrew-tap.git "$work/tap"
mkdir -p "$work/tap/Formula"
held=
if [ -f "$work/tap/Formula/tg.rb" ]; then
	held=$(sed -n 's|.*/releases/download/v\([0-9]*\.[0-9]*\.[0-9]*\)/.*|\1|p' "$work/tap/Formula/tg.rb" | head -n 1)
fi
if [ -n "$held" ] && awk -v a="$held" -v b="${tag#v}" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) if (x[i] != y[i]) exit !(x[i] + 0 > y[i] + 0); exit 1 }'; then
	echo "tap.sh: the tap has v$held, later than $tag, and keeps it" >&2
	exit 0
fi
cp "$work/tg.rb" "$work/tap/Formula/tg.rb"
# Staged first, so the first formula, a new file, counts as a change.
git -C "$work/tap" add Formula/tg.rb
if git -C "$work/tap" diff --cached --quiet; then
	echo "tap.sh: the tap already has the formula of $tag" >&2
	exit 0
fi

# Homebrew's own checks, against the published files, in a tap of its own
# that is thrown away.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ANALYTICS=1
audit=ci/tgcli
brew tap-new --no-git "$audit" >/dev/null
cp "$work/tg.rb" "$(brew --repo "$audit")/Formula/tg.rb"
brew audit --strict --online --formula "$audit/tg"

git -C "$work/tap" -c user.name="telegram-sync-cli release" \
	-c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
	commit --quiet -m "tg $tag"
git -C "$work/tap" push --quiet origin HEAD:main
echo "tap.sh: the tap has the formula of $tag" >&2
