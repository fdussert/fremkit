#!/usr/bin/env bash
# Tests the Android signing scripts end to end, with no real key anywhere:
#
#   bash scripts/test-build-android.sh
#
# Copies what the Android build needs into a throwaway git repository, makes a throwaway keychain
# file and a keystore in a temporary folder with scripts/create-android-keystore.sh, and checks
# that `scripts/build-android.sh release` refuses a dirty tree, a loose keystore folder or file, a
# missing password and a signer that is not the committed one; that a good release verifies; and
# that the password never shows in `ps -axww` while the scripts run. Never touches the login
# keychain, ~/Library/Application Support/Fremkit-release or android/signing-cert.sha256.
# Slow (two release builds, a few minutes): run it by hand after changing the signing scripts.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="$(pwd)"

failures=0
pass() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; failures=$((failures + 1)); }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/fremkit-android-test.XXXXXX")"
KEYCHAIN="$tmp/test.keychain-db"
watcher=""
cleanup() {
    [[ -n "$watcher" ]] && kill "$watcher" 2>/dev/null || true
    /usr/bin/security delete-keychain "$KEYCHAIN" 2>/dev/null || true
    rm -rf "${tmp:?}"
}
trap cleanup EXIT

# --- Which surviving Log.d/Log.v calls the release refuses -------------------------------------
# eval, not `source <(…)`: macOS's bash 3.2 sources nothing from a process substitution.
eval "$(sed -n '/^release_log_classes() {/,/^}/p' scripts/build-android.sh)"
declare -F release_log_classes >/dev/null && pass "log check: found in build-android.sh" ||
    fail "log check: release_log_classes is not in build-android.sh"
printf '%s\n' 'app.fremkit.android.Foo -> a:' 'androidx.camera.Bar -> b:' '    void run():1:1 -> c' >"$tmp/mapping.txt"
dex_with() { printf "  Class descriptor  : 'L%s;'\n    0001: invoke-static {v0, v1}, Landroid/util/Log;.d:(Ljava/lang/String;Ljava/lang/String;)I\n" "$@"; }
dex_with b >"$tmp/lib.txt"
[[ -z "$(release_log_classes "$tmp/lib.txt" "$tmp/mapping.txt")" ]] && pass "log check: a library's Log.d is tolerated" ||
    fail "log check: a library's Log.d was refused"
dex_with a b >"$tmp/ours.txt"
[[ "$(release_log_classes "$tmp/ours.txt" "$tmp/mapping.txt")" == "app.fremkit.android.Foo" ]] &&
    pass "log check: our own Log.d is refused, by its source name" || fail "log check: our own Log.d was not named"
dex_with zz >"$tmp/unmapped.txt"
[[ "$(release_log_classes "$tmp/unmapped.txt" "$tmp/mapping.txt")" == "zz" ]] &&
    pass "log check: a class missing from the mapping is refused" || fail "log check: an unmapped class went through"

# --- A throwaway repository with what the Android build reads ----------------------------------
REPO="$tmp/repo"
mkdir -p "$REPO"
git ls-files -z -co --exclude-standard -- package.json .gitignore android scripts/build-android.sh \
    scripts/create-android-keystore.sh server/src/devices/fingerprint-words.txt test-vectors |
    rsync -a --from0 --files-from=- ./ "$REPO/"
rm -f "$REPO/android/signing-cert.sha256"
commit() { git -C "$REPO" add -A && git -C "$REPO" -c user.name=test -c user.email=test@example.com commit -qm "$1"; }
git -C "$REPO" init -q
commit "test tree"

# --- A throwaway keychain (its password goes to `security -i` on stdin, like every other) -------
printf 'create-keychain -p %s %s\n' "$(/usr/bin/openssl rand -hex 16)" "$KEYCHAIN" | /usr/bin/security -i >/dev/null
/usr/bin/security set-keychain-settings "$KEYCHAIN"

export FREMKIT_ANDROID_KEYSTORE="$tmp/release/fremkit-android.p12"
export FREMKIT_ANDROID_KEYCHAIN="$KEYCHAIN"
export FREMKIT_ANDROID_KEYCHAIN_SERVICE=fremkit-android-release-test

expect_refusal() { # name, expected message part, command...
    local name="$1" part="$2" out
    shift 2
    if out="$("$@" 2>&1)"; then
        fail "$name: accepted"
    elif grep -qF -- "$part" <<<"$out"; then
        pass "$name: refused"
    else
        fail "$name: refused for another reason:"; tail -5 <<<"$out" >&2
    fi
}

