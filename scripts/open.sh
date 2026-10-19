#!/usr/bin/env bash
# Opens the dashboard or the admin in the default browser, signed in.
#
#   pnpm open            the dashboard, http://127.0.0.1:4242/
#   pnpm open /admin     the admin
#   pnpm open --dev …    the same through the Vite dev server (pnpm dev), http://localhost:5173
#   pnpm open --print …  print the link instead of opening it
#
# The server only answers callers holding its access secret (SECURITY.md). This reads it from the
# token file, asks the server for a one-time code, and opens /auth?code=…, which sets the cookie
# and lands on the page. The link works once, within a minute.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib/access.sh

server="${FREMKIT_URL:-http://127.0.0.1:${FREMKIT_PORT:-4242}}"
page="$server"
print=0
path=/
for arg in "$@"; do
    case "$arg" in
        --dev) page=http://localhost:5173 ;;
        --print) print=1 ;;
        /*) path=$arg ;;
        *) echo "usage: pnpm open [--dev] [--print] [/path]" >&2; exit 2 ;;
    esac
done

if ! url=$(fremkit_auth_url "$server" "$path" "$page"); then
    echo "fremkit: could not get a sign-in link from $server." >&2
    echo "Is the server running, and is $(fremkit_token_file "$(fremkit_port_of "$server")") readable?" >&2
    exit 1
fi
if [ "$print" = 1 ]; then printf '%s\n' "$url"; else open "$url"; fi
