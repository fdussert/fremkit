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

### Windows

On Windows the same two scripts exist as Node programs, `claude-hook.mjs` and
`claude-statusline.mjs`, which need only the Node that runs Claude Code's tooling (Node 22.13 or
later) and no `bash` or `jq`. In `%USERPROFILE%\.claude\settings.json` (or the file `CLAUDE_CONFIG_DIR`
names), use the same layout as above with these commands, replacing `<repo>` with the checkout:

```json
"statusLine": { "type": "command", "command": "node <repo>\\scripts\\claude-statusline.mjs" },
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node <repo>\\scripts\\claude-hook.mjs", "async": true }] }]
}
```

Repeat the hook entry for each event in the list above. Backslashes are doubled because this is
JSON.

- The server's access secret is read from `%LOCALAPPDATA%\Fremkit\access-4242.token` (the port
  follows `FREMKIT_HOOK_URL`; `FREMKIT_SUPPORT_DIR` and `FREMKIT_ACCESS_TOKEN_FILE` work as on the
  Mac). The scripts read it themselves and send it in a header only, never on a command line.
  They load `lib/access.mjs` from beside themselves, so keep them together if you copy them.
- The `client` object carries `TERM_PROGRAM` and, when set, the distribution name from
  `WSL_DISTRO_NAME`. It carries no pid on Windows: Claude Code runs a hook through a shell there,
  so the hook's parent may not be `claude`, and sessions rely on the hooks and the tracker's own
  fallback instead.
- The secret is sent only to `127.0.0.1`, `localhost` or `[::1]`, and a redirect is never followed.
- The status line prints the same text as the bash version, with the folder name taken from
  either kind of path separator.
- Account usage reads Claude Code's credentials from `%USERPROFILE%\.claude\.credentials.json`,
  or from `.credentials.json` in `CLAUDE_CONFIG_DIR` when that is an absolute path such as
  `D:\claude`. As on the Mac it happens only when **Read the Claude account usage** (the screen's settings) is
  ticked, and the token is never stored or logged.

### WSL

Claude Code running inside a WSL distribution is read too, once you tick that distribution under
**Privacy → WSL distributions to read** in the settings (the section appears on Windows only).
Nothing is read in a distribution that is not ticked, and none is ticked by default. For each
ticked one, Fremkit asks `wsl.exe` for its home folder (once when it is found, again a minute after
a failure), which starts it if it was stopped, then reads through `\\wsl.localhost\<distro>\…`:

- usage: the transcripts under `~/.claude/projects`, added to the Windows ones;
- account usage, when **Read the Claude account usage** is ticked: `~/.claude/.credentials.json`
  of the first ticked distribution that has one, and only when Windows itself has none.

A distribution that does not answer within 5 seconds, or whose home folder is still being looked
up, counts as offline for that read; the others still report.

Live sessions need the hooks inside the distribution to reach the server on Windows, which takes
WSL's *mirrored* networking mode (`networkingMode=mirrored` under `[wsl2]` in
`%USERPROFILE%\.wslconfig`), so that `127.0.0.1` inside WSL is the PC's own loopback. In
`~/.claude/settings.json` inside the distribution, run the Node hook with Linux's `node`, pointing
it at the Windows support folder where the access secret lives (`<you>` is your Windows user name,
`<repo>` the checkout as seen from WSL, for instance under `/mnt/c/…`):

```json
"statusLine": { "type": "command", "command": "FREMKIT_SUPPORT_DIR=/mnt/c/Users/<you>/AppData/Local/Fremkit node <repo>/scripts/claude-statusline.mjs" },
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "FREMKIT_SUPPORT_DIR=/mnt/c/Users/<you>/AppData/Local/Fremkit node <repo>/scripts/claude-hook.mjs", "async": true }] }]
}
```

Repeat the hook entry for each event in the list above. The hook adds the distribution's name
(`WSL_DISTRO_NAME`) to the session's `client`. In the default *NAT* mode the hooks cannot reach
the server: usage and history still show, but no live sessions.

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

The `claude-account` provider goes one step further: it reads the Claude Code OAuth token from the
macOS keychain (the item "Claude Code-credentials") every 5 minutes and calls the account usage
endpoint for per-model weekly limits. The token is never stored or logged and is sent only to
`api.anthropic.com`. macOS may ask once to allow keychain access. The endpoint is undocumented and
may change without notice.

Nothing the Claude providers publish carries the account's e-mail address. Should one ever do so,
it is held to the rule every account provider is: the address is left out unless **/admin →
Settings → Privacy → Show the account e-mail address** is ticked (see
[connections.md](connections.md#the-accounts-e-mail-address)).

The usage tile also shows a plan badge when the local Claude CLI reports a known subscription.
Fremkit reads `claude auth status --json` from a fixed local binary path. It publishes only login
state, authentication method and the known plan, never the account email or authentication data.
The plan badge is independent of the optional account-usage read.
