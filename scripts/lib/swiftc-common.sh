#!/usr/bin/env bash
# Shared swiftc plumbing for the native helper.
#
# SwiftPM is unusable on this machine (mismatched Command Line Tools components:
# `swift build` and `swift test` abort in dyld, and the SDK ships no XCTest), so the
# helper is built by calling swiftc directly. native/Package.swift is kept for the day
# the toolchain is repaired.
#
# Source this file from the repo root; it defines SDK, OUT and the build helpers.

# Pick an SDK the compiler can actually parse: the newest SDK shipped with these
# Command Line Tools is newer than the compiler and fails to load the standard library.
fremkit_pick_sdk() {
    if [ -n "${FREMKIT_SDK:-}" ]; then
        printf '%s\n' "$FREMKIT_SDK"
        return 0
    fi
    local candidate
    for candidate in \
        /Library/Developer/CommandLineTools/SDKs/MacOSX26.2.sdk \
        /Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
    do
        if [ -d "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    xcrun --show-sdk-path
}

SDK="$(fremkit_pick_sdk)"
if [ ! -d "$SDK" ]; then
    echo "error: no usable macOS SDK found (set FREMKIT_SDK to override)" >&2
    exit 1
fi

OUT="native/.build/swiftc"
SWIFTC="${FREMKIT_SWIFTC:-swiftc}"

# Deployment target. Without an explicit -target, swiftc assumes the host OS version and every
# availability check passes silently, so newer-than-supported API slips in unnoticed. Pinning it
# makes the compiler enforce @available at build time.
TARGET="${FREMKIT_TARGET:-arm64-apple-macos13.0}"

# Swift language mode. Pinned explicitly so a newer toolchain defaulting to Swift 6 does not
# quietly change the concurrency rules this code is written against.
SWIFT_VERSION="${FREMKIT_SWIFT_VERSION:-5}"

# Build FremkitCore as a static library plus its module.
# $1: output directory. $2 and beyond: extra swiftc flags (e.g. -enable-testing).
fremkit_build_core() {
    local out="$1"; shift
    mkdir -p "$out"
    "$SWIFTC" -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" "$@" \
        -emit-library -static -emit-module \
        -module-name FremkitCore -parse-as-library \
        native/Sources/FremkitCore/*.swift \
        -emit-module-path "$out/FremkitCore.swiftmodule" \
        -o "$out/libFremkitCore.a"
}
