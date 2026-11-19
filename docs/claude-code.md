# Claude Code integration

Two widgets read live data from [Claude Code](https://claude.com/claude-code):

- [`claude-sessions`](widgets.md#claude-sessions) — every live session: project, branch, model,
  state (working, idle, waiting), subagents and elapsed time.
- [`claude-usage`](widgets.md#claude-usage) — the 5 h and 7 day limits and today's token count.

Both are fed by two scripts in this repo, which you add to your Claude Code settings. Nothing is
installed and nothing runs unless Claude Code calls it.

## Setup

Add this to `~/.claude/settings.json`, replacing `<repo>/scripts` with where the scripts are:

- **the app**: `/Applications/Fremkit.app/Contents/Resources/scripts` — they ship inside it, and
  an update replaces them in place, so the path stays valid;
- **a source install**: `<checkout>/scripts`.

Fremkit does not edit this file for you: it is Claude Code's, and holds your own hooks too.


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

Both scripts POST to `/api/hooks/claude`, with the server's access secret read from
`~/Library/Application Support/Fremkit/access-4242.token` (the port follows `FREMKIT_HOOK_URL`;
`FREMKIT_ACCESS_TOKEN_FILE` names another file). They source `lib/access.sh` from beside
themselves, so keep the two together if you copy them. The hooks are asynchronous and never block
Claude Code, even when Fremkit is not running. The status line needs `jq` and degrades to one line of text
without it.

The status line reads `name · model · repository/place · branch · ctx · cost · limits`. The name is
the session's own, given with `/rename` in Claude Code; it titles the session's card too, and is
the way to tell twenty chats apart. The repository is named after the repository, not the folder,
so a session in a worktree or a subfolder of it (`tools/bg-rollup`) shows `platform/tools/bg-rollup`
rather than `bg-rollup` alone.

## What is sent

Only the tool name and a short summary reach Fremkit. Tool inputs and outputs are never sent and
never stored.

The hook also adds a `client` object saying where the session lives: the terminal application's
bundle id, `TERM_PROGRAM`, the pid of the `claude` process, its tty, and the Orca pane
handle when present. For cmux, the server reads workspace and surface ids from the live
process. The server otherwise sees only a session id and a working directory, which cannot
distinguish two panes of the same folder. These details make the ↗ on a card work.

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
| cmux | the exact panel through the bundled `cmux focus-panel` CLI when the socket permits external clients; otherwise the application |
| Terminal.app, iTerm2 | the tab whose tty matches, through AppleScript — macOS asks once to allow it |
| VS Code | the window already open on that folder |
| anything else | the application, by its bundle id |

The helper starts Fremkit outside cmux. With cmux socket control set to `cmuxOnly`, the
`focus-panel` command is denied and touching a card brings cmux forward without selecting
its panel. Exact panel selection requires a socket mode that allows the helper's process,
such as `allowAll`; that mode expands local socket access. Keep `cmuxOnly` if you prefer the
restricted mode and use the application fallback.

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

The `claude-account` provider goes one step further, once **/admin → Settings → Privacy → Read the
Claude account usage** is ticked: it calls the account usage endpoint for each claude.ai account
in use on this Mac, every 5 minutes per account.

Claude Code runs from a configuration folder: `~/.claude` by default, another one when
`CLAUDE_CONFIG_DIR` is set, as a terminal with profiles does. The server learns the folders from
the hooks' `transcript_path`, remembers them and when each last sent an event in
`data/claude-config-dirs.json`, and reads each folder's `.claude.json` (`~/.claude.json` for the
default one) for the account it is signed in to: its uuid and its organisation's type, which names
the plan. Two folders on the same account are one account. An account is listed while one of its
folders sent an event, or its usage was read, within seven days.

Each account's token is read from the keychain items of its own folders: "Claude Code-credentials"
for the default folder, "Claude Code-credentials-" followed by eight characters of a hash of the
folder for any other; the one expiring last wins. The token is never stored or logged, is read
with `security … -w` (never on a command line), and is sent only to `api.anthropic.com`. Fremkit
never refreshes a token and never writes to these items: Claude Code refreshes an account's token
only while a session runs on it, so an account with no session running keeps its last numbers,
shown as stale, until one starts. Each account has its own back-off after a 429 or empty keychain
reads, and its own last good snapshot in `data/claude-account.json`; at most one account is asked
every 20 seconds, so the polls are spread out. macOS may ask once to allow keychain access. The
endpoint is undocumented and may change without notice.

With the usage reading off, nothing is read from the keychain: each account's row shows what the
status lines of the sessions in its folders last reported. That attribution is by folder, which is
wrong for a session billed to another account than its folder's (through a local auth proxy, say);
the usage reading is the path that stays right.

The channel carries one row per account: an opaque key (a hash of the uuid, never the uuid), the
name given in **Settings → Privacy** or else the plan, the plan, the 5-hour and 7-day windows,
`stale`, `error` and `updatedAt`. Today's token count reads every folder's `projects` and stays
the Mac's total.

Nothing the Claude providers publish carries the account's e-mail address. Should one ever do so,
it is held to the rule every account provider is: the address is left out unless **/admin →
Settings → Privacy → Show the account e-mail address** is ticked (see
[connections.md](connections.md#the-accounts-e-mail-address)).

The `claude-identity` channel reads `claude auth status --json` from a fixed local binary path. It
publishes only login state, authentication method and the known plan, never the account email or
authentication data. The Claude limits widget no longer reads it: each of its rows carries its own
account's plan.
