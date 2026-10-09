#!/bin/sh
# Regenerates SHA256SUMS for the files bootstrap.sh downloads.
# Run this before tagging a release; commit the result.

set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# The Claude Code plugin carries its own copy of the daemon, for machines
# where the plugin is all that was installed. Always this one.
cp daemon.mjs claude-mod/tick/runtime/daemon.mjs

FILES="statusline.sh nojq.sh daemon.mjs hook.mjs opencode-plugin.js install.sh uninstall.sh tick-satellite-macos TICK.icns tick-satellite-windows.exe install-windows.mjs"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 $FILES > SHA256SUMS
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum $FILES > SHA256SUMS
else
  printf 'release.sh: no sha256 tool found\n' >&2
  exit 1
fi

# The same list, for the server: running clients update themselves to what
# the server names (selfUpdate in daemon.mjs), so a release is live once the
# server is deployed AND the public repository has the files.
node -e '
const fs = require("fs");
const files = {};
for (const line of fs.readFileSync("SHA256SUMS", "utf8").split("\n")) {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
  if (m) files[m[2]] = m[1];
}
fs.writeFileSync("../server/lib/client-release.json", JSON.stringify({ files }, null, 2) + "\n");
'

printf 'wrote SHA256SUMS and server/lib/client-release.json:\n\n'
cat SHA256SUMS
