#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
# Puts the Vite dev server's origin (:5173) on the server's trusted list. Only here: a production
# instance must not trust whatever else happens to be serving on Vite's default port.
export FREMKIT_DEV=1
# Reads the widget author's folder (data/widgets-dev, or FREMKIT_WIDGET_DEV_DIR) and reloads a
# widget's frames when its files are saved. See server/src/widgets/dev.ts.
export FREMKIT_WIDGET_DEV=1
# One access secret for the whole session, so scripts keep working while `tsx watch` restarts the
# server on every save. A browser's session dies with each restart (sessions live in the server's
# memory): run `pnpm open --dev` again. Never printed; the server writes it to its token file.
FREMKIT_ACCESS_TOKEN=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
export FREMKIT_ACCESS_TOKEN
echo "fremkit: sign the browser in with: pnpm open --dev   (or pnpm open --dev /admin)"
pnpm --filter server dev &
pnpm --filter ui dev &
wait
