#!/usr/bin/env bash
# Build Fremkit.app: the helper, Sparkle, and the whole dashboard — server, Node, widgets, themes,
# built UI — inside one signed bundle that runs with no checkout and no Node installed.
#
#   bash scripts/build-app.sh            -> native/dist/Fremkit.app
#
# Environment:
#   FREMKIT_SIGN_IDENTITY        identity to sign with. Default: the "Developer ID Application"
#                                identity of team 874TMS6WBS when the keychain has it, else the
#                                self-signed "Fremkit Helper Dev", else ad hoc. Only a Developer ID
#                                build can be notarized (scripts/notarize.sh).
#   FREMKIT_SPARKLE_PUBLIC_KEY   overrides packaging/sparkle/public-key.txt (local update tests).
#   FREMKIT_SPARKLE_FEED_URL     overrides the appcast URL (local update tests).
#   FREMKIT_APP_VERSION          overrides the version from server/src/version.ts (local update
#                                tests only; scripts/release.sh never sets it).
#   FREMKIT_BUILD_CACHE          where downloads are kept. Default ~/Library/Caches/Fremkit-build.
#
# This is not `bun run helper:install`: the developer helper (scripts/build-helper.sh) stays a
# separate "Fremkit Helper.app" that runs the checkout's server, has no Sparkle and is what the
# contributors' setup installs. Both share the bundle id dev.fremkit.helper.
#
# Apple silicon only, like Fremkit itself.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

# Node, Sparkle and the team: pinned in one place.
# shellcheck source=lib/pins.sh
source scripts/lib/pins.sh
DEFAULT_FEED_URL="https://github.com/fdussert/fremkit/releases/latest/download/appcast.xml"

CACHE="${FREMKIT_BUILD_CACHE:-$HOME/Library/Caches/Fremkit-build}"
WORK="native/.build/app"
APP="native/dist/Fremkit.app"

# shellcheck source=lib/version.sh
source scripts/lib/version.sh
VERSION="${FREMKIT_APP_VERSION:-$(fremkit_version)}"

# The app is arm64 whatever shell builds it.
export FREMKIT_TARGET="arm64-apple-macos13.0"
# shellcheck source=lib/swiftc-common.sh
source scripts/lib/swiftc-common.sh

mkdir -p "$CACHE" "$WORK"

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# Downloads $1 into the cache as $2 unless it is already there.
fetch() {
    local url="$1" name="$2"
    if [ ! -f "$CACHE/$name" ]; then
        echo "downloading $url"
        curl -fL --retry 3 -o "$CACHE/$name.part" "$url"
        mv "$CACHE/$name.part" "$CACHE/$name"
    fi
}

echo "==> Fremkit $VERSION"

# --- Node ---------------------------------------------------------------------------------------
echo "==> Node $NODE_VERSION"
fetch "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" "$NODE_TARBALL"
fetch "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "SHASUMS256-v${NODE_VERSION}.txt"
published="$(awk -v f="$NODE_TARBALL" '$2 == f {print $1}' "$CACHE/SHASUMS256-v${NODE_VERSION}.txt")"
actual="$(sha256_of "$CACHE/$NODE_TARBALL")"
if [ -z "$published" ] || [ "$actual" != "$published" ] || [ "$actual" != "$NODE_SHA256" ]; then
    echo "error: $NODE_TARBALL does not match SHASUMS256.txt and the pinned hash" >&2
    echo "       actual $actual, published ${published:-none}, pinned $NODE_SHA256" >&2
    echo "       delete it from $CACHE to download it again" >&2
    exit 1
fi
NODE_DIR="$WORK/node-v${NODE_VERSION}"
if [ ! -x "$NODE_DIR/bin/node" ]; then
    rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
    tar -xzf "$CACHE/$NODE_TARBALL" -C "$NODE_DIR" --strip-components 1
fi
NODE="$NODE_DIR/bin/node"

# --- Sparkle ------------------------------------------------------------------------------------
echo "==> Sparkle $SPARKLE_VERSION"
fetch "https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/${SPARKLE_TARBALL}" "$SPARKLE_TARBALL"
actual="$(sha256_of "$CACHE/$SPARKLE_TARBALL")"
if [ "$actual" != "$SPARKLE_SHA256" ]; then
    echo "error: $SPARKLE_TARBALL is $actual, pinned $SPARKLE_SHA256" >&2
    exit 1
fi
if [ ! -d "$SPARKLE_DIR/Sparkle.framework" ]; then
    rm -rf "$SPARKLE_DIR" && mkdir -p "$SPARKLE_DIR"
    tar -xJf "$CACHE/$SPARKLE_TARBALL" -C "$SPARKLE_DIR"
