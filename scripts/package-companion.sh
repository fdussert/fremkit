#!/usr/bin/env bash
# Package the Fremkit Companion extension for the Chrome Web Store.
#
#   bash scripts/package-companion.sh        -> dist/fremkit-companion-<version>.zip
#
# The zip holds companion/ as it is, minus dotfiles, with one change: the manifest's `key` is
# left out. The key pins the extension's ID when it is loaded unpacked from companion/; the store
# refuses a manifest that carries one and keeps the ID it gave the listing, which is the same
# (`COMPANION_EXTENSION_ID` in server/src/companion/protocol.ts). Upload the zip from the
# listing's Package tab; the store refuses a version it has already seen, so bump `version` in
# companion/manifest.json first.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="companion"
VERSION="$(node -p 'require("./companion/manifest.json").version')"
OUT="dist/fremkit-companion-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

rsync -a --exclude '.*' "$SRC/" "$STAGE/"
node -e '
  const fs = require("fs")
  const file = process.argv[1]
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"))
  delete manifest.key
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n")
' "$STAGE/manifest.json"

mkdir -p dist
rm -f "$OUT"
# -X: no extended attributes or Mac resource forks; the store sees only the files.
(cd "$STAGE" && zip -q -X -r "$OLDPWD/$OUT" .)

echo "packaged: $OUT ($(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
