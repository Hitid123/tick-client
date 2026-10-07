#!/bin/sh
# Copies the two runtime files the extension ships into vendor/.
#
# The extension carries the daemon and the hook rather than linking to them,
# because on a machine that never ran install.sh — a Windows machine, in
# practice — the editor is the only installer there is. vendor/ is generated
# and not committed: a stale committed copy of the daemon is a bug that would
# only ever show up as money going missing.

set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$SRC/vendor"
for f in daemon.mjs hook.mjs; do
  cp "$SRC/../$f" "$SRC/vendor/$f"
done
printf 'vendor: daemon.mjs and hook.mjs copied from client/\n'
