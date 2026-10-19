#!/usr/bin/env bash
# Starts a demo server: invented data on every channel, its own temporary data folder, nothing read
# off this Mac or any account. See docs/demo-mode.md.
#
#   pnpm demo                          http://127.0.0.1:4250, a fresh demo dashboard
#   FREMKIT_PORT=4260 pnpm demo        another port
#   FREMKIT_DATA_DIR=/abs/folder pnpm demo   a demo folder kept between runs
#
# Sign a browser in with `FREMKIT_PORT=4250 pnpm open` (or `… pnpm open /admin`).
set -euo pipefail
cd "$(dirname "$0")/.."
export FREMKIT_DEMO=1
export FREMKIT_PORT="${FREMKIT_PORT:-4250}"
if [ ! -f ui/dist/index.html ]; then
    echo "fremkit: no built UI yet, building it first" >&2
    pnpm --filter ui build
fi
echo "fremkit: demo server on http://127.0.0.1:$FREMKIT_PORT; sign in with: FREMKIT_PORT=$FREMKIT_PORT pnpm open [/admin]" >&2
cd server
exec node_modules/.bin/tsx src/index.ts
