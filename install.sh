#!/bin/sh
# TICK installer. Idempotent, reversible, and loud about what it touches.
#
#   ./install.sh [--yes] [--api-base URL] [--no-desktop]
#
# Outside ~/.tick it changes ~/.claude/settings.json, backed up byte-for-byte
# first: the statusLine field, and on macOS three hook entries for the Claude
# desktop app. On macOS it also adds one login item, the desktop satellite,
# and, where Codex is installed, the same hook for the Codex app in
# ~/.codex/config.toml. Where OpenCode is installed, its plugin folder gets one
# file of ours. --no-desktop skips the macOS parts.

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
# Optional, so an installer fetched by an older bootstrap still works.
[ -f "$SRC/opencode-plugin.js" ] && cp "$SRC/opencode-plugin.js" "$TICK_HOME/opencode-plugin.js"

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
HEARTBEAT_ADDED=0
if [ "$DESKTOP" -eq 1 ]; then
  BEFORE=$(sha256 "$SETTINGS")
  # Were the three turn hooks already there? Then the editor extension put them
  # there and they stay its own; at most the heartbeat is ours.
  BASE_PRESENT=0
  jq -e --arg cmd "$HOOK_CMD" '(.hooks // {}) as $h | all("UserPromptSubmit", "Stop", "SessionEnd";
      . as $ev | any(($h[$ev] // [])[]?; any(.hooks[]?; .command == $cmd)))' "$SETTINGS" >/dev/null 2>&1 \
    && BASE_PRESENT=1
  # Three turn boundaries, and PostToolUse as a heartbeat in the background
  # (async), so a turn longer than ten minutes keeps its line. See hook.mjs.
  jq --arg cmd "$HOOK_CMD" '
    reduce ("UserPromptSubmit", "Stop", "SessionEnd", "PostToolUse") as $ev (.;
      if any((.hooks[$ev] // [])[]?; any(.hooks[]?; .command == $cmd)) then .
      else .hooks[$ev] = ((.hooks[$ev] // []) + [{hooks: [({type: "command", command: $cmd, timeout: 5}
                                                     + (if $ev == "PostToolUse" then {async: true} else {} end))]}])
      end)' "$SETTINGS" > "$TMP"
  mv "$TMP" "$SETTINGS"
  # Already there means the editor extension put it there, and it stays its own:
  # uninstalling the terminal client must not take the editor's hook with it.
  if [ "$(sha256 "$SETTINGS")" != "$BEFORE" ]; then
    if [ "$BASE_PRESENT" -eq 1 ]; then HEARTBEAT_ADDED=1; else HOOK_ADDED=1; fi
  fi
fi

# --- the same hook for the Codex app (macOS) -----------------------------------
# The Codex app runs Codex's hooks from ~/.codex/config.toml, like the Codex CLI
# and the editor; the satellite draws its line over the Codex window from them.
# One marked block appended, nothing else in the file read or rewritten — the
# block the editor extension writes, which either side recognises. Codex asks
# to review a new hook once before it runs it; that is its trust check, not ours
# to skip.
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_CONFIG="$CODEX_DIR/config.toml"
CODEX_ADDED=0
if [ "$DESKTOP" -eq 1 ] && { [ -d "$CODEX_DIR" ] || [ -d /Applications/Codex.app ]; }; then
  if ! grep -qF '# >>> TICK activity hook' "$CODEX_CONFIG" 2>/dev/null; then
    mkdir -p "$CODEX_DIR"
    [ -f "$CODEX_CONFIG" ] && cp "$CODEX_CONFIG" "$TICK_HOME/codex-config.backup.$STAMP.toml"
    node - "$CODEX_CONFIG" "node \"$TICK_HOME/hook.mjs\" cx" <<'NODE'
const fs = require('node:fs');
const [file, command] = process.argv.slice(2);
let text = '';
try { text = fs.readFileSync(file, 'utf8'); } catch {}
const body = ['UserPromptSubmit', 'Stop', 'SessionEnd'].map((e) => [
  `[[hooks.${e}]]`, 'matcher = ""', `[[hooks.${e}.hooks]]`, 'type = "command"',
  `command = ${JSON.stringify(command)}`, 'timeout = 3',
].join('\n')).join('\n\n');
const block = ['# >>> TICK activity hook — added by the TICK installer',
  '# Remove it with ~/.tick/uninstall.sh. Codex will ask you to review this hook',
  '# before it runs; that is its own trust check, and we do not get around it.',
  body, '# <<< TICK activity hook'].join('\n');
const base = text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text;
fs.writeFileSync(`${file}.tick.tmp`, `${base}${base.length > 0 ? '\n' : ''}${block}\n`);
fs.renameSync(`${file}.tick.tmp`, file);
NODE
    CODEX_ADDED=1
  fi
fi

# --- OpenCode ----------------------------------------------------------------
# No command hooks there; a plugin file of ours in its plugins folder writes the
# same three-field note. Only where OpenCode has been run.
OPENCODE_PLUGIN="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/tick.js"
OPENCODE_ADDED=0
if [ -d "$(dirname "$(dirname "$OPENCODE_PLUGIN")")" ] && [ -f "$TICK_HOME/opencode-plugin.js" ]; then
  mkdir -p "$(dirname "$OPENCODE_PLUGIN")"
  cmp -s "$TICK_HOME/opencode-plugin.js" "$OPENCODE_PLUGIN" 2>/dev/null || cp "$TICK_HOME/opencode-plugin.js" "$OPENCODE_PLUGIN"
  OPENCODE_ADDED=1
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
  [ "$(jq -r '.codex_added // false' "$MANIFEST")" = true ] && CODEX_ADDED=1
  [ -n "$(jq -r '.heartbeat // empty' "$MANIFEST")" ] && [ "$HOOK_ADDED" -eq 0 ] && HEARTBEAT_ADDED=1
fi

jq -n --arg backup "$BACKUP" --arg hash "$(sha256 "$SETTINGS")" \
      --argjson had_file "$HAD_FILE" --argjson had_field "$HAD_FIELD" \
      --arg settings "$SETTINGS" --arg hook "$HOOK_CMD" --argjson hook_added "$HOOK_ADDED" \
      --arg codex "$CODEX_CONFIG" --argjson codex_added "$CODEX_ADDED" --argjson heartbeat_added "$HEARTBEAT_ADDED" \
      --arg opencode "$OPENCODE_PLUGIN" --argjson opencode_added "$OPENCODE_ADDED" \
  '{backup: $backup, settings: $settings, wrote_hash: $hash, had_file: ($had_file == 1), had_field: ($had_field == 1),
    hook: (if $hook_added == 1 then $hook else null end),
    heartbeat: (if $heartbeat_added == 1 then $hook else null end),
    codex_config: $codex, codex_added: ($codex_added == 1),
    opencode_plugin: (if $opencode_added == 1 then $opencode else null end)}' \
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
      # bootout returns before the job is gone, and bootstrapping over a job
      # that is still leaving fails: the owner's update on 08.10 ended with
      # "will start at your next login" and no strip. Wait for it to go, up
      # to five seconds, and give the bootstrap a second try.
      i=0
      while launchctl print "$JOB" >/dev/null 2>&1 && [ "$i" -lt 25 ]; do sleep 0.2; i=$((i + 1)); done
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
        || { sleep 1; launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; } \
        || printf 'tick: the desktop satellite will start at your next login\n'
    fi
  fi
