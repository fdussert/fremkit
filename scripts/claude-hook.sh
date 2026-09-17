#!/usr/bin/env bash
# Claude Code hook: forward the event JSON to Fremkit. Always exits 0; never blocks the session.
# Configure it with "async": true in ~/.claude/settings.json.
URL="${FREMKIT_HOOK_URL:-http://127.0.0.1:4242/api/hooks/claude}"
curl --silent --output /dev/null --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- "$URL" || true
exit 0
