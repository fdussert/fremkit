#!/usr/bin/env bash
# Claude Code hook: forward the event JSON to Fremkit. Always exits 0; never blocks the session.
# Configure it with "async": true in ~/.claude/settings.json.
#
# The hook runs *inside* the session's environment, which is the only place that knows where that
# session lives: which terminal application owns it, which pane, which tty. Nothing else can find
# out afterwards — the server sees a session id and a working directory, and two sessions in two
# panes of the same folder look identical. So a `client` object is added to the event here.
#
# What is deliberately *not* sent: `ORCA_AGENT_HOOK_ENDPOINT` and `ORCA_AGENT_HOOK_TOKEN`. That
# file holds a token for Orca's own hook receiver, `orca terminal switch` does the job without it,
# and a credential does not belong in an event that ends up in `data/claude-sessions.json`.
#
# jq is not guaranteed on a Mac, so the object is built with printf and merged by hand. Everything
# here is best-effort: any step that fails leaves the event exactly as it arrived.
URL="${FREMKIT_HOOK_URL:-http://127.0.0.1:4242/api/hooks/claude}"

body=$(cat)
[ -n "$body" ] || exit 0

# Escapes one env value into a JSON string body. Control characters become spaces rather than
# escapes: none of these fields is supposed to hold any, and a mangled value is better than a
# body the server drops whole.
esc() { printf %s "$1" | LC_ALL=C sed 's/\\/\\\\/g; s/"/\\"/g; s/[[:cntrl:]]/ /g' | tr -d '\n'; }
field() { [ -n "$2" ] && printf '"%s":"%s",' "$1" "$(esc "$2")"; }

# The pid of the `claude` that fired this hook: walk up from this shell until the command is it.
# Bounded, because a walk to pid 1 on a machine with an odd process tree is not worth a second.
pid=''; p=$$
for _ in 1 2 3 4 5 6 7 8; do
  comm=$(ps -o comm= -p "$p" 2>/dev/null) || break
  [ -n "$comm" ] || break
  if [ "${comm##*/}" = 'claude' ]; then pid=$p; break; fi
  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  case "$p" in ''|0|1) break ;; esac
done

# The tty is what an AppleScript uses to pick one tab out of a window: Terminal.app and iTerm2
# both expose it, and neither exposes the session id their own environment variable carries.
tty=''
[ -n "$pid" ] && tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
case "$tty" in ''|'??') tty='' ;; esac

fields=''
fields="$fields$(field bundleId "$__CFBundleIdentifier")"
fields="$fields$(field program "$TERM_PROGRAM")"
[ -n "$pid" ] && fields="$fields\"pid\":$pid,"
fields="$fields$(field tty "$tty")"
fields="$fields$(field terminalSession "${TERM_SESSION_ID:-$ITERM_SESSION_ID}")"
if [ -n "${ORCA_PANE_KEY:-}${ORCA_TAB_ID:-}${ORCA_TERMINAL_HANDLE:-}" ]; then
  orca="$(field pane "${ORCA_PANE_KEY:-}")$(field tab "${ORCA_TAB_ID:-}")$(field terminal "${ORCA_TERMINAL_HANDLE:-}")"
  [ -n "$orca" ] && fields="$fields\"orca\":{${orca%,}},"
fi

# Merged by splicing after the opening brace: the payload is an object, and rewriting it properly
# would mean parsing JSON in sh. An empty object takes no comma; anything that is not an object
# at all is forwarded untouched.
merged=$body
if [ -n "$fields" ]; then
  case "$body" in
    '{'*)
      rest=${body#\{}
      case "$(printf %s "$rest" | sed 's/^[[:space:]]*//')" in
        '}'*) merged="{\"client\":{${fields%,}}$rest" ;;
        *)    merged="{\"client\":{${fields%,}},$rest" ;;
      esac
      ;;
  esac
fi

printf '%s' "$merged" |
  curl --silent --output /dev/null --max-time 1 -X POST -H 'content-type: application/json' --data-binary @- "$URL" || true
exit 0
