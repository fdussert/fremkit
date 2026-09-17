#!/usr/bin/env bash
# One-command setup after `git clone`: check the prerequisites, install and build the
# workspace, build and install the native helper, then print the first-run checklist.
#
#   bash scripts/setup.sh            full setup
#   bash scripts/setup.sh --check    prerequisites only, no install, no build
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

CHECK_ONLY=false
case "${1:-}" in
    --check) CHECK_ONLY=true ;;
    "") ;;
    *) echo "usage: bash scripts/setup.sh [--check]" >&2; exit 2 ;;
esac

FAILED=0
ok()   { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILED=1; }
hint() { printf '        %s\n' "$1"; }

echo "Fremkit prerequisites"
echo

# --- macOS 13 or later -------------------------------------------------------------------
if [ "$(uname -s)" != "Darwin" ]; then
    fail "macOS required (this is $(uname -s))"
else
    MACOS_VERSION="$(sw_vers -productVersion)"
    MACOS_MAJOR="${MACOS_VERSION%%.*}"
    if [ "$MACOS_MAJOR" -ge 13 ] 2>/dev/null; then
        ok "macOS $MACOS_VERSION (13 or later required)"
    else
        fail "macOS $MACOS_VERSION is too old; 13 or later is required"
    fi
fi

# --- Xcode Command Line Tools, with an SDK the helper build accepts ----------------------
if ! xcode-select -p >/dev/null 2>&1; then
    fail "Xcode Command Line Tools not installed"
    hint "install them with: xcode-select --install"
elif ! command -v swiftc >/dev/null 2>&1; then
    fail "swiftc not found although the Command Line Tools are installed"
    hint "try: sudo xcode-select --reset"
else
    # swiftc-common.sh exits non-zero when no usable SDK is found; run it in a subshell so
    # that exit does not take this script down with it.
    if SDK="$(set -euo pipefail; . scripts/lib/swiftc-common.sh; printf '%s' "$SDK")"; then
        ok "Xcode Command Line Tools ($(xcode-select -p))"
        ok "macOS SDK: $SDK"
    else
        fail "no macOS SDK the helper build can use"
        hint "the build needs an SDK the installed swiftc can parse; set FREMKIT_SDK to one"
        hint "of /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk"
    fi
fi

# --- Node 22 or later --------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js not found"
    hint "install Node 22 or later (https://nodejs.org, or: brew install node)"
else
    NODE_VERSION="$(node -v)"
    NODE_MAJOR="${NODE_VERSION#v}"
    NODE_MAJOR="${NODE_MAJOR%%.*}"
    if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
        ok "Node $NODE_VERSION (22 or later required)"
    else
        fail "Node $NODE_VERSION is too old; 22 or later is required"
    fi
fi

# --- pnpm --------------------------------------------------------------------------------
if command -v pnpm >/dev/null 2>&1; then
    ok "pnpm $(pnpm -v)"
else
    fail "pnpm not found"
    hint "install it with: corepack enable pnpm   (or: npm install -g pnpm)"
fi

# --- jq: only the Claude Code status line needs it, so this is a note, not a failure ------
if command -v jq >/dev/null 2>&1; then
    ok "jq $(jq --version) (optional, for the Claude Code status line)"
else
    printf '  note  jq not found — optional, only the Claude Code status line uses it\n'
fi

echo
if [ "$FAILED" -ne 0 ]; then
    echo "Some prerequisites are missing; fix them and run this again." >&2
    exit 1
fi
echo "All prerequisites satisfied."

if [ "$CHECK_ONLY" = true ]; then
    exit 0
fi

# --- Workspace ---------------------------------------------------------------------------
echo
echo "==> pnpm install"
pnpm install

echo
echo "==> pnpm build (ui + server)"
pnpm build

# --- Signing identity --------------------------------------------------------------------
IDENTITY="${FREMKIT_SIGN_IDENTITY:-Fremkit Helper Dev}"
echo
if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then
    echo "==> code-signing identity \"$IDENTITY\" is already in the login keychain"
else
    echo "The helper is signed ad hoc unless a stable code-signing identity exists."
    echo "With an ad-hoc signature, every rebuild of the helper drops the macOS permissions"
    echo "(Input Monitoring, Accessibility) you granted the previous build."
    echo "scripts/create-signing-identity.sh creates a local self-signed identity that fixes that."
    echo "It asks for your login password."
    printf 'Create it now? [Y/n] '
    if [ -t 0 ]; then
        read -r answer || answer=""
    else
        answer="n"
        echo "n (not an interactive terminal)"
    fi
    case "$answer" in
        [nN]*) echo "Skipped. Run scripts/create-signing-identity.sh later to change your mind." ;;
        *) bash scripts/create-signing-identity.sh ;;
    esac
fi

# --- Helper ------------------------------------------------------------------------------
# The config is written *before* the helper is installed, because installing it launches it: a
# helper that starts without a repoPath supervises nothing, and the user has to quit and relaunch
# it by hand to pick the path up. The helper supervises the server from the checkout, and an
# installed bundle cannot guess where that checkout is.
echo
echo "==> pointing the helper at this checkout"
HELPER_CONFIG="$HOME/Library/Application Support/Fremkit/helper.json"
mkdir -p "$(dirname "$HELPER_CONFIG")"
REPO="$REPO" HELPER_CONFIG="$HELPER_CONFIG" node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const path = process.env.HELPER_CONFIG
let config = {}
try { config = JSON.parse(readFileSync(path, "utf8")) } catch { config = {} }
config.repoPath = process.env.REPO
writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
'
echo "repoPath: $REPO ($HELPER_CONFIG)"

echo
echo "==> building and installing the helper"
bash scripts/install-helper.sh

# --- First-run checklist -----------------------------------------------------------------
cat <<'CHECKLIST'

Setup done. First run, in this order:

  1. Quit Touchscreen Gestures, if you use it. It holds the touch panel exclusively, so the
     helper cannot open it. Quitting the app is not enough when its launchd agent relaunches
     it: unload the agent too.
         launchctl bootout "gui/$UID" ~/Library/LaunchAgents/<its agent>.plist

  2. Input Monitoring — System Settings > Privacy & Security > Input Monitoring.
     Add "Fremkit Helper" and switch it on. The helper needs it to read the touch panel.

  3. Accessibility — System Settings > Privacy & Security > Accessibility.
     Add "Fremkit Helper" and switch it on. Needed to post the synthetic mouse and scroll
     events the touch driver produces, and to read the Dock's notification badges.

  4. Relaunch the helper (quit it from the menu bar "F", then open it from ~/Applications).
     Permissions granted while it runs only take effect on the next launch.

  5. Local Network — asked for the first time the server talks to a device on your LAN
     (a Bambu Lab printer, say). Allow "Fremkit Helper" when macOS asks, or add it under
     System Settings > Privacy & Security > Local Network.

  6. Launch at login — optional, from the menu bar "F" menu.

The dashboard opens by itself on the Xeneon Edge display. The admin is in the same menu
("Open the admin"), or at http://127.0.0.1:4242/admin.
CHECKLIST
