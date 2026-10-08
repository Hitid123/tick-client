#!/bin/sh
# TICK uninstaller. Leaves the machine exactly as it was found.
#
# If ~/.claude/settings.json has not been touched since install, it is restored
# byte-for-byte from the backup, so `diff` before/after is empty (TZ section 4.6).
# If it HAS changed, we only undo our own field and say so, rather than silently
# throwing away someone else's edits.

set -eu

TICK_HOME="${TICK_HOME:-$HOME/.tick}"
MANIFEST="$TICK_HOME/install.manifest.json"

say() { printf 'tick: %s\n' "$1"; }

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else printf 'nohash'
  fi
}

# --- stop the daemon ---------------------------------------------------------
PIDF="$TICK_HOME/state/daemon.pid"
if [ -f "$PIDF" ]; then
  pid=$(tr -d ' \n' <"$PIDF" 2>/dev/null || true)
  case "$pid" in
    ''|*[!0-9]*) ;;
    *) kill "$pid" 2>/dev/null || true ;;
  esac
fi

# --- stop the desktop satellite (macOS) -------------------------------------
PLIST="$HOME/Library/LaunchAgents/dev.gettick.satellite.plist"
if [ -f "$PLIST" ]; then
  # Same guard as the installer: launchctl reaches the real login session, so
  # it is only called when $HOME is the real one.
  REAL_HOME=$(eval echo "~$(id -un)")
  if [ "$HOME" = "$REAL_HOME" ] && [ "${TICK_NO_LAUNCHD:-0}" != 1 ]; then
    launchctl bootout "gui/$(id -u)/dev.gettick.satellite" 2>/dev/null || true
  fi
  rm -f "$PLIST"
  say 'stopped the desktop satellite and removed its login item'
fi

# --- the Claude Code plugin ----------------------------------------------------
if [ -f "$MANIFEST" ] && command -v jq >/dev/null 2>&1 && [ "$(jq -r '.plugin_added // false' "$MANIFEST")" = true ] \
   && command -v claude >/dev/null 2>&1; then
  claude plugin uninstall tick@tick >/dev/null 2>&1 || true
  claude plugin marketplace remove tick >/dev/null 2>&1 || true
  say 'removed the Claude Code plugin'
fi

# --- the Codex hook and the OpenCode plugin -----------------------------------
# Only what the installer recorded adding, and only our own bytes.
if [ -f "$MANIFEST" ] && command -v jq >/dev/null 2>&1; then
  CODEX_CONFIG=$(jq -r '.codex_config // empty' "$MANIFEST")
  if [ "$(jq -r '.codex_added // false' "$MANIFEST")" = true ] && [ -f "$CODEX_CONFIG" ] \
     && command -v node >/dev/null 2>&1; then
    # The block between our two markers, and the blank line before it. A file
    # we created that holds nothing else afterwards goes too.
    node - "$CODEX_CONFIG" <<'NODE' && say 'removed our Codex hook from config.toml'
