#!/usr/bin/env bash
# Launch Chrome in full-screen app mode on the Xeneon Edge display (2560x720).
# Without the Edge plugged in: a 2560x720 window on the main display.
set -euo pipefail
SERVER="${FREMKIT_URL:-http://127.0.0.1:4242}"
# The server answers only holders of its access secret: Chrome is given a one-time link that sets
# the cookie in its profile and lands on the dashboard (see scripts/lib/access.sh).
. "$(dirname "$0")/lib/access.sh"
URL=$(fremkit_auth_url "${SERVER%/}" /) || {
  echo "fremkit: could not get a sign-in link from $SERVER; is the server running?" >&2
  exit 1
}
PROFILE="$HOME/Library/Application Support/Fremkit/chrome-profile"
mkdir -p "$PROFILE"

# Locate the 2560x720 display via the CoreGraphics API (Swift, no dependency).
read -r X Y < <(swift - <<'SWIFT' 2>/dev/null || echo "0 0"
import CoreGraphics
var count: UInt32 = 0
var ids = [CGDirectDisplayID](repeating: 0, count: 16)
CGGetActiveDisplayList(16, &ids, &count)
for i in 0..<Int(count) {
  let b = CGDisplayBounds(ids[i])
  if Int(b.width) == 2560 && Int(b.height) == 720 { print(Int(b.origin.x), Int(b.origin.y)); exit(0) }
}
print(0, 0)
SWIFT
)

open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE" \
  --app="$URL" \
  --window-position="$X,$Y" \
  --window-size=2560,720 \
  --kiosk \
  --no-first-run --disable-session-crashed-bubble --autoplay-policy=no-user-gesture-required
