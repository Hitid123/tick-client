#!/bin/sh
# Builds the macOS desktop satellite as one universal binary, Apple Silicon and
# Intel, into client/tick-satellite-macos, plus its icon, client/TICK.icns.
# The installer wraps the two into ~/.tick/TICK.app.
#
#   sh client/desktop/macos/build.sh
#
# One Swift file, no dependencies, no Xcode project: swiftc from the command
# line tools is enough. Ad-hoc signed, which is what Apple Silicon requires to
# run a binary at all. It is installed by a command in the terminal, the same
# way as the rest of the client, so no Developer ID is needed; one comes in
# only if we ever ship a download from the website.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT="$HERE/../../tick-satellite-macos"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/tick-sat.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" -o "$TMP/sat-$arch" "$HERE/Satellite.swift" -framework AppKit
done
lipo -create -output "$OUT" "$TMP/sat-arm64" "$TMP/sat-x86_64"
codesign --force --sign - --identifier dev.gettick.satellite "$OUT"
chmod +x "$OUT"
echo "built $OUT ($(lipo -archs "$OUT"))"

# The app icon, so the login item macOS lists reads "TICK" with our mark rather
# than a grey "exec". Made from the brand kit's 512px icon.
ICON_SRC="$HERE/../../../server/public/icon-512.png"
ICONSET="$TMP/TICK.iconset"
mkdir -p "$ICONSET"
for size in 16 32 128 256; do
  sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
cp "$ICON_SRC" "$ICONSET/icon_512x512.png"
iconutil -c icns -o "$HERE/../../TICK.icns" "$ICONSET"
echo "built $HERE/../../TICK.icns"
