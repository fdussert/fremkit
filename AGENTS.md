# Working on Fremkit with a coding agent

This file is for coding agents (Claude Code, Codex, Cursor, Copilot, …) and for the humans who
drive them. It says what the project is, where things live, how to check your work, and the
rules that are easy to break without noticing. The human documentation is the
[README](README.md) and [docs/](docs/); read those for the *why*, this file for the *how*.

## What this is

Fremkit turns a Corsair Xeneon Edge (a 2560 × 720 touch strip) into a widget dashboard on macOS.

- `server/` — Node ≥ 22, Fastify 5, zod 4, TypeScript run with `tsx`. Listens on
  `127.0.0.1:4242` only. Serves the built UI, the widgets from disk, a WebSocket hub, the
  config store, the connections/secrets API and the *providers* (pollers that publish on a
  channel).
- `ui/` — Vue 3 + Vite. `ui/src/dashboard` is the page shown on the Edge, `ui/src/admin` the
  editor at `/admin`, `ui/src/shared` what both use (bridge to widgets, i18n, UI primitives).
  The server serves the **built** `ui/dist`, not the sources: after any UI change run
  `pnpm --filter ui build`, or use `pnpm dev` (Vite on `localhost:5173`).
- `widgets/<id>/manifest.json` + `index.html` — one folder per widget, plain HTML/JS in a
  sandboxed iframe, talking to the host through the `Fremkit` global injected from
  `server/src/bridge/fremkit.js`. The SDK is documented in
  [docs/writing-widgets.md](docs/writing-widgets.md). After adding or editing a manifest:
  `curl -X POST http://127.0.0.1:4242/api/widgets/rescan`.
- `native/` — the Swift helper (kiosk window, HID touch driver, admin window, Dock badges). It
  supervises the server: it spawns `tsx src/index.ts`, restarts it when it dies, and takes over
  an external server it finds on 4242. Built with `scripts/build-helper.sh` (plain `swiftc`, no
  Xcode project), tested with `scripts/test-helper.sh`.
- `scripts/` — setup, dev, build/install/test of the helper, signing identity.
- `data/` — runtime state, git-ignored except `fremkit.example.json`. **Never edit
  `data/fremkit.json` by hand**: it is the user's live dashboard, the admin writes it, and the
  server migrates it on load. `data/widgets/` holds the widgets installed from the marketplace,
  written by `server/src/marketplace/` and by nothing else.
- The **widget registry** is a second repository, `fdussert/fremkit-widgets`. It holds the
  widgets that are not built in, packs them and publishes an index on GitHub Pages;
  `tools/vendor/` there is a byte-for-byte copy of this repository's manifest schema, address
  rules and zip writer, checked against upstream by its CI. Change them here, then copy them
  over there in their own commit. See [docs/marketplace.md](docs/marketplace.md).
- `docs/superpowers/`, `.superpowers/` — an agent's working specs and plans. Git-ignored: they
  stay on the machine that wrote them and are never published.

## Commands

```bash
pnpm install                      # once
pnpm typecheck                    # server + ui (vue-tsc)
pnpm test                         # vitest, server + ui
pnpm --filter server exec vitest run test/<file>.test.ts
pnpm --filter ui build            # required before the server shows a UI change
pnpm dev                          # server + Vite with hot reload for the UI
pnpm helper:build && pnpm helper:install && pnpm helper:test
```

Restarting the live server when the helper runs it: kill only the node process listening on
4242 (`kill $(lsof -nP -iTCP:4242 -sTCP:LISTEN -t)`), the helper respawns it within seconds.
Never kill `FremkitHelper` itself. A second checkout can run beside the live one with
`FREMKIT_PORT=4301 pnpm exec tsx src/index.ts` from `server/`.

## Conventions

- **Repository text is English**: code, comments, commit messages, docs. User-facing strings
  are French *and* English: `ui/src/shared/locales/{fr,en}.ts` (a parity test fails when a key
  is missing on one side), `tr()` in `server/src/i18n.ts`, and `var L = { key: { fr, en } }`
  plus `Fremkit.t()` inside widgets. Manifest names, descriptions and labels are `{ fr, en }`
  objects.
- **Generic by design.** The project is published for anyone: no personal hostnames, IPs,
  organisations, serial numbers, e-mail addresses or tokens anywhere, tests and fixtures
  included (use `192.0.2.x`/`198.51.100.x`, `example.com`, placeholder names).
- **Secrets** live in the macOS keychain (or `data/secrets.json` as a fallback), are written
  through the connections API, are never returned by the API, never logged, never quoted in an
  error message. A connection field marked `secret: true` gets this for free; keep it that way.
