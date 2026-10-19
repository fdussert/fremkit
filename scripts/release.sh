#!/usr/bin/env bash
# Build everything a release publishes, and stop before publishing anything.
#
#   bash scripts/release.sh X.Y.Z
#
# Run it on the release commit (CHANGELOG section renamed to "## X.Y.Z", the four version fields
# bumped; see docs/releasing.md). It refuses a dirty tree or a version that does not match, then:
# builds and signs Fremkit.app, notarizes and staples it, builds, notarizes and staples the DMG,
# zips the app for Sparkle and signs that zip with the EdDSA key in the login keychain, writes
# the appcast and the release notes, and fills the Homebrew cask's version and sha256. It ends by
# printing the commands that publish — tag, GitHub release, cask — for the owner to run. Nothing
# here pushes, tags or uploads.
#
# Environment:
#   FREMKIT_SPARKLE_KEY_FILE   sign the update with this private key file instead of the
#                              keychain (`sign_update --ed-key-file`). For local update tests.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "usage: bash scripts/release.sh X.Y.Z" >&2
    exit 2
fi
TAG="v$VERSION"
REPO_URL="https://github.com/fdussert/fremkit"
DIST="native/dist"

# --- Refusals -----------------------------------------------------------------------------------
# Not even an untracked file: build-app.sh copies widgets/ and themes/ wholesale, so a stray
# folder in there would ship.
if [ -n "$(git status --porcelain)" ]; then
    echo "error: the working tree is not clean; commit or stash first:" >&2
    git status --short >&2
    exit 1
fi
# Nor an ignored one where build-app.sh copies whole folders from: .gitignore hides `dist/`,
# `.env`, `*.pem` and the like from the check above, and they would ship signed and notarized.
# .DS_Store is the one exception: build-app.sh leaves it out of every copy.
ignored="$(git status --porcelain --ignored -- widgets themes brand/wallpaper \
    scripts/claude-hook.sh scripts/claude-statusline.sh server/src/bridge | { grep -v '/\.DS_Store$' || true; })"
if [ -n "$ignored" ]; then
    echo "error: ignored files inside folders the app ships; remove them first:" >&2
    printf '%s\n' "$ignored" >&2
    exit 1
fi
for override in FREMKIT_APP_VERSION FREMKIT_SPARKLE_PUBLIC_KEY FREMKIT_SPARKLE_FEED_URL FREMKIT_SIGN_IDENTITY; do
    if [ -n "${!override:-}" ]; then
        echo "error: $override is set; a release is built from the repository alone" >&2
        exit 1
    fi
done

mismatch=0
check_version() {
    local file="$1" found="$2"
    if [ "$found" != "$VERSION" ]; then
        echo "error: $file says ${found:-nothing}, not $VERSION" >&2
        mismatch=1
    fi
}
json_version() { node -p "require('./$1').version"; }
check_version package.json "$(json_version package.json)"
check_version server/package.json "$(json_version server/package.json)"
check_version ui/package.json "$(json_version ui/package.json)"
# shellcheck source=lib/version.sh
source scripts/lib/version.sh
check_version server/src/version.ts "$(fremkit_version)"
# The landing page names the version it offers; every mention must follow the release.
for site_version in $(grep -o 'data-fremkit-version>[^<]*' site/index.html | cut -d'>' -f2 | sort -u); do
    check_version site/index.html "$site_version"
done
grep -q 'data-fremkit-version>' site/index.html || check_version site/index.html ""
[ "$mismatch" -eq 0 ] || exit 1

mkdir -p "$DIST"
NOTES="$DIST/release-notes-$VERSION.md"
node scripts/lib/appcast.mjs notes "$VERSION" CHANGELOG.md > "$NOTES"

if [ -z "$({ grep -v '^#' packaging/sparkle/public-key.txt || true; } | tr -d '[:space:]')" ]; then
    echo "error: packaging/sparkle/public-key.txt holds no key; an app without one can never be updated" >&2
    exit 1
fi

# --- Build, sign, notarize ----------------------------------------------------------------------
# From a clean work folder: build-app.sh reuses an already-extracted Node and Sparkle there to
# keep everyday builds fast, without checking them again. A release ships those bytes, so they
# are extracted afresh from the hash-checked archives in the cache.
rm -rf native/.build/app
bash scripts/build-app.sh
APP="$DIST/Fremkit.app"
built="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[ "$built" = "$VERSION" ] || { echo "error: built $built, expected $VERSION" >&2; exit 1; }
bash scripts/notarize.sh
DMG="$DIST/Fremkit-$VERSION.dmg"
# The same DMG under a name that never changes, so the site can link
# $REPO_URL/releases/latest/download/Fremkit.dmg and start the download itself.
LATEST_DMG="$DIST/Fremkit.dmg"
cp "$DMG" "$LATEST_DMG"

