#!/usr/bin/env bash
# Build, test or check the Android app (android/). Run from anywhere.
#
#   scripts/build-android.sh doctor    what this Mac has and lacks to build the app: an arm64 JDK 17+,
#                                      the SDK's command-line tools, platform and build-tools, adb.
#                                      Prints the commands that install what is missing; it never
#                                      installs anything itself
#   scripts/build-android.sh test      the kit's tests and the app's JVM tests
#   scripts/build-android.sh build     a debug APK, lint, and the check that no Google Play services
#                                      library reached the app
#   scripts/build-android.sh install [--seed]
#                                      not yet: a debug build onto the tablet named by
#                                      FREMKIT_ANDROID_DEVICE, the pairing link read from stdin
#   scripts/build-android.sh device-test
#                                      not yet: the instrumented tests on that tablet
#   scripts/build-android.sh release   a signed release APK, dist/Fremkit-Android-<version>.apk, and its
#                                      .sha256. Needs a clean tree, the keystore made by
#                                      scripts/create-android-keystore.sh (folder 0700, file 0600, or
#                                      it refuses) and its password in the keychain. Gradle builds the
#                                      APK unsigned and never sees the key; apksigner signs it with the
#                                      password on its stdin, and the signer must match
#                                      android/signing-cert.sha256 or nothing is written
#   scripts/build-android.sh verify <apk>
#                                      an APK's signature checked, and its signer compared with
#                                      android/signing-cert.sha256: for a downloaded release asset
#
# Environment:
#   FREMKIT_ANDROID_SDK   the Android SDK (default ~/Library/Android/sdk)
#   FREMKIT_JAVA_HOME     the JDK Gradle runs on (default: the newest arm64 JDK 17+ that
#                         /usr/libexec/java_home knows). An x86_64 JDK is refused: under Rosetta,
#                         Gradle is several times slower.
#   FREMKIT_ANDROID_KEYSTORE           the release keystore (default ~/Library/Application
#                                      Support/Fremkit-release/fremkit-android.p12)
#   FREMKIT_ANDROID_KEYCHAIN           for tests: a keychain file instead of the login keychain
#   FREMKIT_ANDROID_KEYCHAIN_SERVICE   for tests: the service instead of fremkit-android-release
#
# Build output goes to android/**/build/ (git-ignored). Nothing secret is ever passed on a command
# line here: any account on the Mac reads every process's arguments with `ps`.
set -euo pipefail

cd "$(dirname "$0")/.."

die() { echo "build-android: $*" >&2; exit 1; }

SDK="${FREMKIT_ANDROID_SDK:-$HOME/Library/Android/sdk}"
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
ADB="$SDK/platform-tools/adb"

# The SDK levels the build asks for, read from the version catalog so they are written once.
catalog() { sed -n "s/^$1 *= *\"\\(.*\\)\"/\\1/p" android/gradle/libs.versions.toml | head -1; }
COMPILE_SDK="$(catalog compileSdk)"
BUILD_TOOLS="$(catalog buildTools)"
[[ -n "$COMPILE_SDK" && -n "$BUILD_TOOLS" ]] || die "android/gradle/libs.versions.toml names no compileSdk or buildTools"

# The architecture a JDK was built for, from its `release` file.
jdk_arch() { sed -n 's/^OS_ARCH="\(.*\)"/\1/p' "$1/release" 2>/dev/null; }
# Its feature version (17 for 17.0.20.1), from the same file.
jdk_major() { sed -n 's/^JAVA_VERSION="\([0-9]*\).*"/\1/p' "$1/release" 2>/dev/null; }

# Prints the JDK to use, or nothing. `java_home -a arm64` alone is not enough: it answers with
# another architecture when none matches, so the choice is checked against the JDK's own file.
find_jdk() {
    local home
    if [[ -n "${FREMKIT_JAVA_HOME:-}" ]]; then
        echo "$FREMKIT_JAVA_HOME"
        return
    fi
    home="$(/usr/libexec/java_home -v 17+ -a arm64 2>/dev/null || true)"
    [[ -n "$home" && "$(jdk_arch "$home")" == aarch64 ]] && echo "$home"
    return 0
}

# Exits with a message unless the JDK is usable; exports JAVA_HOME and ANDROID_HOME for Gradle.
use_toolchain() {
    local jdk
    jdk="$(find_jdk)"
    [[ -n "$jdk" ]] || die "no arm64 JDK 17 or later: run scripts/build-android.sh doctor"
    [[ -x "$jdk/bin/java" ]] || die "$jdk is not a JDK (no bin/java)"
    [[ "$(jdk_arch "$jdk")" == aarch64 ]] || die "$jdk is an $(jdk_arch "$jdk") JDK; Gradle needs an arm64 one on this Mac (run doctor)"
    (( $(jdk_major "$jdk") >= 17 )) || die "$jdk is JDK $(jdk_major "$jdk"); the Android Gradle plugin needs 17 or later"
    [[ -d "$SDK/platforms/android-$COMPILE_SDK" ]] || die "the Android SDK lacks platform $COMPILE_SDK (run doctor)"
    export JAVA_HOME="$jdk" ANDROID_HOME="$SDK"
}