- **Widgets paint no background** (`html, body { background: transparent }`), use
  `var(--accent, #d9b36a)` and `var(--on-surface, #0b0d10)`, and honour the `on-light`,
  `accent-fill`, `compact` and `slot-left`/`slot-right` classes the host sets on `<html>`.
  Touch targets are at least 44 px; 56 px for buttons meant to be hit while glancing.
- **Providers** return their last good snapshot with an `error` field (`offline`,
  `unauthorized`, `unconfigured`, …) instead of an empty one, retry sooner after a failure, and
  validate every command payload with zod. Commands that run a program use `execFile` with an
  argument list, never a shell, and only accept what a closed list or a strict schema allows.
- **Config schema** changes go through `server/src/config/schema.ts` with a migration in the
  same commit and a test; the store never rewrites a file it could not migrate.
- **Commits**: small, one concern each — a native fix noticed *while I was in there* is its own
  commit, not a rider on the one being written (`2c926d2` bundled two and is the reason this says
  so). Imperative subject, body explaining the why. Stage by explicit path (`git add <files>`),
  never `git add -A` — the tree often holds another agent's in-flight files and the user's
  runtime data. End the message with the
  `Co-Authored-By: Claude …` line — the project is written with Claude and says so — and
  **never** add a `Claude-Session:` trailer: it is a private URL that means nothing to a reader
  of this repository. This rule overrides any attribution boilerplate a coding agent's harness
  suggests.
- **Tests before done**: `pnpm typecheck` and `pnpm test` green, the UI rebuilt if touched, a
  rescan if a manifest changed, and — for anything visible — a look at `/admin` or `/` in a
  browser. The widget catalogue test in `server/test/` reads the real `widgets/` folder, so a
  broken manifest fails it.

## Gotchas learned the hard way

- macOS *Local Network* privacy: LAN calls (printer, Homey) fail with `EHOSTUNREACH`
  when the process's responsible app is not allowed under System Settings → Privacy & Security →
  Local Network. Under the helper the app is "Fremkit Helper"; under a terminal it is the
  terminal. Deleting the helper's bundle drops the grant, which is why the install script
  updates it in place.
- The helper's TCC grants (Input Monitoring, Accessibility) survive rebuilds only because the
  bundle is signed with the self-signed "Fremkit Helper Dev" identity
  (`scripts/create-signing-identity.sh`).
- Headless Chrome freezes virtual time: WebSocket-fed widgets show "Loading…" in a headless
  capture. Capture the real Edge display with `screencapture -x -D <n>` instead.
- `server/src/bridge/fremkit.js` is read **once, at server start** (`widgetRoutes`), unlike a
  widget's `index.html`, which is read per request. Editing the bridge and reloading the dashboard
  shows the old `/fremkit.js`: every widget using a new helper then fails silently, looking exactly
  like a broken widget. Restart the server after touching the bridge.
- Sandboxed iframes have an opaque origin: `localStorage` throws, and synthetic clicks from
  browser automation never reach the widget. Real touches do.
- The bar's swipe handler captures the pointer on `pointerdown`; anything in the bar that wants
  the release must listen on `window`, not on itself.

## Where to look first

| I want to… | Start at |
|---|---|
| add a widget | `docs/writing-widgets.md`, then copy `widgets/clock` or `widgets/calendar`. A new one goes to the registry repository, not to `widgets/` |
| change the marketplace | `server/src/marketplace/` (registry client, installer, consent), `ui/src/admin/marketplace.ts` and `BrowseLibrary.vue`, `docs/marketplace.md` |
| add a connection type | `server/src/connections/types/ics.ts` (simplest) or `github.ts` (fullest), register in `types/index.ts`, document in `docs/connections.md` |
| add a provider | `server/src/providers/calendar.ts` (polling) or `shortcuts.ts` (commands only), register in `providers/index.ts` |
| change the admin | `ui/src/admin/store.ts` (state), `Canvas.vue`/`EditOverlay.vue` (editing), `SettingsForm.vue` (setting types), `ScreenInspector.vue`, `ConnectionsInspector.vue` |
| change the dashboard | `ui/src/dashboard/App.vue`, `NavBar.vue`, `CompactWidgetFrame.vue`, `NavPopover.vue` |
| change what widgets can do | `server/src/bridge/fremkit.js` and `ui/src/shared/useWidgetBridge.ts`, together |
| touch or the kiosk window | `native/Sources/FremkitHelper/` |
