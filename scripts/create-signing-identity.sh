#!/usr/bin/env bash
# Create the self-signed code-signing identity the helper is built with.
#
# Why: an ad-hoc signature (`codesign --sign -`) changes with every build, and macOS ties its
# Input Monitoring / Accessibility grants to the signature. Without a stable identity, every
# rebuild of the helper drops the permissions you granted the previous one. A self-signed
# certificate in your login keychain fixes the identity once and for all.
#
# The certificate is local, self-signed and trusted for code signing only. It is not an Apple
# Developer ID and cannot be used to distribute anything.
#
# Idempotent: it does nothing when `security find-identity -v -p codesigning` already lists it.
set -euo pipefail

IDENTITY="${FREMKIT_SIGN_IDENTITY:-Fremkit Helper Dev}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo "Identity \"$IDENTITY\" already exists in the login keychain; nothing to do."
    exit 0
fi

if [ ! -f "$KEYCHAIN" ]; then
    echo "error: login keychain not found at $KEYCHAIN" >&2
    exit 1
fi

echo "Creating the self-signed code-signing identity \"$IDENTITY\"."
echo "macOS will ask for your login password once or twice: importing the key into the login"
echo "keychain, and marking the certificate as trusted for code signing."
echo

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/openssl.cnf" <<'CONF'
[ req ]
distinguished_name = dn
prompt             = no
x509_extensions    = codesign

[ dn ]
CN = FREMKIT_IDENTITY_CN

[ codesign ]
basicConstraints       = critical,CA:false
keyUsage               = critical,digitalSignature
extendedKeyUsage       = critical,codeSigning
subjectKeyIdentifier   = hash
CONF
# The CN is substituted rather than interpolated so an identity name with shell metacharacters
# cannot leak into the heredoc.
PATTERN='FREMKIT_IDENTITY_CN'
python3 - "$WORK/openssl.cnf" "$PATTERN" "$IDENTITY" <<'PY'
import sys
path, pattern, name = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, encoding="utf-8") as handle:
    text = handle.read()
with open(path, "w", encoding="utf-8") as handle:
    handle.write(text.replace(pattern, name))
PY

echo "==> generating the key and certificate (10 years)"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -config "$WORK/openssl.cnf" \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1

echo "==> packaging them as PKCS#12"
openssl pkcs12 -export -legacy \
    -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$IDENTITY" -passout pass: -out "$WORK/identity.p12" >/dev/null 2>&1 \
  || openssl pkcs12 -export \
    -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$IDENTITY" -passout pass: -out "$WORK/identity.p12" >/dev/null 2>&1

echo "==> importing into the login keychain"
# `-x` marks the private key non-extractable: it can sign, but it cannot be exported back out of
# the keychain. Only codesign is allowed to use it — `security` itself was on that list, which
# let any script dump the key with `security export`.
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "" -x \
    -T /usr/bin/codesign >/dev/null

echo "==> trusting it for code signing"
# User-level trust only (no -d): nothing is added to the system trust store.
security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

# Without this, codesign asks for the login password on every single build. It needs the keychain
# password, which is prompted for interactively rather than passed as an empty `-k ""` — that only
# ever worked on a keychain with no password, and silently failed on every other Mac.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s "$KEYCHAIN" >/dev/null 2>&1 \
  || echo "note: could not pre-authorise codesign; macOS may ask for your password on each build."

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo
    echo "Done. \"$IDENTITY\" is now a code-signing identity in your login keychain."
    echo "scripts/build-helper.sh picks it up automatically."
    echo "Grant the helper's permissions once more after the next build; they then survive rebuilds."
else
    echo "error: the identity was not found after import; see the messages above." >&2
    exit 1
fi
