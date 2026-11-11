#!/bin/bash
# Refreshes this folder from GitHub in place (Mac). Double-click or run in Terminal.
# The extension notices the new files within ~30 seconds and reloads itself.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$dir/.git" ] && command -v git >/dev/null; then exec git -C "$dir" pull --ff-only; fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
echo "Downloading the latest TestPad Pocket..."
curl -fsSL https://codeload.github.com/ayeepat/testpad-pocket/zip/refs/heads/main -o "$tmp/main.zip"
unzip -q "$tmp/main.zip" -d "$tmp"
src="$tmp/testpad-pocket-main"
test -f "$src/manifest.json"
# manifest.json goes last: its new version number is what triggers the reload.
rsync -a --exclude manifest.json "$src/" "$dir/"
cp "$src/manifest.json" "$dir/manifest.json"
echo "Done: $(grep -m1 '"version"' "$dir/manifest.json" | tr -d ' ,'). The extension reloads itself within 30 seconds."
