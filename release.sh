#!/bin/sh
# Regenerates SHA256SUMS for the files bootstrap.sh downloads.
# Run this before tagging a release; commit the result.

set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

FILES="statusline.sh nojq.sh daemon.mjs install.sh uninstall.sh"

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 $FILES > SHA256SUMS
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum $FILES > SHA256SUMS
else
  printf 'release.sh: no sha256 tool found\n' >&2
  exit 1
fi

printf 'wrote SHA256SUMS:\n\n'
cat SHA256SUMS