const fs = require('node:fs');
const file = process.argv[2];
const s = fs.readFileSync(file, 'utf8');
const start = s.indexOf('# >>> TICK activity hook');
const endMark = start === -1 ? -1 : s.indexOf('# <<< TICK activity hook', start);
if (endMark === -1) process.exit(1);
const before = s.slice(0, start).replace(/\n+$/, start > 0 ? '\n' : '');
const after = s.slice(endMark + '# <<< TICK activity hook'.length).replace(/^\n+/, '');
const next = `${before}${after}`;
if (next.trim() === '') fs.unlinkSync(file); else fs.writeFileSync(file, next);
NODE
  fi
  CURSOR_HOOKS=$(jq -r '.cursor_hooks // empty' "$MANIFEST")
  CURSOR_CMD=$(jq -r '.cursor_cmd // empty' "$MANIFEST")
  if [ "$(jq -r '.cursor_added // false' "$MANIFEST")" = true ] && [ -f "$CURSOR_HOOKS" ] && [ -n "$CURSOR_CMD" ]; then
    jq --arg cmd "$CURSOR_CMD" '
      .hooks = ((.hooks // {}) | with_entries(.value |= (if type == "array" then map(select(.command != $cmd)) else . end))
                | with_entries(select((.value | type) != "array" or (.value | length) > 0)))' "$CURSOR_HOOKS" > "$CURSOR_HOOKS.tick.tmp" \
      && mv "$CURSOR_HOOKS.tick.tmp" "$CURSOR_HOOKS"
    # A file that holds nothing but what we created goes too.
    if jq -e '.hooks == {} and (keys - ["version", "hooks"]) == []' "$CURSOR_HOOKS" >/dev/null 2>&1; then rm -f "$CURSOR_HOOKS"; fi
    say 'removed our hook from Cursor'
  fi
  OPENCODE_PLUGIN=$(jq -r '.opencode_plugin // empty' "$MANIFEST")
  if [ -n "$OPENCODE_PLUGIN" ] && cmp -s "$OPENCODE_PLUGIN" "$TICK_HOME/opencode-plugin.js" 2>/dev/null; then
    rm -f "$OPENCODE_PLUGIN"
    say 'removed our OpenCode plugin'
  fi
fi

# --- restore settings.json ---------------------------------------------------
if [ -f "$MANIFEST" ] && command -v jq >/dev/null 2>&1; then
  SETTINGS=$(jq -r '.settings' "$MANIFEST")
  BACKUP=$(jq -r '.backup' "$MANIFEST")
  WROTE=$(jq -r '.wrote_hash' "$MANIFEST")
  HAD_FILE=$(jq -r '.had_file' "$MANIFEST")

  STAGE=$(mktemp -d "${TMPDIR:-/tmp}/tick-uninstall.XXXXXX")
  if [ -f "$BACKUP" ]; then cp "$BACKUP" "$STAGE/backup.json"; else : > "$STAGE/backup.json"; fi

  if [ ! -f "$SETTINGS" ]; then
    say "$SETTINGS is already gone, nothing to restore"
  elif [ "$(sha256 "$SETTINGS")" = "$WROTE" ]; then
    if [ "$HAD_FILE" = 'true' ]; then
      cp "$STAGE/backup.json" "$SETTINGS"
      say "restored $SETTINGS byte-for-byte"
    else
      rm -f "$SETTINGS"
      say "removed $SETTINGS (it did not exist before install)"
    fi
  else
    say "$SETTINGS changed since install; removing only our own fields"
    TMP="$SETTINGS.tick.tmp.$$"
    if [ -s "$STAGE/backup.json" ] && jq -e 'has("statusLine")' "$STAGE/backup.json" >/dev/null 2>&1; then
      jq --slurpfile old "$STAGE/backup.json" '.statusLine = $old[0].statusLine' "$SETTINGS" > "$TMP"
      say 'your previous statusLine was put back'
    else
      jq 'del(.statusLine)' "$SETTINGS" > "$TMP"
    fi
    mv "$TMP" "$SETTINGS"

    # Our hook entries, matched by their exact command, and only the containers
    # that end up empty because of it. Anyone else's hooks stay where they were.
    HOOK_CMD=$(jq -r '.hook // empty' "$MANIFEST")
    if [ -n "$HOOK_CMD" ]; then
      jq --arg cmd "$HOOK_CMD" '
        if (.hooks | type) == "object" then
          .hooks |= with_entries(
            .value |= (if type == "array"
              then map(if (.hooks | type) == "array" then .hooks |= map(select(.command != $cmd)) else . end)
                   | map(select((.hooks | type) != "array" or (.hooks | length) > 0))
              else . end))
          | .hooks |= with_entries(select((.value | type) != "array" or (.value | length) > 0))
          | if .hooks == {} then del(.hooks) else . end
        else . end' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
      say 'removed our activity hook'
    fi
    # Only the heartbeat was ours (the editor extension owns the other three):
    # take it from PostToolUse alone.
    BEAT_CMD=$(jq -r '.heartbeat // empty' "$MANIFEST")
    if [ -n "$BEAT_CMD" ]; then
      jq --arg cmd "$BEAT_CMD" '
        if (.hooks.PostToolUse | type) == "array" then
          .hooks.PostToolUse |= (map(if (.hooks | type) == "array" then .hooks |= map(select(.command != $cmd)) else . end)
                                 | map(select((.hooks | type) != "array" or (.hooks | length) > 0)))
          | if .hooks.PostToolUse == [] then del(.hooks.PostToolUse) else . end
        else . end' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
      say 'removed our heartbeat hook'
    fi

    # The daemon may have appended a spinner verb for the user's own line.
    # Remove it only if the value on disk is still exactly what we wrote — if
    # someone edited it since, it is theirs now and we leave it alone.
    SPIN="$TICK_HOME/state/spinner.json"
    if [ -f "$SPIN" ] && jq -e '.wrote != null' "$SPIN" >/dev/null 2>&1; then
      if jq -e --slurpfile s "$SPIN" '.spinnerVerbs == $s[0].wrote' "$SETTINGS" >/dev/null 2>&1; then
        jq 'del(.spinnerVerbs)' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
        say 'removed the spinner verb we added'
      else
        say 'left spinnerVerbs alone: it no longer matches what we wrote'
      fi
    fi
    say 'note: JSON formatting may differ from the original file'
  fi
  rm -rf "$STAGE"
else
  say 'no install manifest found; settings.json left untouched'
fi

# --- remove everything else --------------------------------------------------
rm -rf "$TICK_HOME"
say 'removed ~/.tick, uninstall complete'
