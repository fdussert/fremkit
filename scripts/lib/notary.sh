#!/usr/bin/env bash
# Where notarytool finds the credentials it submits with, shared by notarize.sh and release.sh.
# Source from the repo root, after pins.sh (for the team the hint names).
#
# `xcrun notarytool store-credentials <profile>` files the profile in the data protection
# keychain, which macOS opens only while the session is unlocked. Behind a locked screen
# notarytool then answers "No Keychain password item found for profile", exactly as if the
# profile had been deleted, and it does so after the ten minutes the build took. Stored with
# `--keychain <the login keychain>` instead, the profile is in the file that already holds the
# Developer ID identity and Sparkle's key, and that file stays open behind a locked screen.
#
# So the login keychain is looked in first, and named to notarytool when it holds the profile;
# a profile that is only in the data protection keychain still works, on an unlocked Mac.

NOTARY_PROFILE="${FREMKIT_NOTARY_PROFILE:-fremkit-notary}"
NOTARY_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Sets NOTARY_AUTH, the arguments that name the profile to notarytool, and NOTARY_IN_LOGIN (1 when
# the login keychain holds it). Reads the item's attributes only, never its password; by account
# alone, because the service differs between an app-specific password and an API key.
notary_locate() {
    NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
    NOTARY_IN_LOGIN=0
    if /usr/bin/security find-generic-password \
        -a "com.apple.gke.notary.tool.saved-creds.$NOTARY_PROFILE" "$NOTARY_KEYCHAIN" >/dev/null 2>&1; then
        NOTARY_AUTH+=(--keychain "$NOTARY_KEYCHAIN")
        NOTARY_IN_LOGIN=1
    fi
}

notary_screen_locked() {
    /usr/sbin/ioreg -n Root -d1 -a 2>/dev/null | grep -A1 '<key>CGSSessionScreenIsLocked</key>' | grep -q '<true/>'
}

# Asks Apple for the submission history with the profile, which proves in a second or two that
# the profile is there, can be read right now and is still accepted. Run before anything long.
notary_check() {
    notary_locate
    local out
    if out="$(xcrun notarytool history "${NOTARY_AUTH[@]}" 2>&1)"; then
        if [ "$NOTARY_IN_LOGIN" -eq 0 ]; then
            echo "note: the notarytool profile $NOTARY_PROFILE is in the keychain macOS closes with the screen;" >&2
            echo "      keep this Mac unlocked until the DMG is notarized (docs/releasing.md says how to move it)" >&2
        fi
        return 0
    fi
    echo "error: notarytool cannot use the profile $NOTARY_PROFILE:" >&2
    head -n 3 <<<"$out" | sed 's/^/    /' >&2
    if [ "$NOTARY_IN_LOGIN" -eq 0 ] && notary_screen_locked; then
        echo "This Mac's screen is locked, and the profile is not in the login keychain: macOS only" >&2
        echo "opens the keychain it is in while the session is unlocked. Unlock the Mac and keep it" >&2
        echo "unlocked for the whole run, or store the profile in the login keychain:" >&2
    elif [ "$NOTARY_IN_LOGIN" -eq 0 ]; then
        echo "If the profile does not exist, the owner creates it, in a terminal of their own:" >&2
    fi
    if [ "$NOTARY_IN_LOGIN" -eq 0 ]; then
        echo "    xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <Apple ID> --team-id ${TEAM_ID:-<team>} \\" >&2
        echo "        --keychain \"$NOTARY_KEYCHAIN\"" >&2
    fi
    return 1
}
