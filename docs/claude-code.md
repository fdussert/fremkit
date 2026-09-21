# Claude Code integration

Two widgets read live data from [Claude Code](https://claude.com/claude-code):

- [`claude-sessions`](widgets.md#claude-sessions) — every live session: project, branch, model,
  state (working, idle, waiting), subagents and elapsed time.
- [`claude-usage`](widgets.md#claude-usage) — the 5 h and 7 day limits and today's token count.

Both are fed by two scripts in this repo, which you add to your Claude Code settings. Nothing is
installed and nothing runs unless Claude Code calls it.

## Setup

Add this to `~/.claude/settings.json`, replacing `<repo>` with the path to your checkout:

```json
"statusLine": { "type": "command", "command": "<repo>/scripts/claude-statusline.sh" },
"hooks": {
  "SessionStart":       [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "PreToolUse":         [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "PostToolUse":        [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "PostToolUseFailure": [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "PermissionRequest":  [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "Notification":       [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "Stop":               [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "StopFailure":        [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }],
  "SessionEnd":         [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/claude-hook.sh", "async": true }] }]
}
```

Both scripts POST to `/api/hooks/claude`. The hooks are asynchronous and never block Claude Code,
even when Fremkit is not running. The status line needs `jq` and degrades to one line of text
without it.

## What is sent

Only the tool name and a short summary reach Fremkit. Tool inputs and outputs are never sent and
never stored.

The hook also adds a `client` object saying where the session lives: the terminal application's
bundle id, `TERM_PROGRAM`, the pid of the `claude` process, its tty, and — under Orca — the pane
and tab it runs in. It is the only way anything can know: the server otherwise sees a session id
and a working directory, and two sessions in two panes of the same folder are the same pair of
strings. It is what makes the ↗ on a card work.

That object stays on the server. The dashboard is told which *kind* of application it is and what
to call it (`Orca`, `Terminal`, `iTerm2`, `VS Code`), never the pane key or the tty.

Two Orca variables are deliberately **not** sent: `ORCA_AGENT_HOOK_ENDPOINT` and
`ORCA_AGENT_HOOK_TOKEN`. That is a token for Orca's own hook receiver, `orca terminal switch`
does the job without it, and a credential has no business in an event that ends up on disk.

## Going to a session

A card that is waiting for you goes to its session when touched; every other card has a ↗ in its
corner. What happens depends on the application:

| Client | What is raised |
|---|---|
| Orca | the exact pane, through `orca terminal switch --terminal <handle>` |
| Terminal.app, iTerm2 | the tab whose tty matches, through AppleScript — macOS asks once to allow it |
| VS Code | the window already open on that folder |
| anything else | the application, by its bundle id |

A session whose hook never said where it lives — one Fremkit found by scanning processes, or one
from before this existed — shows no arrow at all.

## A sound when a session waits

`claude-sessions` can play one of the macOS system sounds when a session starts waiting, either
for any prompt or only for a question. The sound is played by Fremkit itself rather than by the
widget: a widget runs in a sandboxed iframe, which cannot start audio nobody clicked on, and the
point is to hear it when the dashboard is not in front of you. At most one sound every five
seconds, so five subagents stopping together do not chime five times.

## Rate limits

Rate limits appear only for claude.ai Pro and Max subscribers, and only after the first API
response of a session.

The `claude-account` provider goes one step further: it reads the Claude Code OAuth token from the
macOS keychain (the item "Claude Code-credentials") every 5 minutes and calls the account usage
endpoint for per-model weekly limits. The token is never stored or logged and is sent only to
`api.anthropic.com`. macOS may ask once to allow keychain access. The endpoint is undocumented and
may change without notice.