fi

# --- the Claude Code plugin ----------------------------------------------------
# Where Claude Code is installed, its own plugin system draws the line in the
# band above the prompt, in the terminal and in the Claude app alike, and the
# strip over the Claude window stands aside for it. Installed with Claude
# Code's own command, from the catalogue in the public repository; Claude Code
# can show and remove it like any plugin. Only for a real install: the tests
# run with a sandbox HOME, and this reaches GitHub.
PLUGIN_ADDED=0
REAL_HOME=${REAL_HOME:-$(eval echo "~$(id -un)")}
if [ "${TICK_NO_PLUGIN:-0}" != 1 ] && [ "$HOME" = "$REAL_HOME" ] && command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add Hitid123/tick-client >/dev/null 2>&1 || true
  if claude plugin install tick@tick >/dev/null 2>&1; then
    PLUGIN_ADDED=1
  else
    printf 'tick: the Claude Code plugin did not install; the strip covers the Claude app instead\n'
  fi
fi
if [ -f "$MANIFEST" ]; then
  tmp="$MANIFEST.tmp.$$"
  jq --argjson p "$PLUGIN_ADDED" '.plugin_added = (.plugin_added == true or $p == 1)' "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
fi

# --- a daemon already running is the old code ------------------------------
# It goes on serving with what it was started with until something stops it;
# the status line starts the new one within seconds. Only our own process:
# the pid file could be stale and the number someone else's by now.
PIDF="$TICK_HOME/state/daemon.pid"
if [ -f "$PIDF" ]; then
  pid=$(tr -d ' \n' <"$PIDF" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*) ;;
    *) if ps -p "$pid" -o command= 2>/dev/null | grep -qF "$TICK_HOME/daemon.mjs"; then
         kill "$pid" 2>/dev/null || true
       fi ;;
  esac
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
