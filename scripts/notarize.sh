#!/usr/bin/env bash
# Notarize and staple Fremkit.app, then build, sign, notarize and staple its DMG.
#
#   bash scripts/notarize.sh                 -> native/dist/Fremkit-<version>.dmg
#
# Needs an app built by scripts/build-app.sh with the Developer ID identity, and the notarytool
# keychain profile "fremkit-notary" (created once by the owner with `xcrun notarytool
# store-credentials`; this script never sees the Apple ID or its password).
#
# Environment:
#   FREMKIT_NOTARY_PROFILE   keychain profile name. Default: fremkit-notary.
set -euo pipefail

cd "$(dirname "$0")/.."

APP="native/dist/Fremkit.app"
PROFILE="${FREMKIT_NOTARY_PROFILE:-fremkit-notary}"
# shellcheck source=lib/pins.sh
source scripts/lib/pins.sh
WORK="native/.build/notarize"

if [ ! -d "$APP" ]; then
    echo "error: $APP not found; run scripts/build-app.sh first" >&2
    exit 1
fi
# Read once into a variable: `codesign … | grep -q` under pipefail fails whenever grep stops
# reading early and codesign gets SIGPIPE.
SIGNATURE="$(codesign -dvv "$APP" 2>&1 || true)"
if ! grep -q '^Authority=Developer ID Application:' <<<"$SIGNATURE"; then
    echo "error: $APP is not signed with a Developer ID Application identity; Apple would refuse it" >&2
    exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
DMG="native/dist/Fremkit-${VERSION}.dmg"
# The DMG is signed by the same team's identity, named by hash (see pins.sh), or by
# FREMKIT_SIGN_IDENTITY when the app was.
IDENTITY="${FREMKIT_SIGN_IDENTITY:-$(fremkit_developer_id)}"
if [ -z "$IDENTITY" ]; then
    echo "error: no Developer ID Application identity for team $TEAM_ID in the keychain" >&2
    exit 1
fi

rm -rf "$WORK"
mkdir -p "$WORK"

# Submits $1 and waits. On anything but "Accepted", prints Apple's log for it and fails.
notarize() {
    local file="$1" result="$WORK/$(basename "$1").json"
    echo "==> notarizing $(basename "$file") (this takes a few minutes)"
    xcrun notarytool submit "$file" --keychain-profile "$PROFILE" --wait \
        --output-format json > "$result" || true
    local status id
    status="$(plutil -extract status raw -o - "$result" 2>/dev/null || echo unknown)"
    id="$(plutil -extract id raw -o - "$result" 2>/dev/null || echo '')"
    echo "    submission ${id:-?}: $status"
    if [ "$status" != "Accepted" ]; then
        cat "$result" >&2
        if [ -n "$id" ]; then
            echo "==> notarytool log $id" >&2
            xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
        fi
        exit 1
    fi
}

# --- The app ------------------------------------------------------------------------------------
ditto -c -k --keepParent "$APP" "$WORK/Fremkit.zip"
notarize "$WORK/Fremkit.zip"
xcrun stapler staple "$APP"

# --- The DMG ------------------------------------------------------------------------------------
# Plain hdiutil: the app and a link to /Applications to drag it onto, nothing else.
echo "==> DMG"
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Fremkit.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Fremkit" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
codesign --force --timestamp --sign "$IDENTITY" "$DMG"
notarize "$DMG"
xcrun stapler staple "$DMG"

# --- Verification -------------------------------------------------------------------------------
echo "==> verification"
codesign --verify --strict --verbose=2 "$APP"
spctl -a -t exec -vv "$APP"
spctl -a -t open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

echo "notarized: $APP"
echo "dmg: $DMG"