gradle() { (cd android && ./gradlew --console=plain "$@"); }

BUILD_TOOLS_DIR="$SDK/build-tools/$BUILD_TOOLS"
APKSIGNER="$BUILD_TOOLS_DIR/apksigner"
ZIPALIGN="$BUILD_TOOLS_DIR/zipalign"
DEXDUMP="$BUILD_TOOLS_DIR/dexdump"
CERT_FILE=android/signing-cert.sha256
KEYSTORE="${FREMKIT_ANDROID_KEYSTORE:-$HOME/Library/Application Support/Fremkit-release/fremkit-android.p12}"
KEYCHAIN="${FREMKIT_ANDROID_KEYCHAIN:-}"
KEYCHAIN_SERVICE="${FREMKIT_ANDROID_KEYCHAIN_SERVICE:-fremkit-android-release}"

# The published signing certificate's SHA-256, lowercase hex.
expected_cert() {
    [[ -s "$CERT_FILE" ]] || die "$CERT_FILE is missing: the owner creates the key with scripts/create-android-keystore.sh"
    local cert
    cert="$(grep -v '^#' "$CERT_FILE" | tr -d '[:space:]' | tr 'A-F' 'a-f')"
    [[ "$cert" =~ ^[0-9a-f]{64}$ ]] || die "$CERT_FILE holds no SHA-256"
    echo "$cert"
}

# Checks an APK's signature and that its one signer is the published certificate.
verify_apk() {
    local apk="$1" expected out signers found
    expected="$(expected_cert)"
    [[ -f "$apk" ]] || die "no such APK: $apk"
    out="$("$APKSIGNER" verify -v --print-certs "$apk" 2>&1)" || { echo "$out" >&2; die "$apk: the signature does not verify"; }
    grep -Eq 'Verified using v[23] scheme .*: true' <<<"$out" || die "$apk: signed with neither scheme v2 nor v3"
    signers="$(sed -n 's/^Number of signers: //p' <<<"$out")"
    [[ "$signers" == 1 ]] || die "$apk: ${signers:-no} signers, expected one"
    found="$(sed -n 's/^Signer #1 certificate SHA-256 digest: //p' <<<"$out")"
    [[ "$found" == "$expected" ]] || die "$apk: signed by $found, not by the published certificate $expected"
    echo "verified: $apk is signed by the published certificate $expected"
}

# Refuses a keystore anyone but its owner could read, as tightenDataDir would.
check_keystore() {
    [[ -f "$KEYSTORE" ]] || die "no keystore at $KEYSTORE (scripts/create-android-keystore.sh)"
    local dir mode
    dir="$(dirname "$KEYSTORE")"
    mode="$(/usr/bin/stat -f '%Lp' "$dir")"
    [[ "$mode" == 700 ]] || die "$dir is $mode; the keystore's folder must be 0700 (chmod 700 it)"
    mode="$(/usr/bin/stat -f '%Lp' "$KEYSTORE")"
    [[ "$mode" == 600 ]] || die "$KEYSTORE is $mode; the keystore must be 0600 (chmod 600 it)"
    [[ "$(/usr/bin/stat -f '%u' "$KEYSTORE")" == "$(id -u)" ]] || die "$KEYSTORE is not yours"
}

release() {
    [[ -z "$(git status --porcelain)" ]] || die "commit or stash first: a release is built from a commit"
    check_keystore
    local version expected unsigned signed out password signer
    version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "package.json has no X.Y.Z version"
    expected="$(expected_cert)"
    # The password before the build, so a missing one fails fast. Captured, never echoed, and
    # handed to apksigner on stdin by the shell's printf (a builtin: no process, no argv).
    password="$(/usr/bin/security find-generic-password -s "$KEYCHAIN_SERVICE" -a release -w ${KEYCHAIN:+"$KEYCHAIN"} 2>/dev/null)" ||
        die "no $KEYCHAIN_SERVICE password in the keychain (scripts/create-android-keystore.sh)"

    gradle clean :app:assembleRelease :app:checkNoPlayServices
    unsigned=android/app/build/outputs/apk/release/app-release-unsigned.apk
    [[ -f "$unsigned" ]] || die "Gradle built no $unsigned"
    # Global, not local: the EXIT trap runs after this function has returned.
    work="$(mktemp -d "${TMPDIR:-/tmp}/fremkit-android-release.XXXXXX")"
    trap 'rm -rf "${work:?}"' EXIT
    # R8 drops every Log.d and Log.v (app/proguard-rules.pro); a call left means the rule broke.
    "$DEXDUMP" -d "$unsigned" >"$work/dex.txt" 2>/dev/null || die "dexdump could not read $unsigned"
    grep -q '^Processing ' "$work/dex.txt" || die "dexdump found no code in $unsigned"
    local logs
    logs="$(grep -Ec 'Landroid/util/Log;\.[dv]:' "$work/dex.txt" || true)"
    [[ "$logs" == 0 ]] || die "$logs Log.d or Log.v calls survived R8 in the release APK"

    "$ZIPALIGN" -p -f 4 "$unsigned" "$work/aligned.apk"
    signed="$work/signed.apk"
    # v2 and v3: v1 (JAR signing) only matters below API 24, and minSdk is 28.
    if ! signer="$(printf '%s\n' "$password" | "$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass stdin \
        --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
        --out "$signed" "$work/aligned.apk" 2>&1)"; then
        unset password
        grep -v 'password for signer' <<<"$signer" >&2 || true
        die "apksigner could not sign the APK"
    fi
    unset password
    verify_apk "$signed" >/dev/null

    mkdir -p dist
    out="dist/Fremkit-Android-$version.apk"
    mv "$signed" "$out"
    (cd dist && /usr/bin/shasum -a 256 "$(basename "$out")" >"$(basename "$out").sha256")
    echo "signed: $out (certificate $expected)"
    echo "        $out.sha256"
}

