#!/usr/bin/env bash
# Build the Fremkit helper binary with swiftc (no SwiftPM), then assemble the app bundle.
# Run from the repo root.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/swiftc-common.sh
source scripts/lib/swiftc-common.sh

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

echo "==> app bundle"
APP="native/dist/Fremkit Helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$OUT/FremkitHelper" "$APP/Contents/MacOS/FremkitHelper"
cp native/Resources/Info.plist "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Brand assets: the app icon named by CFBundleIconFile, and the menu bar glyph. The "Template"
# suffix in the file name is what makes AppKit tint the glyph for the current menu bar theme.
cp brand/icon/Fremkit.icns "$APP/Contents/Resources/Fremkit.icns"
cp brand/menubar/fremkitTemplate.png brand/menubar/fremkitTemplate@2x.png "$APP/Contents/Resources/"

# Ad-hoc signatures change with every build, and TCC ties its Input Monitoring and
# Accessibility grants to the signature, so each rebuild forces the user to grant again.
# A stable identity avoids that: any code-signing certificate in the login keychain named
# FREMKIT_SIGN_IDENTITY (default "Fremkit Helper Dev", self-signed is fine) is used when present.
IDENTITY="${FREMKIT_SIGN_IDENTITY:-Fremkit Helper Dev}"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo "signing with: $IDENTITY"
    codesign --force --deep --sign "$IDENTITY" "$APP"
else
    echo "signing ad hoc (no \"$IDENTITY\" identity in the keychain; run scripts/create-signing-identity.sh)"
    codesign --force --deep --sign - "$APP"
fi

# The bundle declares the `fremkit://` URL scheme, and LaunchServices registers every copy it
# notices — including this build folder. `open -b dev.fremkit.helper fremkit://admin` would then
# be free to launch *this* copy beside the installed one, leaving the Mac with two helpers
# fighting over the touch panel and the same server. The copy install-helper.sh puts in
# ~/Applications is the one LaunchServices should know, so the build folder unregisters itself.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true; fi

echo "bundle: $APP"
