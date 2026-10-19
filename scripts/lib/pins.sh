#!/usr/bin/env bash
# What the app build pins, shared by build-app.sh, notarize.sh and release.sh. Source from the
# repo root.

# Node: one current LTS line. The tarball is checked against SHASUMS256.txt from nodejs.org, as
# published, and against the hash pinned here, so a changed file on the server fails the build
# instead of shipping. Bump both together.
NODE_VERSION="24.21.0"
NODE_TARBALL="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_SHA256="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"

# Sparkle 2: the release tarball, its SHA-256 as GitHub publishes it for the asset.
SPARKLE_VERSION="2.10.0"
SPARKLE_TARBALL="Sparkle-${SPARKLE_VERSION}.tar.xz"
SPARKLE_SHA256="c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c"
# Where build-app.sh unpacks it; sign_update and generate_keys are in its bin/.
SPARKLE_DIR="native/.build/app/sparkle-${SPARKLE_VERSION}"

# The project's Apple team. Public: it is in every signature it makes.
TEAM_ID="874TMS6WBS"

# The SHA-1 of the team's Developer ID Application identity in the login keychain, or nothing.
# By hash rather than by name: after a renewal the keychain holds two certificates with the same
# name, and codesign refuses a name that matches both. The first valid one is taken.
fremkit_developer_id() {
    local identities
    identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
    awk -v team="($TEAM_ID)" '/"Developer ID Application: / && index($0, team) {print $2; exit}' <<<"$identities"
}
