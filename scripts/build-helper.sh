#!/usr/bin/env bash
# Build the Fremkit helper binary with swiftc (no SwiftPM), then assemble the app bundle.
# Run from the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/swiftc-common.sh
source scripts/lib/swiftc-common.sh
# shellcheck source=lib/version.sh
source scripts/lib/version.sh
VERSION="$(fremkit_version)"

echo "SDK: $SDK"

mkdir -p "$OUT"
echo "==> FremkitCore"
fremkit_build_core "$OUT" -O

echo "==> FremkitHelper"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitHelper \
    native/Sources/FremkitHelper/*.swift \
    -I "$OUT" -L "$OUT" -lFremkitCore \
    -framework AppKit \
    -framework WebKit \
    -framework IOKit \
    -framework ServiceManagement \
    -o "$OUT/FremkitHelper"

echo "built: $OUT/FremkitHelper"

# The disk map's scanner: its own small executable, which the server runs like `du` (the helper
# tells it where through FREMKIT_SCANNER). It needs nothing but FremkitCore and Foundation.
echo "==> fremkit-scan"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitScan \
    native/Sources/FremkitScan/main.swift \
    -I "$OUT" -L "$OUT" -lFremkitCore \
    -o "$OUT/fremkit-scan"

echo "==> app bundle"
APP="native/dist/Fremkit Helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/FremkitHelper" "$APP/Contents/MacOS/FremkitHelper"
cp "$OUT/fremkit-scan" "$APP/Contents/MacOS/fremkit-scan"
cp native/Resources/Info.plist "$APP/Contents/Info.plist"
fremkit_stamp_version "$APP/Contents/Info.plist" "$VERSION"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Brand assets: the app icon named by CFBundleIconFile, and the menu bar glyph. The "Template"
# suffix in the file name is what makes AppKit tint the glyph for the current menu bar theme.
cp brand/icon/Fremkit.icns "$APP/Contents/Resources/Fremkit.icns"
cp brand/menubar/fremkitTemplate.png brand/menubar/fremkitTemplate@2x.png "$APP/Contents/Resources/"
# The permission prompts' text, in French and English (see Info.plist).
cp -R native/Resources/en.lproj native/Resources/fr.lproj "$APP/Contents/Resources/"

# Ad-hoc signatures change with every build, and TCC ties its Input Monitoring and
# Accessibility grants to the signature, so each rebuild forces the user to grant again.
# A stable identity avoids that: any code-signing certificate in the login keychain named
# FREMKIT_SIGN_IDENTITY (default "Fremkit Helper Dev", self-signed is fine) is used when present.
IDENTITY="${FREMKIT_SIGN_IDENTITY:-Fremkit Helper Dev}"
#
# `--options runtime` turns on the hardened runtime, which is what makes the bundle's TCC grants
# (Input Monitoring, Accessibility) belong to *this* signed code rather than to whatever happens
# to sit at the path. `--deep` is deprecated and signs nested code with the outer identity
# instead of its own. The one nested executable, fremkit-scan, is signed on its own first, with
# its own identifier, and the bundle after it: inside out.
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo "signing with: $IDENTITY"
    SIGN_AS="$IDENTITY"
else
    echo "signing ad hoc (no \"$IDENTITY\" identity in the keychain; run scripts/create-signing-identity.sh)"
    SIGN_AS="-"
fi
codesign --force --options runtime --identifier dev.fremkit.scan --sign "$SIGN_AS" "$APP/Contents/MacOS/fremkit-scan"
codesign --force --options runtime --sign "$SIGN_AS" "$APP"
codesign --verify --strict "$APP"

# The bundle declares the `fremkit://` URL scheme, and LaunchServices registers every copy it
# notices — including this build folder. `open -b dev.fremkit.helper fremkit://admin` would then
# be free to launch *this* copy beside the installed one, leaving the Mac with two helpers
# fighting over the touch panel and the same server. The copy install-helper.sh puts in
# ~/Applications is the one LaunchServices should know, so the build folder unregisters itself.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true; fi

echo "bundle: $APP"
