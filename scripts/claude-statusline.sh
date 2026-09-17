#!/usr/bin/env bash
# Claude Code status line: prints a one-line status and forwards the JSON to Fremkit in the background.
# Requires jq. Configure: "statusLine": { "type": "command", "command": "<repo>/scripts/claude-statusline.sh" }
URL="${FREMKIT_HOOK_URL:-http://127.0.0.1:4242/api/hooks/claude}"

# Degrade cleanly on a machine without jq instead of emitting noise.
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'fremkit: jq required'; exit 0; }

input="$(cat)"

# The git branch needs the cwd, so read just that first; everything else — the
# branch included — is then assembled by a single jq call. Fields are collected
# into an array and joined, so a missing leading field never leaves a " · ".
cwd="$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // "."' 2>/dev/null)"
branch="$(git -C "${cwd:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null)"

# Forward without waiting; tag the payload so the server knows it is a status line, not a
# hook, and pass along the branch just computed above.
printf '%s' "$input" | jq -c --arg branch "$branch" '. + {hook_event_name: "StatusLine", fremkit_branch: $branch}' 2>/dev/null \
  | curl --silent --output /dev/null --max-time 0.5 -X POST -H 'content-type: application/json' --data-binary @- "$URL" >/dev/null 2>&1 &

line="$(printf '%s' "$input" | jq -r --arg branch "$branch" '
  def pct(x): if x == null then empty else (x | floor | tostring) + "%" end;
  [
    (.model.display_name // .model.id // empty),
    ((.workspace.current_dir // .cwd // empty) | split("/") | last),
    $branch,
    (if .context_window.used_percentage != null then "ctx " + pct(.context_window.used_percentage) else empty end),
    (if .cost.total_cost_usd != null then "$" + ((.cost.total_cost_usd * 100 | round) / 100 | tostring) else empty end),
    (if .rate_limits.five_hour.used_percentage != null then "5h " + pct(.rate_limits.five_hour.used_percentage) else empty end),
    (if .rate_limits.seven_day.used_percentage != null then "7d " + pct(.rate_limits.seven_day.used_percentage) else empty end)
  ] | map(select(. != null and . != "")) | join(" · ")' 2>/dev/null)"
printf '%s\n' "$line"
