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
  `bun run --filter ui build`, or use `bun run dev` (Vite on `localhost:5173`).
- `widgets/<id>/manifest.json` + `index.html` — one folder per widget, plain HTML/JS in a
  sandboxed iframe, talking to the host through the `Fremkit` global injected from
  `server/src/bridge/fremkit.js`. The SDK is documented in
  [docs/writing-widgets.md](docs/writing-widgets.md). After adding or editing a manifest:
  `curl -X POST http://127.0.0.1:4242/api/widgets/rescan`.
  **What belongs here and what does not:** the core ships what works on any Mac with no account,
  no hardware and no third-party application. Everything else is published on the registry. A
  *provider* or a *connection type* is not the widget and stays here whatever the widget does:
  a widget is HTML in a sandbox, a provider holds credentials, and that line is the security
  line rather than a packaging one. Which is why `bambu`, `homey`, `github`, `azure-devops`,
  `synology`, `mutedeck` and `cleanshot` are in `server/src/` while their widgets are not.
- `native/` — the Swift helper (kiosk window, HID touch driver, admin window, Dock badges). It
  supervises the server: it spawns `tsx src/index.ts`, restarts it when it dies, and takes over
  an external server it finds on 4242. Built with `scripts/build-helper.sh` (plain `swiftc`, no
  Xcode project), tested with `scripts/test-helper.sh`. The bundle also carries `fremkit-scan`
  (`native/Sources/FremkitScan`), the disk map's scanner, which the server runs by the path the
  helper passes in `FREMKIT_SCANNER`; without it the server falls back to `du`.
- `scripts/` — setup, dev, build/install/test of the helper, signing identity, and the
  downloadable app: `build-app.sh` (self-contained, signed `Fremkit.app` with Sparkle and the
  server as a Node single executable), `notarize.sh`, `release.sh` (builds a release and stops
  before publishing). See [docs/releasing.md](docs/releasing.md). Never install a built
  `Fremkit.app` on the owner's machine: it shares the bundle id of the live helper.
- `themes/<id>/theme.json` — a palette, fonts and text size as validated tokens, painted on the
  dashboard, the editor and inside every widget. Two ship; the rest are published on the registry
  and installed into `<dataDir>/themes`, exactly like a widget. See [docs/themes.md](docs/themes.md).
- `data/` — runtime state, git-ignored except `fremkit.example.json`. **Never edit
  `data/fremkit.json` by hand**: it is the user's live dashboard, the admin writes it, and the
  server migrates it on load. `data/widgets/` holds the widgets installed from the marketplace,
  written by `server/src/marketplace/` and by nothing else.
- The **widget registry** is a second repository, `fdussert/fremkit-sietch`. It holds the
  widgets that are not built in, packs them and publishes an index on GitHub Pages;
  `tools/vendor/` there is a byte-for-byte copy of this repository's manifest schema, address
  rules and zip writer, checked against upstream by its CI. Change them here, then copy them
  over there in their own commit. See [docs/marketplace.md](docs/marketplace.md).
- `docs/superpowers/`, `.superpowers/` — an agent's working specs and plans. Git-ignored: they
  stay on the machine that wrote them and are never published.

## Commands

```bash
bun install                       # once
bun run typecheck                 # server + ui (vue-tsc)
bun run lint                      # oxlint, whole repo
bun run test                      # vp test, server + ui
bun run --filter server test test/<file>.test.ts
bun run --filter ui build         # required before the server shows a UI change
bun run dev                       # server + Vite+ with hot reload for the UI
bun run helper:build && bun run helper:install && bun run helper:test
```

`bun run dev` runs `vp dev` for the UI; `vp test` runs both suites (Vitest 5 under Vite+, not the
`vitest` binary directly), and `vite` and `vitest` are no longer dependencies of their own. The
`vite` entry in `ui/package.json` is an alias to `@voidzero-dev/vite-plus-core`, Vite+'s own Vite,
and it has to stay one: with a second copy of real Vite on disk — which is what `@vitejs/plugin-vue`
pulls in for its peer — TypeScript crashes on `plugins: [vue()]` inside `defineConfig` with
`Debug Failure. False expression: parameter should have errors when reporting errors`. `vp build`
also refuses to run until the alias is aligned.

`server/` is on TypeScript 7, the native compiler; `ui/` is still on 5.9, and that is not an
oversight. `vue-tsc` loads the TypeScript compiler's own JavaScript API (`typescript/lib/tsc`) and
patches it, and TypeScript 7 ships a native binary with no such entry point, so it dies with
`ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './lib/tsc' is not defined by "exports"`. Plain
`tsc` is no substitute: it skips every `.vue` file, templates, props and emits included. The UI
moves to 7 when `vue-tsc` runs on the native compiler.

