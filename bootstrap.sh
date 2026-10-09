#!/bin/sh
# TICK one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Hitid123/tick-client/main/bootstrap.sh | sh
#
# If piping a stranger's script into a shell makes you uncomfortable, good.
# Do this instead, it is the same thing with a reading step:
#
#   curl -fsSL https://raw.githubusercontent.com/Hitid123/tick-client/main/bootstrap.sh -o tick-install.sh
#   less tick-install.sh
#   sh tick-install.sh
#
# This script downloads the client's files (six, plus the desktop satellite on
# a Mac), checks them against published checksums, and runs the real installer.
# It needs no root. Outside ~/.tick it touches ~/.claude/settings.json, backed
# up first, and on a Mac one login item for the satellite. install.sh says
# exactly what, and --no-desktop leaves the Mac parts out.

set -eu

REPO="${TICK_REPO:-Hitid123/tick-client}"
REF="${TICK_REF:-}"
# GitHub's file host caches "main" for a few minutes, file by file: just after
# a release one file can still be the old one while the checksums are new, and
# the install stops, rightly, on the mismatch (10.10). So the release is pinned
# to its commit first and every file comes from that one snapshot.
if [ -z "$REF" ] && [ -z "${TICK_BASE:-}" ] && command -v curl >/dev/null 2>&1; then
  SHA=$(curl -fsSL --proto '=https' --connect-timeout 10 --max-time 20 \
    -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/main" 2>/dev/null || true)
  if printf '%s' "$SHA" | grep -Eq '^[0-9a-f]{40}$'; then REF=$SHA; fi
fi
REF="${REF:-main}"
BASE="${TICK_BASE:-https://raw.githubusercontent.com/$REPO/$REF}"
FILES="statusline.sh nojq.sh daemon.mjs hook.mjs opencode-plugin.js install.sh uninstall.sh"
# The desktop satellite is a Mac program; nobody else needs to download it.
[ "$(uname -s)" = Darwin ] && FILES="$FILES tick-satellite-macos TICK.icns"

die() { printf 'tick: %s\n' "$1" >&2; exit 1; }

# HTTPS is required, with one exception: a loopback address, so that a developer
# can point TICK_BASE at a local server. Anything else over plain http is
# refused rather than downgraded.
case "$BASE" in
  https://*)                    PROTOS='=https' ;;
  http://127.0.0.1[:/]*|http://127.0.0.1|\
  http://localhost[:/]*|http://localhost|\
  http://\[::1\][:/]*)          PROTOS='=http,https' ;;
  http://*)                     die "refusing plain http for a non-local host: $BASE" ;;
  *)                            die "TICK_BASE must be an http(s) URL: $BASE" ;;
esac

# Timeouts are not optional here. A stalled connection with no deadline leaves
# someone who just pasted a one-liner staring at a dead terminal, with no way to
# tell a slow network from a hung installer.
CONNECT_TIMEOUT=10
MAX_TIME=120

fetch() {
  # $1 = url, $2 = destination
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto "$PROTOS" --tlsv1.2 \
      --connect-timeout "$CONNECT_TIMEOUT" --max-time "$MAX_TIME" \
      "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    case "$1$PROTOS" in
      http://*'=https') die 'wget cannot enforce https here; install curl' ;;
    esac
    wget -q --connect-timeout="$CONNECT_TIMEOUT" --timeout="$MAX_TIME" --tries=2 -O "$2" "$1"
  else
    die 'curl or wget is required'
  fi
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else printf ''
  fi
}

printf 'tick: fetching the client from %s\n' "$BASE"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/tick-install.XXXXXX") || die 'cannot create a temp directory'
trap 'rm -rf "$TMP"' EXIT INT TERM

for f in $FILES; do
  fetch "$BASE/$f" "$TMP/$f" || die "cannot download $f"
  [ -s "$TMP/$f" ] || die "$f came back empty"
done

# Checksums are published next to the files. They prove the download arrived
# intact and matches the tagged release; they are not a substitute for reading
# the code, which is why the repository is public.
if fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS" 2>/dev/null && [ -s "$TMP/SHA256SUMS" ]; then
  if [ -n "$(sha256_of "$TMP/statusline.sh")" ]; then
    for f in $FILES; do
      want=$(awk -v n="$f" '$2 == n || $2 == "*"n { print $1 }' "$TMP/SHA256SUMS" | head -1)
      [ -n "$want" ] || die "no checksum published for $f; refusing to continue"
      got=$(sha256_of "$TMP/$f")
      [ "$want" = "$got" ] || die "checksum mismatch for $f
  expected $want
  got      $got
This is either a corrupted download or a tampered file. Nothing was installed."
    done
    printf 'tick: checksums verified\n'
  else
    printf 'tick: no sha256 tool found, skipping verification\n' >&2
  fi
else
  printf 'tick: no SHA256SUMS published at this ref, skipping verification\n' >&2
fi

chmod +x "$TMP/install.sh" "$TMP/uninstall.sh"

# Deliberately not exec: the EXIT trap has to survive long enough to remove the
# temp directory, and install.sh has already copied what it needs by then.
sh "$TMP/install.sh" "$@"
exit $?
