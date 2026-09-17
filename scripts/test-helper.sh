#!/usr/bin/env bash
# Compile and run the FremkitCore tests with swiftc (no SwiftPM, no Apple XCTest).
#
# The committed test files are plain XCTest sources. They are linked against a tiny
# shim compiled as a module literally named XCTest (native/Tests/Shim/MiniXCTest.swift),
# which records failures instead of aborting, and driven by an explicit registry
# (native/Tests/Shim/main.swift). Run from the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/swiftc-common.sh
source scripts/lib/swiftc-common.sh

# The shim runner has no runtime discovery: a test method that is not listed in
# native/Tests/Shim/main.swift compiles fine and is silently never run. Catch that here.
echo "==> registry check"
declared=$(grep -ho 'func test' native/Tests/FremkitCoreTests/*.swift | wc -l | tr -d ' ')
registered=$(grep -ho '("test' native/Tests/Shim/main.swift | wc -l | tr -d ' ')
if [ "$declared" != "$registered" ]; then
    echo "error: $declared test methods declared in native/Tests/FremkitCoreTests but $registered registered in native/Tests/Shim/main.swift" >&2
    echo "       every new test method must be added to the suites list in native/Tests/Shim/main.swift" >&2
    exit 1
fi
echo "$registered test methods declared and registered"

TESTING_OUT="$OUT/testing"
TEST_OUT="$OUT/test"
mkdir -p "$TESTING_OUT" "$TEST_OUT"

echo "SDK: $SDK"

# @testable import needs the library built with -enable-testing, so the test build
# gets its own copy of FremkitCore rather than the optimised one used by the helper.
echo "==> FremkitCore (testable)"
fremkit_build_core "$TESTING_OUT" -enable-testing -Onone

echo "==> XCTest shim"
"$SWIFTC" -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -emit-library -static -emit-module \
    -module-name XCTest -parse-as-library \
    native/Tests/Shim/MiniXCTest.swift \
    -emit-module-path "$TEST_OUT/XCTest.swiftmodule" \
    -o "$TEST_OUT/libXCTest.a"

echo "==> FremkitCoreTests"
"$SWIFTC" -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitCoreTests \
    native/Tests/Shim/main.swift \
    native/Tests/FremkitCoreTests/*.swift \
    -I "$TEST_OUT" -L "$TEST_OUT" -lXCTest \
    -I "$TESTING_OUT" -L "$TESTING_OUT" -lFremkitCore \
    -o "$TEST_OUT/FremkitCoreTests"

echo "==> running"
"$TEST_OUT/FremkitCoreTests"
