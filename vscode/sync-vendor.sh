#!/bin/sh
# Copies the runtime files the extension ships into vendor/.
#
# The extension carries the daemon and the hook rather than linking to them,
# because on a machine that never ran install.sh — a Windows machine, in
# practice — the editor is the only installer there is. vendor/ is generated
# and not committed: a stale committed copy of the daemon is a bug that would
# only ever show up as money going missing.

set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$SRC/vendor"
for f in daemon.mjs hook.mjs opencode-plugin.js; do
  cp "$SRC/../$f" "$SRC/vendor/$f"
done
mkdir -p "$SRC/vendor/opencode/tick"
for f in index.ts tui.tsx shared.js package.json; do
  [ -f "$SRC/../opencode/tick/$f" ] && cp "$SRC/../opencode/tick/$f" "$SRC/vendor/opencode/tick/$f"
done
printf 'vendor: daemon.mjs, hook.mjs, opencode-plugin.js and opencode/tick/ copied from client/\n'
