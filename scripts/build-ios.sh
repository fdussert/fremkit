#!/usr/bin/env bash
# Build, test or install the iPad app (ios/). Run from anywhere.
#
#   scripts/build-ios.sh build     the app for the simulator, signed ad hoc (no Local.xcconfig needed):
#                                  unsigned, it has no keychain and cannot keep a pairing
#   scripts/build-ios.sh test      FremkitKit's tests, on the Mac
#   scripts/build-ios.sh install [--seed]
#                                  a signed Debug build installed and launched on the iPad whose
#                                  UDID is in FREMKIT_IOS_DEVICE; signing comes from
#                                  ios/Local.xcconfig (copy ios/Local.example.xcconfig). With
#                                  --seed, a pairing link read from stdin (`pbpaste | … --seed`)
#                                  is copied into the app's container and opened at launch, as
#                                  the camera would (Debug builds only). It never goes on a
#                                  command line: it carries the code's secret, which pairs past
#                                  the wrong-code limit, and any account on the Mac reads every
#                                  process's arguments with `ps`.
#   scripts/build-ios.sh archive   a signed Release archive (ios/build/Fremkit.xcarchive), its build
#                                  number the commit count of HEAD, so every upload is higher than
#                                  the last one made from main
#   scripts/build-ios.sh upload    the archive, exported for and uploaded to App Store Connect, where
#                                  it lands in TestFlight. Needs a clean tree (the build number names
#                                  a commit), the app's record in App Store Connect, and an Xcode
#                                  signed in to the team's Apple account (Settings → Accounts).
#
# Build output goes to ios/build/ (git-ignored); the full log of the last xcodebuild run is
# ios/build/xcodebuild.log.
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=ios/Fremkit.xcodeproj
SCHEME=Fremkit
DERIVED=ios/build
LOG="$DERIVED/xcodebuild.log"

die() { echo "build-ios: $*" >&2; exit 1; }

# xcodebuild needs Xcode (the iOS SDK), not the Command Line Tools. FREMKIT_XCODE points at
# another Xcode.app; an explicit DEVELOPER_DIR is left alone.
if [[ -z "${DEVELOPER_DIR:-}" && "$(xcode-select -p 2>/dev/null)" == *CommandLineTools* ]]; then
    xcode="${FREMKIT_XCODE:-/Applications/Xcode.app}"
    [[ -d "$xcode/Contents/Developer" ]] ||
        die "the active developer directory is the Command Line Tools and $xcode was not found: install Xcode (with the iOS platform) or set FREMKIT_XCODE=/path/to/Xcode.app"
    export DEVELOPER_DIR="$xcode/Contents/Developer"
fi

# Xcode's own line for an app without App Intents: not a diagnostic about this project.
NOISE='warning: Metadata extraction skipped, no AppIntents.framework dependency found'

# Runs xcodebuild quietly: the full log goes to $LOG, warnings and errors to the terminal.
xcb() {
    mkdir -p "$DERIVED"
    local status=0
    xcodebuild -project "$PROJECT" -scheme "$SCHEME" -derivedDataPath "$DERIVED" "$@" >"$LOG" 2>&1 || status=$?
    grep -E '(warning|error):' "$LOG" | grep -v -F "$NOISE" | uniq || true
    if [[ $status -ne 0 ]]; then
        tail -20 "$LOG" >&2
        die "xcodebuild failed ($status); full log: $LOG"
    fi
}

# The signing values archive and upload need, from ios/Local.xcconfig.
local_setting() {
    [[ -f ios/Local.xcconfig ]] || die "ios/Local.xcconfig is missing: copy ios/Local.example.xcconfig and fill it in"
    sed -n "s/^$1 *= *//p" ios/Local.xcconfig | head -1
}

ARCHIVE="$DERIVED/Fremkit.xcarchive"

archive() {
    [[ -n "$(local_setting DEVELOPMENT_TEAM)" ]] || die "DEVELOPMENT_TEAM is not set in ios/Local.xcconfig"
    local build
    build="$(git rev-list --count HEAD)"
    xcb -configuration Release -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
        -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$build" archive
    echo "archived build $build: $ARCHIVE"
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    build)
        xcb -destination 'generic/platform=iOS Simulator' CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
        echo "built: $DERIVED/Build/Products/Debug-iphonesimulator/Fremkit.app"
        ;;
    test)
        swift test --package-path ios/FremkitKit
        ;;
    install)
        [[ -f ios/Local.xcconfig ]] || die "ios/Local.xcconfig is missing: copy ios/Local.example.xcconfig and fill it in"
        device="${FREMKIT_IOS_DEVICE:-}"
        [[ -n "$device" ]] || die "set FREMKIT_IOS_DEVICE to the iPad's UDID (xcrun devicectl list devices)"
        xcb -configuration Debug -destination "id=$device" -allowProvisioningUpdates build
        app="$DERIVED/Build/Products/Debug-iphoneos/Fremkit.app"
        bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
        seed=""
        case "${1:-}" in
            "") ;;
            --seed)
                seed="$(mktemp "${TMPDIR:-/tmp}/fremkit-seed.XXXXXX")"
                trap 'rm -f "${seed:?}"' EXIT
                chmod 600 "$seed"
                cat >"$seed"
                grep -q '^fremkit://pair?' "$seed" || die "--seed reads a fremkit://pair?… link from stdin"
                ;;
            *) die "usage: scripts/build-ios.sh install [--seed]" ;;
        esac
        xcrun devicectl device install app --device "$device" "$app"
        if [[ -n "$seed" ]]; then
            # Into the app's own container, where the Debug build reads and deletes it at launch
            # (`PairingFlow.seedFile` in ios/Fremkit/AppModel.swift).
            xcrun devicectl device copy to --device "$device" --domain-type appDataContainer \
                --domain-identifier "$bundle_id" --source "$seed" --destination tmp/FremkitSeedLink --quiet
        fi
        xcrun devicectl device process launch --device "$device" --terminate-existing "$bundle_id"
        ;;
    archive)
        archive
        ;;
    upload)
        [[ -z "$(git status --porcelain)" ]] || die "commit or stash first: the build number names a commit"
        archive
        team="$(local_setting DEVELOPMENT_TEAM)"
        options="$DERIVED/ExportOptions.plist"
        cat >"$options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key><string>app-store-connect</string>
    <key>destination</key><string>upload</string>
    <key>teamID</key><string>$team</string>
    <key>signingStyle</key><string>automatic</string>
    <key>manageAppVersionAndBuildNumber</key><false/>
    <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST
        status=0
        xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$options" \
            -exportPath "$DERIVED/export" -allowProvisioningUpdates >"$LOG" 2>&1 || status=$?
        if [[ $status -ne 0 ]]; then
            tail -20 "$LOG" >&2
            die "upload failed ($status); full log: $LOG"
        fi
        echo "uploaded: it shows in App Store Connect → TestFlight once Apple has processed it"
        ;;
    *)
        die "usage: scripts/build-ios.sh build | test | install [--seed] | archive | upload"
        ;;
esac
