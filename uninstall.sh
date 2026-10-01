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