Restarting the live server when the helper runs it: kill only the node process listening on
4242 (`kill $(lsof -nP -iTCP:4242 -sTCP:LISTEN -t)`), the helper respawns it within seconds.
Never kill `FremkitHelper` itself. A second checkout can run beside the live one with
`FREMKIT_PORT=4301 bun run start` from `server/`.

**An agent asked for a feature or a review works in a worktree and leaves the current tree
alone.** Add one — `git worktree add ../fremkit-<topic> -b <branch>`, or, to review a pull
request, `git fetch origin pull/<n>/head:pr-<n>` and a worktree on that — so the checkout the
work was asked from keeps its branch, its uncommitted files and its untracked ones. Several
agents often run at once, and the main checkout is the one the helper builds from and the Edge
shows: a `git checkout` in it moves the live dashboard under the user and can strand another
agent's in-flight work. Say where the worktree is, and remove it once the work has landed.

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
  An account provider never publishes the account's e-mail unless `privacy.showAccountEmail` is
  on: build the snapshot with `withAccountEmail()` from `server/src/privacy.ts`, pass every
  snapshot it returns — the error path's `{ ...last, error }` included — through
  `gateAccountEmail()`, applied to the object that carries `email` when it is nested, and set `publishesAccountEmail: true` (see `docs/connections.md`).
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
- **Changelog**: anything that changes what the dashboard, the admin or a widget can do gets a
  line under `## Unreleased` in `CHANGELOG.md`, in the same commit, written for the person
  using Fremkit (not the commit subject). A release is its own commit: rename the section,
  bump the four `version` fields (`package.json`, `server/`, `ui/`, `server/src/version.ts`) and
  the `data-fremkit-version` spans of `site/index.html`,
  and tag `vX.Y.Z`. A widget's `sdk` is compared against `SDK_VERSION` in
  `server/src/bridge/sdk.ts`, not against the release: it goes up when the bridge gains a member
  a widget may rely on, in the commit that adds it (`bridge.test.ts` refuses a member no
  generation lists).
- **Credits**: somebody's first merged pull request adds their handle to
  `ui/src/shared/credits.ts`, which the admin's **Screen → About** reads, and to the README's
  Credits section; `credits.test.ts` fails when the two disagree. A registry widget or theme
  credits its own authors in its `author` field, which the registry refuses to leave empty.
- **Tests before done**: `bun run typecheck` and `bun run test` green, the UI rebuilt if touched, a
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
| add a widget | `docs/writing-widgets.md`, then copy `widgets/clock` or `widgets/calendar`. A new one goes to the registry repository, not to `widgets/` — see the rule above for the one case that does not |
| add a theme | `docs/themes.md`, then copy `themes/edge/theme.json`. A new one goes to the registry too: `fremkit` and `edge` are here so a fresh install has a choice with no network, and that is the whole reason either of them is |
| change the marketplace | `server/src/marketplace/` (registry client, installer, consent), `ui/src/admin/marketplace.ts` and `MarketplacePanel.vue`, `docs/marketplace.md` |
| add a connection type | **A coded type is the exception, and has to earn it.** One auth header on HTTP(S) is a `connection` the widget *declares* in its own manifest — no release of Fremkit per service; see `docs/writing-widgets.md`. Write code only for what a declaration cannot express: a session handshake, a protocol that is not HTTP, OAuth, a local binary. Nothing else counts — "it already has a provider" does not, and neither does "a picker would be nice" (a declared connection feeds no `pick`; the widget lists ids instead). Homey was coded and should not have been: two widgets on one Homey meant two connections, and a Homey invalidates the previous API key when a new one is issued, so the second key broke the first. If it does earn it: `server/src/connections/types/ics.ts` (simplest) or `github.ts` (fullest), register in `types/index.ts`, document in `docs/connections.md` |
| add a provider | `server/src/providers/calendar.ts` (polling) or `shortcuts.ts` (commands only), register in `providers/index.ts` |
| change the admin | `ui/src/admin/store.ts` (state), `Canvas.vue`/`EditOverlay.vue` (editing), `SettingsForm.vue` (setting types), `ScreenInspector.vue`, `ConnectionsInspector.vue` |
| change the dashboard | `ui/src/dashboard/App.vue`, `NavBar.vue`, `CompactWidgetFrame.vue`, `NavPopover.vue` |
| change what widgets can do | `server/src/bridge/fremkit.js` and `ui/src/shared/useWidgetBridge.ts`, together |
| touch or the kiosk window | `native/Sources/FremkitHelper/` |
| the app, its signing, notarization or updates | `scripts/build-app.sh`, `scripts/release.sh`, `native/Sources/FremkitCore/ServerLaunch.swift` (checkout or bundled server), `server/src/paths.ts` (the bundle's layout), `docs/releasing.md` |
| change the disk map | `server/src/providers/disk-map*.ts`, `native/Sources/FremkitCore/Disk*.swift`, `native/Sources/FremkitScan`, `widgets/disk-map` |