# --- create-android-keystore.sh ------------------------------------------------------------------
# The password does not exist yet, so this watcher looks for the shapes that would carry it: a
# keychain write or a keytool password option on a command line.
printf '%s\n' add-generic-password -storepass -keypass >"$tmp/create-pattern"
(while :; do /bin/ps -axww -o command= | grep -v -F 'grep' | grep -F -f "$tmp/create-pattern" -q && echo leak >>"$tmp/create-leaks"; sleep 0.1; done) &
watcher=$!
if (cd "$REPO" && bash scripts/create-android-keystore.sh >"$tmp/create.log" 2>&1); then
    pass "create: keystore made"
else
    fail "create: failed"; cat "$tmp/create.log" >&2; exit 1
fi
kill "$watcher" 2>/dev/null || true
wait "$watcher" 2>/dev/null || true
[[ ! -s "$tmp/create-leaks" ]] && pass "create: no password option in ps -axww" || fail "create: a password option showed in ps -axww"
[[ "$(/usr/bin/stat -f '%Lp' "$tmp/release")" == 700 ]] && pass "create: folder 0700" || fail "create: folder not 0700"
[[ "$(/usr/bin/stat -f '%Lp' "$FREMKIT_ANDROID_KEYSTORE")" == 600 ]] && pass "create: keystore 0600" || fail "create: keystore not 0600"
grep -Eq '^[0-9a-f]{64}$' "$REPO/android/signing-cert.sha256" && pass "create: fingerprint written" || fail "create: no fingerprint"
commit "fingerprint"
expect_refusal "create twice" "already exists" bash -c "cd '$REPO' && bash scripts/create-android-keystore.sh"

# From here, any process whose arguments carry the password is a leak. The pattern sits in a 0600
# file so the watcher's own grep does not carry it either.
umask 077
/usr/bin/security find-generic-password -s "$FREMKIT_ANDROID_KEYCHAIN_SERVICE" -a release -w "$KEYCHAIN" >"$tmp/pattern"
[[ -s "$tmp/pattern" ]] || { fail "no password in the test keychain"; exit 1; }
(while :; do /bin/ps -axww -o command= | grep -F -f "$tmp/pattern" -q && echo leak >>"$tmp/leaks"; sleep 0.2; done) &
watcher=$!

# --- release: refusals before anything is built --------------------------------------------------
touch "$REPO/stray"
expect_refusal "dirty tree" "commit or stash first" bash "$REPO/scripts/build-android.sh" release
rm "$REPO/stray"
chmod 644 "$FREMKIT_ANDROID_KEYSTORE"
expect_refusal "keystore 0644" "must be 0600" bash "$REPO/scripts/build-android.sh" release
chmod 600 "$FREMKIT_ANDROID_KEYSTORE"
chmod 755 "$tmp/release"
expect_refusal "folder 0755" "must be 0700" bash "$REPO/scripts/build-android.sh" release
chmod 700 "$tmp/release"
expect_refusal "no password" "password in the keychain" \
    env FREMKIT_ANDROID_KEYCHAIN_SERVICE=fremkit-android-release-absent bash "$REPO/scripts/build-android.sh" release

# --- release: a good one ---------------------------------------------------------------------------
version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)"
apk="$REPO/dist/Fremkit-Android-$version.apk"
if bash "$REPO/scripts/build-android.sh" release >"$tmp/release.log" 2>&1 && [[ -f "$apk" ]]; then
    pass "release: signed $(basename "$apk")"
else
    fail "release: failed"; tail -20 "$tmp/release.log" >&2; exit 1
fi
(cd "$REPO/dist" && /usr/bin/shasum -a 256 -c "$(basename "$apk").sha256" >/dev/null) && pass "release: .sha256 matches" || fail "release: .sha256 does not match"
bash "$REPO/scripts/build-android.sh" verify "$apk" >/dev/null 2>&1 && pass "verify: published signer accepted" || fail "verify: rejected the release"
cp "$apk" "$tmp/good.apk"

# --- a signer that is not the published one --------------------------------------------------------
/usr/bin/openssl rand -hex 32 >"$REPO/android/signing-cert.sha256"
commit "another fingerprint"
expect_refusal "verify, other signer" "not by the published certificate" bash "$REPO/scripts/build-android.sh" verify "$tmp/good.apk"
rm -f "$apk"
expect_refusal "release, other signer" "not by the published certificate" bash "$REPO/scripts/build-android.sh" release
[[ ! -f "$apk" ]] && pass "release, other signer: no APK written" || fail "release, other signer: an APK was written"

kill "$watcher" 2>/dev/null || true
wait "$watcher" 2>/dev/null || true
watcher=""
[[ ! -s "$tmp/leaks" ]] && pass "ps -axww never showed the password" || fail "the password showed in ps -axww"

if [[ $failures -gt 0 ]]; then
    echo "$failures failed" >&2
    exit 1
fi
echo "all passed"
