#!/usr/bin/env bash
# Claude Code status line: prints a one-line status and forwards the JSON to Fremkit in the background.
# Requires jq. Configure: "statusLine": { "type": "command", "command": "<repo>/scripts/claude-statusline.sh" }
URL="${FREMKIT_HOOK_URL:-http://127.0.0.1:4242/api/hooks/claude}"
# The server's access secret, from its token file, given to curl through a descriptor (never argv).
. "$(dirname "$0")/lib/access.sh" 2>/dev/null || fremkit_auth_header() { :; }
PORT=$(fremkit_port_of "$URL" 2>/dev/null || echo 4242)

# Degrade cleanly on a machine without jq instead of emitting noise.
command -v jq >/dev/null 2>&1 || { printf '%s\n' 'fremkit: jq required'; exit 0; }

input="$(cat)"

# Git needs the cwd, so read just that first; everything else is then assembled by a single jq
# call. Fields are collected into an array and joined, so a missing field never leaves a " · ".
cwd="$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // "."' 2>/dev/null)"

# One git call for the branch, the repository and where in it the session sits. The folder's own
# name says "bg-rollup" for a session in a subfolder or a worktree; the repository's name is what
# tells the projects apart, and the place (worktree, then subfolder) follows it.
branch='' repo='' place=''
{ IFS= read -r branch; IFS= read -r common; IFS= read -r top; IFS= read -r prefix; } < <(
  git -C "${cwd:-.}" rev-parse --abbrev-ref HEAD --path-format=absolute --git-common-dir --show-toplevel --show-prefix 2>/dev/null)
if [ -n "$common" ]; then
  case "$common" in
    */.git) repo="$(basename "$(dirname "$common")")" ;;
    *) repo="$(basename "$common" .git)" ;;  # a bare repository's worktree
  esac
  worktree="$(basename "$top")"
  [ "$worktree" != "$repo" ] && place="$worktree"
  prefix="${prefix%/}"
  [ -n "$prefix" ] && place="${place:+$place/}$prefix"
fi

# Forward without waiting; tag the payload so the server knows it is a status line, not a
# hook, and pass along what git said above.
printf '%s' "$input" | jq -c --arg branch "$branch" --arg repo "$repo" --arg place "$place" \
  '. + {hook_event_name: "StatusLine", fremkit_branch: $branch, fremkit_repo: $repo, fremkit_place: $place}' 2>/dev/null \
  | curl --silent --output /dev/null --max-time 0.5 -X POST -H 'content-type: application/json' \
    -H @<(fremkit_auth_header "$PORT") --data-binary @- "$URL" >/dev/null 2>&1 &

# The session's name (`/rename`) first: it is what tells one chat from another.
line="$(printf '%s' "$input" | jq -r --arg branch "$branch" --arg repo "$repo" --arg place "$place" '
  def pct(x): if x == null then empty else (x | floor | tostring) + "%" end;
  [
    (.session_name // empty),
    (.model.display_name // .model.id // empty),
    (if $repo != "" then $repo + (if $place != "" then "/" + $place else "" end)
     else ((.workspace.current_dir // .cwd // empty) | split("/") | last) end),
    $branch,
    (if .context_window.used_percentage != null then "ctx " + pct(.context_window.used_percentage) else empty end),
    (if .cost.total_cost_usd != null then "$" + ((.cost.total_cost_usd * 100 | round) / 100 | tostring) else empty end),
    (if .rate_limits.five_hour.used_percentage != null then "5h " + pct(.rate_limits.five_hour.used_percentage) else empty end),
    (if .rate_limits.seven_day.used_percentage != null then "7d " + pct(.rate_limits.seven_day.used_percentage) else empty end)
  ] | map(select(. != null and . != "")) | join(" · ")' 2>/dev/null)"
printf '%s\n' "$line"
