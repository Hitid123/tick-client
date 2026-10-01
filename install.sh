#!/bin/sh
# TICK installer. Idempotent, reversible, and loud about what it touches.
#
#   ./install.sh [--yes] [--api-base URL]
#
# Everything it changes outside ~/.tick is a single field in
# ~/.claude/settings.json, and that file is backed up byte-for-byte first.

set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TICK_HOME="${TICK_HOME:-$HOME/.tick}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
ASSUME_YES="${TICK_ASSUME_YES:-0}"
API_BASE=''

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --api-base) API_BASE="${2:-}"; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

die() { printf 'tick: %s\n' "$1" >&2; exit 1; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else printf 'nohash'
  fi
}

# --- prerequisites -----------------------------------------------------------
command -v jq >/dev/null 2>&1 || die 'jq is required. macOS: brew install jq   Debian/Ubuntu: sudo apt install jq'
command -v node >/dev/null 2>&1 || die 'Node 20+ is required. See https://nodejs.org'
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ is required, found $(node -v)"

# --- files -------------------------------------------------------------------
mkdir -p "$TICK_HOME/state"
for f in statusline.sh nojq.sh daemon.mjs; do
  [ -f "$SRC/$f" ] || die "missing source file: $SRC/$f"
  cp "$SRC/$f" "$TICK_HOME/$f"
done
chmod +x "$TICK_HOME/statusline.sh" "$TICK_HOME/daemon.mjs"

if [ ! -f "$TICK_HOME/config.json" ]; then
  if [ -n "$API_BASE" ]; then
    jq -n --arg b "$API_BASE" '{api_base: $b, own_line: ""}' > "$TICK_HOME/config.json"
  else
    printf '{"own_line":""}\n' > "$TICK_HOME/config.json"
  fi
elif [ -n "$API_BASE" ]; then
  tmp="$TICK_HOME/config.json.tmp.$$"
  jq --arg b "$API_BASE" '.api_base = $b' "$TICK_HOME/config.json" > "$tmp" && mv "$tmp" "$TICK_HOME/config.json"
fi

# --- back up settings.json ---------------------------------------------------
mkdir -p "$CLAUDE_DIR"
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="$TICK_HOME/settings.backup.$STAMP.json"
HAD_FILE=0
HAD_FIELD=0

if [ -f "$SETTINGS" ]; then
  HAD_FILE=1
  cp "$SETTINGS" "$BACKUP"
  if jq -e 'has("statusLine")' "$SETTINGS" >/dev/null 2>&1; then HAD_FIELD=1; fi
  jq -e . "$SETTINGS" >/dev/null 2>&1 || die "$SETTINGS is not valid JSON; fix it before installing"
else
  : > "$BACKUP"   # empty backup marks "the file did not exist"
  printf '{}\n' > "$SETTINGS"
fi

if [ "$HAD_FIELD" -eq 1 ]; then
  printf '\ntick: ~/.claude/settings.json already has a statusLine:\n\n'
  jq '.statusLine' "$SETTINGS" | sed 's/^/    /'
  printf '\nIt is saved in %s\n' "$BACKUP"
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf 'Replace it? [y/N] '
    read -r answer </dev/tty || answer=n
    case "$answer" in [yY]*) ;; *) printf 'tick: aborted, nothing changed.\n'; exit 1 ;; esac
  fi
fi

TMP="$SETTINGS.tick.tmp.$$"
jq --arg cmd "$TICK_HOME/statusline.sh" \
   '.statusLine = {type: "command", command: $cmd, padding: 0, refreshInterval: 3}' \
   "$SETTINGS" > "$TMP"
mv "$TMP" "$SETTINGS"

jq -n --arg backup "$BACKUP" --arg hash "$(sha256 "$SETTINGS")" \
      --argjson had_file "$HAD_FILE" --argjson had_field "$HAD_FIELD" \
      --arg settings "$SETTINGS" \
  '{backup: $backup, settings: $settings, wrote_hash: $hash, had_file: ($had_file == 1), had_field: ($had_field == 1)}' \
  > "$TICK_HOME/install.manifest.json"

cat <<'DONE'

tick: installed.

  Status line   ~/.tick/statusline.sh   (wired into ~/.claude/settings.json)
  State         ~/.tick/state/
  Uninstall     ~/.tick/uninstall.sh

Start a new Claude Code session to see the line.
Note: with a status line configured, Claude Code hides most footer hints,
including "esc to interrupt". That is upstream behaviour, not ours.

Your own line: put it in ~/.tick/config.json as "own_line" (60 chars max).
It shows only when no paid creative is queued, and only to you.

DONE
cp "$SRC/uninstall.sh" "$TICK_HOME/uninstall.sh" 2>/dev/null || true
chmod +x "$TICK_HOME/uninstall.sh" 2>/dev/null || true
