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
#   scripts/build-android.sh release   not yet: a signed release APK in dist/
#   scripts/build-android.sh verify <apk>
#                                      not yet: an APK's signer checked against
#                                      android/signing-cert.sha256
#
# Environment:
#   FREMKIT_ANDROID_SDK   the Android SDK (default ~/Library/Android/sdk)
#   FREMKIT_JAVA_HOME     the JDK Gradle runs on (default: the newest arm64 JDK 17+ that
#                         /usr/libexec/java_home knows). An x86_64 JDK is refused: under Rosetta,
#                         Gradle is several times slower.
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
    install | device-test | release | verify)
        die "$cmd: not yet (a later stage of the Android plan adds it)"
        ;;
    *)
        die "usage: scripts/build-android.sh doctor | test | build | install [--seed] | device-test | release | verify <apk>"
        ;;
esac