fi

# --- Swift --------------------------------------------------------------------------------------
echo "==> FremkitCore"
fremkit_build_core "$WORK/swift" -O
echo "==> FremkitHelper (with Sparkle)"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitHelper \
    -D FREMKIT_SPARKLE \
    native/Sources/FremkitHelper/*.swift \
    -I "$WORK/swift" -L "$WORK/swift" -lFremkitCore \
    -F "$SPARKLE_DIR" -framework Sparkle \
    -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
    -framework AppKit \
    -framework WebKit \
    -framework IOKit \
    -framework ServiceManagement \
    -o "$WORK/FremkitHelper"
# The disk map's scanner, which the server runs by the path the helper hands it in
# FREMKIT_SCANNER. It needs nothing but FremkitCore and Foundation.
echo "==> fremkit-scan"
"$SWIFTC" -O -sdk "$SDK" -target "$TARGET" -swift-version "$SWIFT_VERSION" \
    -module-name FremkitScan \
    native/Sources/FremkitScan/main.swift \
    -I "$WORK/swift" -L "$WORK/swift" -lFremkitCore \
    -o "$WORK/fremkit-scan"

# --- Server -------------------------------------------------------------------------------------
echo "==> UI"
bun run --filter ui build >/dev/null
echo "==> server bundle"
rm -rf "$WORK/server" && mkdir -p "$WORK/server"
(cd server && node scripts/bundle.mjs "$REPO/$WORK/server/server.cjs")
echo "==> single executable (Node $NODE_VERSION)"
cat > "$WORK/server/sea-config.json" <<EOF
{
  "main": "server.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
EOF
(cd "$WORK/server" && "$REPO/$NODE" --experimental-sea-config sea-config.json >/dev/null)
cp "$NODE" "$WORK/server/fremkit-server"
chmod u+w "$WORK/server/fremkit-server"
# The official binary is signed by the Node.js project; its signature must go before the blob is
# injected, and the result is signed again below with ours.
codesign --remove-signature "$WORK/server/fremkit-server"
server/node_modules/.bin/postject "$WORK/server/fremkit-server" NODE_SEA_BLOB "$WORK/server/sea-prep.blob" \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA >/dev/null

# --- Bundle -------------------------------------------------------------------------------------
echo "==> app bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$WORK/FremkitHelper" "$APP/Contents/MacOS/FremkitHelper"
cp "$WORK/fremkit-scan" "$APP/Contents/MacOS/fremkit-scan"
printf 'APPL????' > "$APP/Contents/PkgInfo"

PLIST="$APP/Contents/Info.plist"
cp native/Resources/Info.plist "$PLIST"
fremkit_stamp_version "$PLIST" "$VERSION"
/usr/libexec/PlistBuddy \
    -c "Set :CFBundleName Fremkit" \
    -c "Set :CFBundleDisplayName Fremkit" \
    -c "Add :SUFeedURL string ${FREMKIT_SPARKLE_FEED_URL:-$DEFAULT_FEED_URL}" \
    -c "Add :SUEnableAutomaticChecks bool true" \
    "$PLIST"
# The public half of the owner's EdDSA key; the private half stays in their keychain and signs
# each update (scripts/release.sh). Without it Sparkle refuses every update, so a build with none
# is fine to run but must never be released — release.sh checks.
PUBLIC_KEY="${FREMKIT_SPARKLE_PUBLIC_KEY:-$({ grep -v '^#' packaging/sparkle/public-key.txt || true; } | tr -d '[:space:]')}"
if [ -n "$PUBLIC_KEY" ]; then
    /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $PUBLIC_KEY" "$PLIST"
else
    echo "warning: no Sparkle public key (packaging/sparkle/public-key.txt is empty); this build cannot update itself" >&2
fi

RES="$APP/Contents/Resources"
cp brand/icon/Fremkit.icns "$RES/Fremkit.icns"
cp brand/menubar/fremkitTemplate.png brand/menubar/fremkitTemplate@2x.png "$RES/"
# The permission prompts' text, in French and English (see Info.plist).
cp -R native/Resources/en.lproj native/Resources/fr.lproj "$RES/"

# The layout server/src/paths.ts reads under FREMKIT_ROOT. Change both together.
mkdir -p "$RES/server/bridge" "$RES/ui" "$RES/brand" "$RES/scripts"
cp "$WORK/server/fremkit-server" "$RES/server/fremkit-server"
cp server/src/bridge/fremkit.js "$RES/server/bridge/fremkit.js"
# Licences: the bundled dependencies (collected by esbuild) and Node's own.
cp "$WORK/server/server.cjs.LEGAL.txt" "$RES/server/THIRD-PARTY-LICENSES.txt"
cp "$NODE_DIR/LICENSE" "$RES/server/NODE-LICENSE.txt"
cp LICENSE "$RES/LICENSE.txt"
rsync -a --exclude '.DS_Store' --exclude 'node_modules' widgets themes "$RES/"
rsync -a --exclude '.DS_Store' ui/dist "$RES/ui/"
rsync -a --exclude '.DS_Store' brand/wallpaper "$RES/brand/"
# The Claude Code hook and status line, for settings.json to name without a checkout.
cp scripts/claude-hook.sh scripts/claude-statusline.sh "$RES/scripts/"

# Sparkle, minus its XPC services: those exist for sandboxed apps, and Fremkit is not sandboxed
# (Sparkle's documentation says they may then be removed). Less code shipped, less to sign.
rsync -a "$SPARKLE_DIR/Sparkle.framework" "$APP/Contents/Frameworks/"
rm -rf "$APP/Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices" \
       "$APP/Contents/Frameworks/Sparkle.framework/XPCServices"

# --- Signing ------------------------------------------------------------------------------------
# Inside out, every piece with its own signature, never --deep: the server executable, Sparkle's
# helpers, its framework, then the app. --options runtime everywhere (notarization requires the
# hardened runtime); a secure timestamp only with a Developer ID, which is what Apple's
# timestamp server is for.
if [ -n "${FREMKIT_SIGN_IDENTITY:-}" ]; then
    IDENTITY="$FREMKIT_SIGN_IDENTITY"
else
    IDENTITY="$(fremkit_developer_id)"
    if [ -z "$IDENTITY" ]; then
        # Read once: `security … | grep -q` under pipefail can fail on SIGPIPE when grep exits early.
        if grep -q '"Fremkit Helper Dev"' <<<"$(security find-identity -v -p codesigning 2>/dev/null || true)"; then
            IDENTITY="Fremkit Helper Dev"
        else
            IDENTITY="-"
        fi
        echo "warning: no Developer ID Application identity for team $TEAM_ID; signing with \"$IDENTITY\" (not notarizable)" >&2
    fi
fi
# A secure timestamp only with a Developer ID, which is what Apple's timestamp server is for (and
# what notarization requires). The identity may be a name or a hash; ask the keychain which.
TIMESTAMP="--timestamp=none"
if [ "$IDENTITY" != "-" ]; then
    case "$(grep -F "$IDENTITY" <<<"$(security find-identity -v -p codesigning 2>/dev/null || true)")" in
        *'"Developer ID Application: '*) TIMESTAMP="--timestamp" ;;
    esac
fi
echo "==> signing with $IDENTITY ($TIMESTAMP)"
sign() { codesign --force --options runtime "$TIMESTAMP" --sign "$IDENTITY" "$@"; }

sign --entitlements native/Resources/node.entitlements "$RES/server/fremkit-server"
# A nested executable gets its own identifier rather than the app's; it needs no entitlement (no
# JIT, and what it may read is TCC's decision, granted to the app).
sign --identifier dev.fremkit.scan "$APP/Contents/MacOS/fremkit-scan"
SPARKLE_FW="$APP/Contents/Frameworks/Sparkle.framework"
sign "$SPARKLE_FW/Versions/B/Autoupdate"
sign "$SPARKLE_FW/Versions/B/Updater.app"
sign "$SPARKLE_FW"
# The hardened runtime's library validation only loads a framework signed by the app's own team.
# A self-signed or ad-hoc identity has no team, so the app would die in dyld loading Sparkle.
# Such a build — local, never notarizable — gets library validation turned off; a Developer ID
# build never does.
APP_ENTITLEMENTS="native/Resources/Fremkit.entitlements"
if [ "$TIMESTAMP" != "--timestamp" ]; then
    APP_ENTITLEMENTS="$WORK/Fremkit-local.entitlements"
    cp native/Resources/Fremkit.entitlements "$APP_ENTITLEMENTS"
    /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$APP_ENTITLEMENTS"
fi
sign --entitlements "$APP_ENTITLEMENTS" "$APP"

codesign --verify --strict --verbose=2 "$APP"

# Same reason as build-helper.sh: a copy LaunchServices knows about can be picked by
# `open -b dev.fremkit.helper`, so the build folder unregisters itself.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
if [ -x "$LSREGISTER" ]; then "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true; fi

echo "app: $APP ($VERSION)"
