#!/bin/sh
# Print the Homebrew formula of a release, from its checksums.txt.
#
#   .github/scripts/formula.sh TAG CHECKSUMS
set -eu

tag=${1:?usage: formula.sh TAG CHECKSUMS}
sums=${2:?usage: formula.sh TAG CHECKSUMS}

sha() {
	awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$sums"
}

for asset in tg-darwin-arm64 tg-darwin-x64 tg-linux-arm64 tg-linux-x64; do
	if [ -z "$(sha "$asset")" ]; then
		echo "formula.sh: $sums has no $asset" >&2
		exit 1
	fi
done

base=https://github.com/neoromantic/telegram-sync-cli/releases/download/$tag

cat <<RUBY
class Tg < Formula
  desc "Telegram CLI with a local cache, a sync daemon and full MTProto API access"
  homepage "https://tg.sergeybaus.com"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
      url "$base/tg-darwin-arm64"
      sha256 "$(sha tg-darwin-arm64)"
    end
    on_intel do
      url "$base/tg-darwin-x64"
      sha256 "$(sha tg-darwin-x64)"
    end
  end
  on_linux do
    on_arm do
      url "$base/tg-linux-arm64"
      sha256 "$(sha tg-linux-arm64)"
    end
    on_intel do
      url "$base/tg-linux-x64"
      sha256 "$(sha tg-linux-x64)"
    end
  end

  def install
    bin.install Dir["tg-*"].first => "tg"
  end

  def caveats
    <<~EOS
      tg shares usage stats with its author: how often it runs, which features are used,
      errors, version and OS, tied to a random install ID. It never sends your files,
      arguments or account names. Turn it off with "tg telemetry off" or DO_NOT_TRACK=1.
      Details: https://usage.sergeybaus.com
    EOS
  end

  test do
    ENV["TELEGRAM_SYNC_CLI_TELEMETRY"] = "0"
    assert_equal version.to_s, shell_output("#{bin}/tg --version").strip
    assert_match '"enabled": false', shell_output("#{bin}/tg telemetry status --json")
  end
end
RUBY
