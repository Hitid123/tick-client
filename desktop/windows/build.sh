#!/bin/sh
# Builds the Windows desktop satellite into client/tick-satellite-windows.exe,
# which install-windows.mjs ships. Cross-compiled from any machine with Go:
#
#   sh client/desktop/windows/build.sh
#
# Plain Win32 through Go's syscall package, no dependencies. -H windowsgui so no
# console window opens with it; -s -w to leave out debug tables.
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$HERE/satellite"
go test ./...
GOOS=windows GOARCH=amd64 go vet ./...
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui -s -w" -o "$HERE/../../tick-satellite-windows.exe" .
echo "built $HERE/../../tick-satellite-windows.exe"
