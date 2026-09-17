#!/usr/bin/env bash
# Build the helper and install it into ~/Applications, then launch it.
set -euo pipefail

cd "$(dirname "$0")/.."

bash scripts/build-helper.sh

APP="native/dist/Fremkit Helper.app"
DEST="$HOME/Applications/Fremkit Helper.app"

# Replacing the bundle under a running helper leaves the old process alive on a deleted
# executable, so it keeps the touch panel seized and the port busy. Ask it to quit first and give
# it time to do so: `quit` lets applicationWillTerminate run, which stops the server cleanly,
# releases the touch panel and takes the kiosk window down. Only a helper still up after that is
# killed.
osascript -e 'quit app "Fremkit Helper"' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6; do
    pgrep -x FremkitHelper >/dev/null 2>&1 || break
    sleep 0.5
done
if pgrep -x FremkitHelper >/dev/null 2>&1; then
    pkill -x FremkitHelper || true
    for _ in 1 2 3 4; do
        pgrep -x FremkitHelper >/dev/null 2>&1 || break
        sleep 0.5
    done
fi
if pgrep -x FremkitHelper >/dev/null 2>&1; then
    echo "warning: FremkitHelper is still running; installing over it anyway" >&2
fi

# Replace the bundle's contents in place rather than deleting and recreating it: macOS ties
# the "Local Network" decision to the installed bundle, and deleting it silently drops that
# grant (the app then vanishes from the list and is never asked again).
mkdir -p "$DEST"
rsync -a --delete "$APP/" "$DEST/"

echo "installed: $DEST"
open "$DEST"
