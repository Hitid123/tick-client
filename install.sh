#!/bin/sh
# TICK installer. Idempotent, reversible, and loud about what it touches.
#
#   ./install.sh [--yes] [--api-base URL] [--no-desktop]
#
# Outside ~/.tick it changes ~/.claude/settings.json, backed up byte-for-byte
# first: the statusLine field, and on macOS three hook entries for the Claude
# desktop app. On macOS it also adds one login item, the desktop satellite.
# --no-desktop skips both macOS parts.

set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TICK_HOME="${TICK_HOME:-$HOME/.tick}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
ASSUME_YES="${TICK_ASSUME_YES:-0}"
NO_DESKTOP="${TICK_NO_DESKTOP:-0}"
API_BASE=''

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1 ;;
    --api-base) API_BASE="${2:-}"; shift ;;
    --no-desktop) NO_DESKTOP=1 ;;
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
for f in statusline.sh nojq.sh daemon.mjs hook.mjs; do
  [ -f "$SRC/$f" ] || die "missing source file: $SRC/$f"
  cp "$SRC/$f" "$TICK_HOME/$f"
done
chmod +x "$TICK_HOME/statusline.sh" "$TICK_HOME/daemon.mjs"

# The Claude desktop app runs hooks but never a status line, so on a Mac the
# satellite draws the line there and the hook is its only signal.
DESKTOP=0
if [ "$(uname -s)" = Darwin ] && [ "$NO_DESKTOP" -ne 1 ] && [ -f "$SRC/tick-satellite-macos" ]; then
  DESKTOP=1
fi

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

# Our own line from an earlier install is not somebody else's to protect: an
# update should not ask. The line found before the first install is still in
# the manifest's backup, and uninstall still puts that one back.
OURS=0
if [ "$HAD_FIELD" -eq 1 ] && [ "$(jq -r '.statusLine.command? // ""' "$SETTINGS" 2>/dev/null)" = "$TICK_HOME/statusline.sh" ]; then
  OURS=1
fi

if [ "$HAD_FIELD" -eq 1 ] && [ "$OURS" -eq 0 ]; then
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

