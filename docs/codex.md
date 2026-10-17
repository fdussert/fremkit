# Codex account, history and observed turns

The `codex` channel provides read-only account quotas, token usage and selected local chats. The `codex-live` channel reports observed turns and direct subagents for those selected chats. Both channels are disabled by default and require an installed Codex CLI. Widgets belong in the registry.

## Enable the data you want

In the admin's screen privacy settings, enable **Codex account usage** for account, quota and token reads. Select one or more **Codex history sources** for bounded local history reads. The available sources are `cli`, `vscode`, `exec`, `appServer`, `subAgent`, `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `subAgentOther` and `unknown`. The broad `subAgent` selection includes its subtypes. An unknown source requires explicit selection.

These settings take effect on the next provider poll without a restart. An unconfigured subscribed channel keeps a 60-second polling cadence, so a new opt-in is picked up at its next scheduled poll. Turning account reads off clears the displayed account data. Removing every history source clears selected history and live observations. Older dashboard configurations migrate with both settings off. No widget installation grants consent to read Codex account data.

`buildApp` registers the provider beside the Claude providers and passes callbacks for `privacy.codexAccount` and `privacy.codexHistorySources`. Constructing the provider does not start a child process or read the desktop catalog. A subscribed channel starts reading only after its corresponding opt-in. The helper must be able to find `codex` on its inherited `PATH`; the provider does not scan other installations or edit Codex configuration.

## Read-only process boundary

The adapter discovers candidate methods from the installed CLI's generated `ClientRequest.json` schema and caches the capability result briefly. Schema presence alone does not establish account access; a runtime method-not-found response marks that method unsupported for that poll.

A separate stdio app-server child runs for each account or history poll and closes when the poll ends. It does not attach to the desktop daemon, its control socket or a proxy. Only these methods are permitted:

| Method | Fixed request constraints |
|---|---|
| `account/read` | `refreshToken: false` |
| `account/rateLimits/read` | `supportsLunaReserve: false`, `excludeResetCreditDetails: true` |
| `account/usage/read` | Empty parameters |
| `thread/list` | Explicit sources, `useStateDbOnly: true`, `archived: false`, `sortKey: updated_at`, limit 50 |

Initialization is adapter-owned. Conversation creation, resume, turns, login, logout and account-changing actions are refused before transport use. Server-initiated approval and external auth-token refresh requests are refused. Child arguments disable hooks and analytics. The child environment contains only process lookup, home, temporary-directory, locale and system-directory variables. Provider credentials and arbitrary parent variables are excluded. Stderr and protocol error text never enter snapshots or logs.

`refreshToken: false` forbids a requested refresh on `account/read`. This change does not prove that CLI startup has no incidental authentication side effects. The short-lived child avoids keeping a second app server beside the desktop app. Timeout or disconnect rejects pending reads; a stopped poll cannot publish its result.

The request constraints came from the installed CLI 0.159.2 schema. Earlier or later CLIs may change `experimentalApi`, `supportsLunaReserve` or `explicitGatewayOauth`, reject fields or lack methods. The provider reports `unsupported` or `offline` and does not retry with less restrictive requests. Durable errors back off for five minutes; only transient `offline` errors retry after 15 seconds.

## Snapshot and local chat opening

`CodexSnapshot` is exported by `server/src/providers/codex.ts`; the detailed types are in `server/src/codex/snapshot.ts`. Each account, quota, usage and history section carries data, update time, freshness and a fixed error reason. A failed refresh preserves last valid data as stale. Authentication rejection clears account data. A detected account or workspace identity change clears prior quota and usage data. No credential, workspace ID or account email is sent to a widget. `account.data` contains only authentication type and, for ChatGPT authentication, plan type. It is not a per-chat account binding.

History returns at most one page of 50 non-archived, non-ephemeral records. A cursor and `truncated` disclose an incomplete page. Rollout paths, working directories, prompt previews and turn bodies are excluded. Stored status and source do not prove live desktop activity.

A card's `codex/open` command accepts an exact thread UUID only from a loopback widget command. It requires a selected history record updated within 120 seconds and validates that ID against the desktop-owned local chat catalog before opening. The catalog check requires a local host and a non-removed record. The provider validates again immediately before using `/usr/bin/open` on `codex://threads/<id>`. It never guesses from a title, launches `codex resume` or sends a prompt. A user verified this deep link on their Mac, but it is not claimed as a stable public API. CLI terminal focus is unavailable because no process-to-terminal mapping has been demonstrated.

The local catalog validator uses one read-only SQLite query for an entire page and `PRAGMA query_only`. It currently reads `sqlite/codex-dev.db`. A missing database, changed schema, lock timeout or foreign ID fails closed. The desktop database schema is not a stable public API, so catalog changes may disable navigation while account and history reads continue.

## Observed turns and direct subagents

The `codex-live` provider polls selected history IDs every five seconds. One read-only SQLite query selects the parent records and non-archived direct children, up to 300 combined records. Journal reads are bounded to local session files and accept only regular files whose first record identifies the exact thread. Full working directories, rollout paths, prompts, reasoning and tool arguments are excluded from snapshots.

The reader examines at most 16 MiB on a cold file read and 512 KiB of new data on later reads, with at most four journal files open concurrently. It currently joins journals through `state_5.sqlite`. This versioned, undocumented schema may change in a Codex update; `codex-live` can then go quiet or report unknown observations while account and app-server history still work. It projects lifecycle state, last observed model and effort, branch, a working-directory basename, agent role and direct-child count. A missing start remains unknown. Inactivity for 90 seconds changes an unfinished observation to unknown; silence does not prove continued work. Saved desktop project names and IDs are deferred to a separate change, so the directory basename is only a label.

## Verification

From the cloned repository root:

```bash
bun run --filter server test test/codex-adapter.test.ts test/codex-provider.test.ts test/codex-local-chats.test.ts test/codex-observations.test.ts test/config-migration.test.ts --configLoader runner
bun run typecheck
bun run test
```

The tests use injected transports, clocks and disposable local databases. They do not authenticate a real account, prove that Codex startup never refreshes credentials, navigate the desktop app or verify the native dashboard. Those runtime checks remain separate.
