#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
trap 'kill 0' EXIT
# Puts the Vite dev server's origin (:5173) on the server's trusted list. Only here: a production
# instance must not trust whatever else happens to be serving on Vite's default port.
export FREMKIT_DEV=1
pnpm --filter server dev &
pnpm --filter ui dev &
wait