doctor() {
    local missing=() jdk ok=1
    jdk="$(find_jdk)"
    if [[ -n "$jdk" && "$(jdk_arch "$jdk")" == aarch64 ]] && (( $(jdk_major "$jdk") >= 17 )); then
        echo "ok    JDK $(jdk_major "$jdk") arm64: $jdk"
    else
        ok=0
        [[ -n "$jdk" ]] && echo "bad   JDK: $jdk is $(jdk_arch "$jdk") JDK $(jdk_major "$jdk"), need arm64 17+" \
            || echo "miss  JDK: no arm64 JDK 17 or later"
        missing+=("JDK")
    fi
    if [[ -x "$SDKMANAGER" ]]; then echo "ok    sdkmanager: $SDKMANAGER"
    else ok=0; echo "miss  sdkmanager: $SDKMANAGER"; missing+=("cmdline-tools"); fi
    if [[ -d "$SDK/platforms/android-$COMPILE_SDK" ]]; then echo "ok    platform android-$COMPILE_SDK"
    else ok=0; echo "miss  platform android-$COMPILE_SDK"; missing+=("sdk"); fi
    if [[ -x "$SDK/build-tools/$BUILD_TOOLS/apksigner" ]]; then echo "ok    build-tools $BUILD_TOOLS"
    else ok=0; echo "miss  build-tools $BUILD_TOOLS"; missing+=("sdk"); fi
    if [[ -x "$ADB" ]]; then echo "ok    adb: $ADB"
    else ok=0; echo "miss  adb: $ADB"; missing+=("sdk"); fi
    if [[ $ok -eq 1 ]]; then
        echo "Everything needed to build the Android app is here."
        return 0
    fi
    echo
    echo "To install what is missing (nothing here installs on its own):"
    if [[ " ${missing[*]} " == *" JDK "* ]]; then
        cat <<EOF

  # An arm64 JDK 17, without sudo: the Temurin tar.gz from https://adoptium.net (check its
  # SHA-256 against the page), unpacked where /usr/libexec/java_home finds it.
  mkdir -p ~/Library/Java/JavaVirtualMachines
  tar -xzf OpenJDK17U-jdk_aarch64_mac_hotspot_<version>.tar.gz -C ~/Library/Java/JavaVirtualMachines
EOF
    fi
    if [[ " ${missing[*]} " == *" cmdline-tools "* ]]; then
        cat <<EOF

  # The SDK's command-line tools: commandlinetools-mac_arm64-<build>_latest.zip from
  # https://developer.android.com/studio#command-tools (check its SHA-256 against the page).
  mkdir -p "$SDK/cmdline-tools"
  unzip -q commandlinetools-mac_arm64-<build>_latest.zip -d "\$TMPDIR/clt"
  mv "\$TMPDIR/clt/cmdline-tools" "$SDK/cmdline-tools/latest"
EOF
    fi
    if [[ " ${missing[*]} " == *" sdk "* || " ${missing[*]} " == *" cmdline-tools "* ]]; then
        cat <<EOF

  # The platform, build-tools and adb (read the licenses before accepting them).
  "$SDKMANAGER" --licenses
  "$SDKMANAGER" --install "platforms;android-$COMPILE_SDK" "build-tools;$BUILD_TOOLS" "platform-tools"
EOF
    fi
    return 1
}

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    doctor)
        doctor
        ;;
    test)
        use_toolchain
        gradle :fremkit-kit:test :app:testDebugUnitTest
        ;;
    build)
        use_toolchain
        gradle :app:assembleDebug :app:lintDebug :app:checkNoPlayServices
        echo "built: $(ls android/app/build/outputs/apk/debug/*.apk)"
        ;;
    release)
        use_toolchain
        release
        ;;
    verify)
        [[ $# -eq 1 ]] || die "usage: scripts/build-android.sh verify <apk>"
        use_toolchain
        verify_apk "$1"
        ;;
    install | device-test)
        die "$cmd: not yet (a later stage of the Android plan adds it)"
        ;;
    *)
        die "usage: scripts/build-android.sh doctor | test | build | install [--seed] | device-test | release | verify <apk>"
        ;;
esac
