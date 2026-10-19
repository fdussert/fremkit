#!/usr/bin/env bash
# The version every build is stamped with: FREMKIT_VERSION in server/src/version.ts, the one the
# registry compares a widget's `sdk` against. Source from the repo root.
fremkit_version() {
    local version
    version="$(sed -n "s/^export const FREMKIT_VERSION = '\([0-9][0-9.]*[0-9]\)'.*/\1/p" server/src/version.ts)"
    if [ -z "$version" ]; then
        echo "error: no FREMKIT_VERSION found in server/src/version.ts" >&2
        return 1
    fi
    printf '%s\n' "$version"
}

# Writes the version into a bundle's Info.plist. $1: path to Info.plist, $2: version.
fremkit_stamp_version() {
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $2" -c "Set :CFBundleVersion $2" "$1"
}
