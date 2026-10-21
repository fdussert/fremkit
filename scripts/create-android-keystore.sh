#!/usr/bin/env bash
# Create the Android release signing key, once. The owner runs this; an agent never does.
#
#   bash scripts/create-android-keystore.sh
#
# Writes a PKCS12 keystore holding one EC P-256 key (alias `fremkit`, a 30-year certificate for
# `CN=Fremkit Android`) to ~/Library/Application Support/Fremkit-release/fremkit-android.p12, in
# a 0700 folder, as a 0600 file. Its password is generated here and goes straight into the login
# keychain (service `fremkit-android-release`, account `release`), where
# `scripts/build-android.sh release` reads it. The password never reaches a command line: any
# account on the Mac reads every process's arguments with `ps`. It reaches `security` on stdin
# (`security -i`, as server/src/secrets/keychain.ts writes the server's secrets) and `keytool` on
# its prompt, which reads stdin when it is not a terminal.
#
# Then it writes the certificate's SHA-256 to android/signing-cert.sha256, the fingerprint every
# release is checked against and that the site publishes, and prints it.
#
# It refuses to run when the keystore, the keychain item or the fingerprint file already exists:
# a second key would make every later release an APK no installed copy accepts as an update.
#
# Environment (for tests; a real run sets none of these):
#   FREMKIT_ANDROID_KEYSTORE           the keystore file instead of the default
#   FREMKIT_ANDROID_KEYCHAIN           a keychain file instead of the login keychain
#   FREMKIT_ANDROID_KEYCHAIN_SERVICE   the keychain service instead of fremkit-android-release
set -euo pipefail

cd "$(dirname "$0")/.."

die() { echo "create-android-keystore: $*" >&2; exit 1; }

KEYSTORE="${FREMKIT_ANDROID_KEYSTORE:-$HOME/Library/Application Support/Fremkit-release/fremkit-android.p12}"
KEYCHAIN="${FREMKIT_ANDROID_KEYCHAIN:-}"
SERVICE="${FREMKIT_ANDROID_KEYCHAIN_SERVICE:-fremkit-android-release}"
ACCOUNT=release
ALIAS=fremkit
CERT_FILE=android/signing-cert.sha256
SECURITY=/usr/bin/security

# The keychain path and service go on `security -i`'s line, which splits on spaces.
[[ "$SERVICE" =~ ^[A-Za-z0-9._-]+$ ]] || die "the keychain service must be letters, digits, dots, dashes"
[[ -z "$KEYCHAIN" || "$KEYCHAIN" =~ ^[^[:space:]\"\'\\]+$ ]] || die "the keychain path must not contain spaces or quotes"

JAVA_HOME="${FREMKIT_JAVA_HOME:-$(/usr/libexec/java_home -v 17+ 2>/dev/null || true)}"
KEYTOOL="$JAVA_HOME/bin/keytool"
[[ -x "$KEYTOOL" ]] || die "no keytool (JDK 17+): run scripts/build-android.sh doctor"

# --- Refusals -----------------------------------------------------------------------------------
[[ ! -e "$KEYSTORE" ]] || die "$KEYSTORE already exists; this script never replaces a signing key"
if "$SECURITY" find-generic-password -s "$SERVICE" -a "$ACCOUNT" ${KEYCHAIN:+"$KEYCHAIN"} >/dev/null 2>&1; then
    die "the keychain already holds a $SERVICE password; delete it only if no release was ever signed with it"
fi
[[ ! -s "$CERT_FILE" ]] || die "$CERT_FILE already names a signing certificate; this script never replaces a signing key"

# --- Create ---------------------------------------------------------------------------------------
umask 077
dir="$(dirname "$KEYSTORE")"
mkdir -p "$dir"
chmod 700 "$dir"

work="$(mktemp -d "${TMPDIR:-/tmp}/fremkit-keystore.XXXXXX")"
trap 'rm -rf "${work:?}"' EXIT

# 32 random bytes in base64: no space or quote, so it needs no escaping on the `security -i` line.
password="$(/usr/bin/openssl rand -base64 32)"
[[ "$password" =~ ^[A-Za-z0-9+/=]{44}$ ]] || die "openssl gave no password"

# Into the keychain first: a keystore whose password was never kept is a key already lost.
printf 'add-generic-password -s %s -a %s -w %s %s\n' "$SERVICE" "$ACCOUNT" "$password" "$KEYCHAIN" |
    "$SECURITY" -i >/dev/null || die "could not store the password in the keychain"
[[ "$("$SECURITY" find-generic-password -s "$SERVICE" -a "$ACCOUNT" -w ${KEYCHAIN:+"$KEYCHAIN"})" == "$password" ]] ||
    die "the keychain does not give the password back"

# keytool asks for the new password twice, and reads both answers from stdin.
printf '%s\n%s\n' "$password" "$password" | "$KEYTOOL" -genkeypair -storetype PKCS12 \
    -keystore "$KEYSTORE" -alias "$ALIAS" -keyalg EC -groupname secp256r1 -sigalg SHA256withECDSA \
    -validity 10950 -dname "CN=Fremkit Android" >/dev/null 2>&1 || die "keytool could not create the keystore"
chmod 600 "$KEYSTORE"

printf '%s\n' "$password" | "$KEYTOOL" -exportcert -storetype PKCS12 -keystore "$KEYSTORE" \
    -alias "$ALIAS" -file "$work/cert.der" >/dev/null 2>&1 || die "keytool could not read the certificate back"
unset password
fingerprint="$(/usr/bin/shasum -a 256 "$work/cert.der" | cut -d' ' -f1)"
[[ "$fingerprint" =~ ^[0-9a-f]{64}$ ]] || die "could not compute the certificate's SHA-256"
printf '%s\n' "$fingerprint" >"$CERT_FILE"
chmod 644 "$CERT_FILE"

cat <<EOF

The Android release key is created.

  keystore     $KEYSTORE (0600, folder 0700)
  password     in the keychain: service $SERVICE, account $ACCOUNT
  certificate  SHA-256 $fingerprint
               $(sed 's/../&:/g; s/:$//' <<<"$fingerprint" | tr 'a-f' 'A-F')
  written to   $CERT_FILE (commit it)

Back it up now, and nowhere else: in the password manager, a secure note with the keystore file
attached and the password in the note (read it with
  security find-generic-password -s $SERVICE -a $ACCOUNT -w
and paste it; do not keep it in a file). Nothing else is a backup. Lost, and no update of the app
can ever be installed again; leaked, and anyone can ship an update of it (docs/releasing.md).
EOF