# --- activity hook (macOS, for the desktop app) ------------------------------
# The same entry the editor extension writes, in the same shape, so the two
# never duplicate each other: appended next to anyone else's hooks, never
# replacing them. The hook writes three fields and never opens the transcript.
HOOK_CMD="node \"$TICK_HOME/hook.mjs\" cc"
HOOK_ADDED=0
if [ "$DESKTOP" -eq 1 ]; then
  BEFORE=$(sha256 "$SETTINGS")
  jq --arg cmd "$HOOK_CMD" '
    reduce ("UserPromptSubmit", "Stop", "SessionEnd") as $ev (.;
      if any((.hooks[$ev] // [])[]?; any(.hooks[]?; .command == $cmd)) then .
      else .hooks[$ev] = ((.hooks[$ev] // []) + [{hooks: [{type: "command", command: $cmd, timeout: 5}]}])
      end)' "$SETTINGS" > "$TMP"
  mv "$TMP" "$SETTINGS"
  # Already there means the editor extension put it there, and it stays its own:
  # uninstalling the terminal client must not take the editor's hook with it.
  [ "$(sha256 "$SETTINGS")" = "$BEFORE" ] || HOOK_ADDED=1
fi

# A second install must not forget the first. The manifest's backup is what
# settings.json looked like before TICK ever touched it, and that is what
# uninstall.sh has to put back; a fresh backup taken now would already contain
# our own statusLine. The fresh one stays on disk as an extra copy.
MANIFEST="$TICK_HOME/install.manifest.json"
if [ -f "$MANIFEST" ] && PREV_BACKUP=$(jq -r '.backup // empty' "$MANIFEST" 2>/dev/null) \
   && [ -n "$PREV_BACKUP" ] && [ -f "$PREV_BACKUP" ]; then
  BACKUP="$PREV_BACKUP"
  [ "$(jq -r '.had_file' "$MANIFEST")" = true ] && HAD_FILE=1 || HAD_FILE=0
  [ "$(jq -r '.had_field' "$MANIFEST")" = true ] && HAD_FIELD=1 || HAD_FIELD=0
  PREV_HOOK=$(jq -r '.hook // empty' "$MANIFEST")
  [ -n "$PREV_HOOK" ] && HOOK_ADDED=1
fi

jq -n --arg backup "$BACKUP" --arg hash "$(sha256 "$SETTINGS")" \
      --argjson had_file "$HAD_FILE" --argjson had_field "$HAD_FIELD" \
      --arg settings "$SETTINGS" --arg hook "$HOOK_CMD" --argjson hook_added "$HOOK_ADDED" \
  '{backup: $backup, settings: $settings, wrote_hash: $hash, had_file: ($had_file == 1), had_field: ($had_field == 1),
    hook: (if $hook_added == 1 then $hook else null end)}' \
  > "$TICK_HOME/install.manifest.json"

# --- desktop satellite (macOS) -----------------------------------------------
# A small program of ours that draws the line over the Claude desktop app. It
# asks macOS for no permission: it sees the outer frame of Claude's window and
# nothing inside it. Started at login by launchd, removed by uninstall.sh.
PLIST="$HOME/Library/LaunchAgents/dev.gettick.satellite.plist"
APP="$TICK_HOME/TICK.app"
if [ "$DESKTOP" -eq 1 ]; then
  # A real app bundle rather than a bare binary, so macOS names it TICK: in the
  # login items list and in its "can run in the background" notice, which uses
  # the executable's name. No Dock icon, no menu: LSUIElement.
  #
  # That notice is macOS's own and it fires for every new or changed background
  # item. Without a Developer ID every build counts as a new item, so we touch
  # the bundle and launchd only when what we ship actually changed. Reinstalling
  # the same version stays silent.
  SOURCE="bundle-3 $(sha256 "$SRC/tick-satellite-macos") $( [ -f "$SRC/TICK.icns" ] && sha256 "$SRC/TICK.icns")"
  APP_CHANGED=0
  if [ "$(cat "$APP/Contents/Resources/source" 2>/dev/null)" != "$SOURCE" ]; then
    APP_CHANGED=1
    rm -rf "$APP" "$TICK_HOME/tick-satellite"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    cp "$SRC/tick-satellite-macos" "$APP/Contents/MacOS/TICK"
    chmod +x "$APP/Contents/MacOS/TICK"
    [ -f "$SRC/TICK.icns" ] && cp "$SRC/TICK.icns" "$APP/Contents/Resources/TICK.icns"
    cat > "$APP/Contents/Info.plist" <<INFO_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>TICK</string>
  <key>CFBundleDisplayName</key><string>TICK</string>
  <key>CFBundleIdentifier</key><string>dev.gettick.satellite</string>
  <key>CFBundleExecutable</key><string>TICK</string>
  <key>CFBundleIconFile</key><string>TICK</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
INFO_END
    # The version marker goes in before signing: the signature seals every file
    # in the bundle, and one written after it breaks the seal.
    printf '%s' "$SOURCE" > "$APP/Contents/Resources/source"
    # Ad-hoc, as the binary already is: it binds Info.plist to the code, which
    # is all macOS needs to show the bundle's name. No Developer ID involved.
    codesign --force --sign - --identifier dev.gettick.satellite "$APP" 2>/dev/null || true
  fi

  mkdir -p "$HOME/Library/LaunchAgents"
  NODE_DIR=$(dirname "$(command -v node)")
  cat > "$PLIST.new" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.gettick.satellite</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/TICK</string></array>
  <key>AssociatedBundleIdentifiers</key><string>dev.gettick.satellite</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/bin:/bin</string>
    <key>TICK_HOME</key><string>$TICK_HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PLIST_END
  PLIST_CHANGED=0
  if cmp -s "$PLIST.new" "$PLIST"; then rm -f "$PLIST.new"; else mv "$PLIST.new" "$PLIST"; PLIST_CHANGED=1; fi

  # launchctl acts on the real login session whatever $HOME says, and the tests
  # run this script with a sandbox HOME. Only a real install starts anything.
  REAL_HOME=$(eval echo "~$(id -un)")
  if [ "$HOME" = "$REAL_HOME" ] && [ "${TICK_NO_LAUNCHD:-0}" != 1 ]; then
    JOB="gui/$(id -u)/dev.gettick.satellite"
    if [ "$APP_CHANGED" -eq 1 ] || [ "$PLIST_CHANGED" -eq 1 ] || ! launchctl print "$JOB" >/dev/null 2>&1; then
      launchctl bootout "$JOB" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
        || printf 'tick: the desktop satellite will start at your next login\n'
    fi
  fi
fi

cat <<'DONE'

tick: installed.

  Status line   ~/.tick/statusline.sh   (wired into ~/.claude/settings.json)
  State         ~/.tick/state/
  Uninstall     ~/.tick/uninstall.sh

Start a new Claude Code session to see the line.
On a Mac, the Claude desktop app gets it too: a strip under the message box
while Claude works. Turn it off with "desktop": {"enabled": false} in
~/.tick/config.json, or install with --no-desktop.
Note: with a status line configured, Claude Code hides most footer hints,
including "esc to interrupt". That is upstream behaviour, not ours.

Your own line: put it in ~/.tick/config.json as "own_line" (60 chars max).
It shows only when no paid creative is queued, and only to you.

DONE
cp "$SRC/uninstall.sh" "$TICK_HOME/uninstall.sh" 2>/dev/null || true
chmod +x "$TICK_HOME/uninstall.sh" 2>/dev/null || true
