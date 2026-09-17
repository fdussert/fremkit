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

## Rate limits

Rate limits appear only for claude.ai Pro and Max subscribers, and only after the first API
response of a session.

The `claude-account` provider goes one step further: it reads the Claude Code OAuth token from the
macOS keychain (the item "Claude Code-credentials") every 5 minutes and calls the account usage
endpoint for per-model weekly limits. The token is never stored or logged and is sent only to
`api.anthropic.com`. macOS may ask once to allow keychain access. The endpoint is undocumented and
may change without notice.