# --- Sparkle ------------------------------------------------------------------------------------
# The update is the stapled app, zipped the way Sparkle documents. The private key never leaves
# the keychain: sign_update reads it there (macOS may ask to allow that once).
ZIP="$DIST/Fremkit-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
# shellcheck source=lib/pins.sh
source scripts/lib/pins.sh
SIGN_UPDATE="$SPARKLE_DIR/bin/sign_update"
if [ -n "${FREMKIT_SPARKLE_KEY_FILE:-}" ]; then
    signed="$("$SIGN_UPDATE" --ed-key-file "$FREMKIT_SPARKLE_KEY_FILE" "$ZIP")"
else
    signed="$("$SIGN_UPDATE" "$ZIP")"
fi
signature="$(sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p' <<<"$signed")"
length="$(sed -n 's/.*length="\([0-9]*\)".*/\1/p' <<<"$signed")"
if [ -z "$signature" ] || [ -z "$length" ]; then
    echo "error: sign_update printed no signature: $signed" >&2
    exit 1
fi
# Checked against the key the app carries, the way Sparkle will: a signature from any other key —
# a test key left in FREMKIT_SPARKLE_KEY_FILE, a second keychain item — would publish an update
# every installed copy refuses.
APP_KEY="$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist")"
node scripts/lib/appcast.mjs verify "$ZIP" "$signature" "$APP_KEY"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
node scripts/lib/appcast.mjs appcast "$VERSION" "$BUILD" \
    "$REPO_URL/releases/download/$TAG/Fremkit-$VERSION.zip" "$length" "$signature" "$NOTES" \
    > "$DIST/appcast.xml"
# The feed is signed too, with the same key: the app requires it (SURequireSignedFeed), and refuses
# an unsigned or altered one. sign_update embeds the signature in the XML; nothing may touch the
# file afterwards. The zip's check above already tied this key to the one the app carries.
if [ -n "${FREMKIT_SPARKLE_KEY_FILE:-}" ]; then
    "$SIGN_UPDATE" --ed-key-file "$FREMKIT_SPARKLE_KEY_FILE" "$DIST/appcast.xml" >/dev/null
    "$SIGN_UPDATE" --verify --ed-key-file "$FREMKIT_SPARKLE_KEY_FILE" "$DIST/appcast.xml"
else
    "$SIGN_UPDATE" "$DIST/appcast.xml" >/dev/null
    "$SIGN_UPDATE" --verify "$DIST/appcast.xml"
fi

# --- Homebrew -----------------------------------------------------------------------------------
DMG_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
CASK="packaging/homebrew/fremkit.rb"
sed -i '' -e "s/^  version \".*\"/  version \"$VERSION\"/" -e "s/^  sha256 \".*\"/  sha256 \"$DMG_SHA\"/" "$CASK"

cat <<EOF

Release $VERSION is built. Nothing has been published.

  $DMG
  $ZIP
  $DIST/appcast.xml
  $NOTES
  $CASK  (version and sha256 updated)

To publish, in this order:

  # 1. The cask in this repository follows the release.
  git add $CASK && git commit -m "Homebrew cask: $VERSION"

  # 2. Tag and push.
  git tag -a $TAG -m "Fremkit $VERSION"
  git push origin main $TAG

  # 3. The GitHub release. appcast.xml is one of its assets: the app's feed is
  #    $REPO_URL/releases/latest/download/appcast.xml, so publishing the release is what
  #    offers the update to every installed app, and nothing else has to be committed. The
  #    release also opens a thread in the Announcements discussions, where people can comment.
  gh release create $TAG "$DMG" "$LATEST_DMG" "$ZIP" "$DIST/appcast.xml" \\
      --title "Fremkit $VERSION" --notes-file "$NOTES" --discussion-category Announcements

  # 4. The tap (a clone of fdussert/homebrew-fremkit next to this checkout).
  cp $CASK ../homebrew-fremkit/Casks/fremkit.rb
  git -C ../homebrew-fremkit add Casks/fremkit.rb
  git -C ../homebrew-fremkit commit -m "fremkit $VERSION"
  git -C ../homebrew-fremkit push
EOF
