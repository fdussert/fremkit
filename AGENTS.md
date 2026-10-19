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
  `curl -X POST -H @<(printf "Authorization: Bearer %s" "$(cat ~/Library/Application\ Support/Fremkit/access-4242.token)") http://127.0.0.1:4242/api/widgets/rescan`
  (the server answers only holders of its access secret; see below).
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
- `companion/` — the Fremkit Companion browser extension (MV3, Chromium only, loaded unpacked from
  here), which pairs with the server and sends a tab's video to `widgets/fremplay` over WebRTC.
  Its ID is fixed by the manifest `key`. Server side: `server/src/companion/`; the routes that
  skip the access secret are listed in `server/src/http/access.ts` (`COMPANION_ROUTES`). See
  [docs/companion.md](docs/companion.md).
- `ios/` — the iPad app, which shows a paired device's screen over the pinned TLS listener
  (4243). `ios/FremkitKit` is a Swift package holding everything that needs no UI — pairing
  links, the key pin, the connect order, the stored pairing, the app's state machine
  (`AppModel`) — and is tested on the Mac with `swift test`. `ios/Fremkit.xcodeproj` (one target,
  folder-synchronized with `ios/Fremkit/`) is the thin SwiftUI + `WKWebView` shell over it. Signing
  values live in the git-ignored `ios/Local.xcconfig` (start from `ios/Local.example.xcconfig`);
  the simulator build needs none. Built and tested with `scripts/build-ios.sh`, which picks Xcode
  over the Command Line Tools by itself.
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
pnpm install                      # once
pnpm typecheck                    # server + ui (vue-tsc)
pnpm test                         # vitest, server + ui
pnpm --filter server exec vitest run test/<file>.test.ts
pnpm --filter ui build            # required before the server shows a UI change
pnpm e2e                          # Playwright on the built UI, one throwaway server per worker (4330–4339;
                                  # E2E_FIRST_PORT=43x0 moves it when another checkout is running the suite)
pnpm dev                          # server + Vite with hot reload for the UI
pnpm helper:build && pnpm helper:install && pnpm helper:test
pnpm ios:build && pnpm ios:test   # iPad app for the simulator, signed ad hoc; FremkitKit's tests
pbpaste | FREMKIT_IOS_DEVICE=<udid> scripts/build-ios.sh install --seed   # a pairing link from stdin, never argv
scripts/build-ios.sh upload       # Release archive to App Store Connect / TestFlight (docs/releasing.md)
```

**Every request needs the local access secret** (SECURITY.md): a `curl` without
`Authorization: Bearer $(cat ~/Library/Application\ Support/Fremkit/access-<port>.token)` gets 401,
and a browser needs a one-time link — `pnpm open [/admin]`, `pnpm open --dev` under `pnpm dev`, or
`FREMKIT_URL=http://127.0.0.1:4301 pnpm open --print` for a second checkout. Pass the header
through `-H @<(printf …)` rather than on the command line, as the scripts do. Only `/auth`,
`/fremkit.js` and `/widgets/<id>/…` answer without it (`server/src/http/access.ts`); a new route
is behind it with nothing to do. Restarting the live server when the helper runs it: kill only the node process listening on
4242 (`kill $(lsof -nP -iTCP:4242 -sTCP:LISTEN -t)`), the helper respawns it within seconds.
Never kill `FremkitHelper` itself. A second checkout can run beside the live one with
`FREMKIT_PORT=4301 pnpm exec tsx src/index.ts` from `server/`.

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
- **A new route is local-only.** The remote listener (port 4243, paired devices) answers 404 to
  anything not in `server/src/devices/allowlist.ts`, and `server/test/devices-gate.test.ts` walks
  every route to keep it so. Judge locality with `isLocalRequest(req)` (`server/src/net/remote.ts`),
  never `isLoopbackAddress(req.ip)` alone: a request to 4243 from the Mac itself has a loopback
  address.
- **Demo mode** (`FREMKIT_DEMO=1`, `server/src/demo/`, docs/demo-mode.md) must never construct a
  real provider: a new provider is registered in `registerRealProviders()` in `app.ts`, and a
  channel a built-in widget reads needs a fake in `demo/providers.ts` too (`demo.test.ts` fails
  otherwise). A new built-in widget also gets `DEMO_SETTINGS` if its defaults show an empty state,
  and a preview from `pnpm widget:preview <id>`. A registry widget's channel or declared connection is acted
  out too (`demo/providers.ts`, `demo/declared.ts` for the LAN devices a declared connection
  reaches), so `pnpm widget:preview --dir` captures data rather than an empty state; a declared
  connection's Test and proxy share that fake and must never get the global `fetch` in a demo.
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
  `ui/src/shared/credits.ts`, which the admin's **Settings → About** reads, and to the README's
  Credits section; `credits.test.ts` fails when the two disagree. A registry widget or theme
  credits its own authors in its `author` field, which the registry refuses to leave empty.
- **Tests before done**: `pnpm typecheck` and `pnpm test` green, the UI rebuilt if touched,
  `pnpm e2e` green when the admin or the dashboard changed (CI runs it in Chromium), a
  rescan if a manifest changed, and — for anything visible — a look at `/admin` or `/` in a
  browser. The widget catalogue test in `server/test/` reads the real `widgets/` folder, so a
  broken manifest fails it. "A look" means you open the screenshot and read it: a capture taken
  and never looked at verifies nothing. Headless Chromium works for the admin (see the Gotchas
  for what it cannot show).
- **Several agents at once**: branches written in parallel each pass on their own and still
  break together — a union gains a member (`WidgetSource` got `dev`) while another branch adds an
  exhaustive `Record` over it. After merging anything into `main`, run `pnpm typecheck` and
  `pnpm test` on the merge result before calling it done, and fix the seam in its own commit.
- **Security review findings are fixed, not filed.** The last full review is the reason for the
  rules under *Security invariants*; a new feature that touches one of them says so in its commit
  body and adds the test that proves the invariant still holds.

## Security invariants

Each line here was a real hole once. Break one only with the owner's explicit say-so.

- **Diagnostics never carry identity.** Anything added to `GET /api/diagnostics` or the helper's
  *Copy diagnostics* goes through `redact()` (`server/src/diagnostics/redact.ts`) and names
  *kinds*, never instances: connection types, not connection names; widget ids, not titles;
  counts, not device names. A new kind of value that could identify someone (a host, an account,
  a path) gets a redaction rule and a test with documentation-range fixtures.
- **A shared layout is built, never sliced.** `server/src/share/export.ts` writes a
  `.fremkit-layout.json` from an allow-list of keys (`format.ts`), so a config key added later
  stays home by default; adding one to the file is a decision, with a test in `share.test.ts`.
  Settings travel by their manifest type (`share/settings.ts`): connection-typed ones never, free
  text only when ticked; every name, title and value goes through `redact()`, and the finished file
  is checked again. On import the file is a stranger's: re-check settings against local manifests
  and never keep a value naming one of the user's connection ids.
- **The author's widget folder is a development tool.** `<dataDir>/widgets-dev` is read only
  under `FREMKIT_WIDGET_DEV=1`, its widgets skip the consent dialog, and nothing shipped sets the
  flag. Never read it, or watch files, without that flag, and never let it shadow a built-in or
  an installed id.
- **Editor-only channels live under `config:`.** `config:health` (`server/src/providers/health.ts`)
  is kept from widgets by the manifest schema's reserved `config` family and from paired devices
  because `HOST_CHANNELS` names only the literal `config`. A new channel for the editor's eyes goes
  there too, and `HOST_CHANNELS` never grows a `config:*` entry.
- **A host channel reaches a paired device only through `deviceHostView`** (`devices/service.ts`),
  for `broadcast` and `notify` alike: a new `HOST_CHANNELS` entry gets a case there narrowing it to
  the device's own screen (no case = never sent), and a hub test with a device on another screen.
- **Every editor action goes through the admin store's `apply()`**, menus and shortcuts
  included, so it is undoable and saved. The canvas selection is `state.selection` (a list);
  `state.selectedId` is an accessor over it that reads null while several tiles are selected, so a
  command meant for "what is selected" reads `selection`/`selectedTiles`, and a group command is
  one `apply()`, never one per tile. Context menus are data built for
  `ui/src/shared/ui/contextMenu.ts`; do not write a second menu component.


- **The browser cookie holds a session id, never the access secret.** `/auth` opens a session
  (`AccessGate.openSession`, in memory, expiring, revocable); a session cannot mint a code
  (`POST /api/auth/code` takes the bearer only) and is never accepted as a bearer. Browsers send a
  host's cookies to every port, so whatever the cookie carries, assume another loopback listener
  reads it. The helper's web views sign in with a one-time link like a browser does.
- **Nothing presents the secret to a listener that has not proved it is ours.** The helper asks
  `GET /auth/proof?nonce=` (HMAC of the nonce under the secret, `AccessProof.swift` /
  `accessProof()`) before sending the bearer or loading a page from the port, and a listener that
  cannot answer is the `foreign` state, never "external". New native code that talks to the port
  goes through `ServerAccess.authorize`/`signInURL`, which refuse until a probe said `.ours`.
  Each spawned server gets a fresh secret; the token file is written after `listen` and removed
  on exit.
- **The companion takes a token only after the user typed the Edge's code and the server proved it
  knows it.** The code goes to the Edge and the admin, never to the extension; the extension's mac
  under K(code) comes first (three wrong ones kill the request), and the token is kept only with a
  server mac that checks and came back within 2 s (`server/src/companion/pairProof.ts`,
  `companion/lib/pairProof.js`, one test vector). No approve route, no
  path that hands out a token without that exchange.
- **No secret on a command line, ever.** Any account on the Mac reads every process's argv with
  `ps`. The keychain is written through `security -i` on stdin and read with `-g`
  (`secrets/keychain.ts`); ffmpeg gets the Bambu URL from a 0600 list file and gets no preview
  rather than argv. Before adding an `execFile`/`spawn` that carries a credential, check what
  `ps -axww` would show while it runs.
- **Keychain items are filed per data folder** (`instanceService`). Only the 4242 instance may
  adopt items under the legacy `fremkit` service; nothing else reads or deletes them.
- **Outbound fetches to a host a widget or a page named go through `publicFetch`**
  (`net/pinned.ts`), whose connect-time lookup refuses private addresses, so the address checked
  is the address connected to. A plain `fetch` after `resolvesToPrivate` is a DNS-rebinding hole.
  Declared connections reach the LAN on purpose and are the one exception.
- **The data folder is 0700 and its files 0600.** The server runs with umask 077 and
  `tightenDataDir` fixes older files at start; write new runtime files with `mode: 0o600` anyway.
- **A restore and `PUT /api/config` never import security settings.** A restore keeps this
  Mac's `secrets`, `privacy` and `marketplace.installed`; PUT replays `connections`, `secrets`
  and `marketplace.installed` (privacy stays editable there: it is the admin's switch). Consent
  records change only through the marketplace routes.
- **Anything that replaces the whole config goes through `applyConfig`** (`server/src/backup/apply.ts`):
  backup restore, history restore, and any import. It keeps the security settings above, drops a
  secret whose connection comes back changed, and passes a `reason` to `store.save` so the history
  (`config/history.ts`) keeps the version it replaced. `<dataDir>/history/` holds full configs: it
  stays out of backups and diagnostics, and its routes stay off the 4243 allow-list.
- **Deleting a connection deletes every secret stored under its id**, registered type or not
  (`SecretStore.keysOf`), and a new connection purges its id first: never adopt a stale secret.
- **System tools by absolute path** (`/usr/bin/open`, `/usr/bin/osascript`, `/usr/sbin/scutil`…),
  and `PATH` with `/usr/bin:/bin:/usr/sbin:/sbin` first (`system-path.ts`, `ServerLaunch`).
  A bare name resolves through Homebrew's folder, which is not ours to trust.
- **The admin window and the kiosk pin their main frame to their own origin**
  (`AdminOrigin`, `KioskOrigin`), and an origin is trusted for writes only on this server's own
  port (`allowedOrigins`). The iPad's web view does the same (`Dashboard.allowsMainFrame`) and
  hears the page's messages only from that origin (`Dashboard.isPageOrigin`).
- **A typed pairing code travels as a proof bound to the Mac's key** (`codeProof.ts`,
  `CodeProof.swift`), never as itself: the four words are 32 bits and can be ground, the proof
  cannot be relayed to another key. `/api/pair` takes `proof` or the QR's `secret`, nothing else.
- **Commands that act on the Mac take their target from a closed list**: `dock.activate` only
  for an app in the current Dock snapshot; a URL handed to `open` is the parsed `href` that was
  checked, never the raw string.


- **No WebRTC in a widget.** `server/src/bridge/fremkit.js` starts by making the WebRTC
  constructors `undefined` and unrecoverable, and the server injects it ahead of everything the
  widget wrote (`injectBridge`: after the doctype, never "after `<head>`"). The only exception is
  the `local` level — no ICE server, loopback/this-Mac candidates only — for **built-ins** listed
  in `WEBRTC_LOCAL_BUILTINS` (`server/src/widgets/webrtc.ts`). Never let a manifest, a consent
  record or an installed folder reach that list; never serve a widget document that runs script
  without the bridge (other HTML/SVG/XML files get `script-src 'none'`).
- **Host pages carry a CSP.** `hostCsp()` in `server/src/http/headers.ts` covers every HTML page
  the server writes (loopback and the 4243 listener, built per request from the checked Host);
  `ui/vite.config.ts` sends the same under `pnpm dev`. `frame-src` stays `<origin>/widgets/`,
  `frame-ancestors 'none'`, `script-src 'self'` with no `unsafe-inline`. A new page, frame or
  external resource changes that function, not a route.
- **Frames hold widgets only.** The kiosk and admin web views cancel any subframe navigation that
  `WidgetFrames.allows` (`native/Sources/FremkitCore/WidgetFrames.swift`) refuses; a new web view
  that shows widgets uses it too.
- **A settings `preview` is a granted command.** The manifest schema requires its channel in
  `commands`, `grantedManifest` drops one its granted commands do not cover, and `SettingsForm`
  sends one only on a channel `commands` covers. Never add preview channels to anything on their own.
- **The host talks to a frame over its port, never its window.** `useWidgetBridge` answers only
  the document that said hello, over the `MessagePort` it handed it, after the nonce came back;
  nothing but that `fremkit:connect` is posted to a frame's window. A second hello for the same
  src disowns the frame.
- **Check it in browsers.** After touching the bridge, the widget or host CSP, the frames or
  `useWidgetBridge`, run `scripts/check-widget-sandbox.ts` (Chromium and WebKit through
  Playwright; not part of `pnpm test`, which has no browser) — see its header for the command.

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
- Never `import … from 'undici'` at module level. Loaded as CommonJS before the first `fetch`,
  the package takes the process-wide dispatcher slot Node's built-in `fetch` reads too, and Node
  26's `fetch` then hands back HTTP/2 gzip bodies undecoded — every provider's `res.json()`
  fails at once (`invalid-json`, `offline`) while every unit test, which injects `fetch`, stays
  green. Go through `loadUndici()` in `server/src/net/pinned.ts`; `net-pinned.test.ts` replays
  the server's load order in a fresh process.
- WebKit sends a right click into an iframe under the pointer even when the frame has
  `pointer-events: none`: a context menu the host page must hear over a widget frame needs an
  element covering the frame (`CompactWidgetFrame`'s `.shield` in the editor). Chromium hides it.
- `playwright install` deletes every browser build in `~/Library/Caches/ms-playwright` that no
  installed Playwright version links to — including one another tool or agent launches by path.
  Install for the e2e package only when needed, and say so if you did.
- A layer drawn above a `BaseModal` (a context menu, the command palette) carries `data-overlay`:
  the dialog and the layer both hear Escape on the window, and without it one Escape closes both.

## Where to look first

| I want to… | Start at |
|---|---|
| add a widget | `docs/writing-widgets.md`, then `pnpm widget:new <id>` (writes to the author's folder, `data/widgets-dev`, read and live-reloaded under `FREMKIT_WIDGET_DEV=1`) and `pnpm widget:check <folder>`; `widgets/clock` and `widgets/calendar` are the examples to read. A new one goes to the registry repository, not to `widgets/` — see the rule above for the one case that does not |
| add a theme | `docs/themes.md`, then copy `themes/edge/theme.json`. A new one goes to the registry too: `fremkit` and `edge` are here so a fresh install has a choice with no network, and that is the whole reason either of them is |
| change the marketplace | `server/src/marketplace/` (registry client, installer, consent), `ui/src/admin/marketplace.ts` and `MarketplacePanel.vue`, `docs/marketplace.md` |
| add a connection type | **A coded type is the exception, and has to earn it.** One auth header on HTTP(S) is a `connection` the widget *declares* in its own manifest — no release of Fremkit per service; see `docs/writing-widgets.md`. Write code only for what a declaration cannot express: a session handshake, a protocol that is not HTTP, OAuth, a local binary. Nothing else counts — "it already has a provider" does not, and neither does "a picker would be nice" (a declared connection feeds no `pick`; the widget lists ids instead). Homey was coded and should not have been: two widgets on one Homey meant two connections, and a Homey invalidates the previous API key when a new one is issued, so the second key broke the first. If it does earn it: `server/src/connections/types/ics.ts` (simplest) or `github.ts` (fullest), register in `types/index.ts`, document in `docs/connections.md` |
| add a provider | `server/src/providers/calendar.ts` (polling) or `shortcuts.ts` (commands only), register in `providers/index.ts` |
| change the companion extension or Fremplay | `companion/`, `server/src/companion/`, `widgets/fremplay`, `docs/companion.md` |
| change the admin | `ui/src/admin/store.ts` (state), `Canvas.vue`/`EditOverlay.vue` (editing), `SettingsForm.vue` (setting types), `ConnectionsInspector.vue`; right-click menus in `ui/src/shared/ui/contextMenu.ts` + `ContextMenu.vue` and the menu builders beside the component that opens them |
| change the settings window (a screen's settings, the app's) | `ui/src/admin/settings/SettingsWindow.vue` (sidebar, search), one `*Pane.vue` per pane beside it, `ui/src/admin/settingsWindow.ts` (the panes, the section → pane routing `revealSection` relies on, and the search index: a new field's label goes into `SETTINGS_INDEX` or the search will not find it). A long panel with a fixed header and expand/collapse all is `shared/ui/ScrollPanel.vue` |
| add an editor command or shortcut | A command goes into the menu builder it belongs to (`canvasMenu.ts`, `menus.ts`): the ⌘K palette reads those menus (`paletteCommands.ts`), so it appears there too; only what no menu holds is written in `paletteCommands.ts`. A key goes into `ui/src/admin/shortcuts.ts`, which the key handler in `App.vue`, the `?` sheet and the menus' hints all read |
| add an end-to-end test | `e2e/fixtures/test.ts` (`seed`, `connections`, `signIn`, `openAdmin`, `savedConfig`), a spec in `e2e/tests/` to copy, and [docs/contributing.md](docs/contributing.md#end-to-end-tests). Roles and visible text first; a `data-test` attribute only where neither exists, in its own commit |
| change the dashboard | `ui/src/dashboard/App.vue`, `NavBar.vue`, `CompactWidgetFrame.vue`, `NavPopover.vue` |
| change what widgets can do | `server/src/bridge/fremkit.js` and `ui/src/shared/useWidgetBridge.ts`, together |
| touch or the kiosk window | `native/Sources/FremkitHelper/` |
| the app, its signing, notarization or updates | `scripts/build-app.sh`, `scripts/release.sh`, `native/Sources/FremkitCore/ServerLaunch.swift` (checkout or bundled server), `server/src/paths.ts` (the bundle's layout), `docs/releasing.md` |
| change the disk map | `server/src/providers/disk-map*.ts`, `native/Sources/FremkitCore/Disk*.swift`, `native/Sources/FremkitScan`, `widgets/disk-map` |
| bug reports, diagnostics | `server/src/diagnostics/` (report, `redact.ts`, log tail), `ui/src/admin/DiagnosticsSection.vue`, the helper's `StatusMenu.swift` |
| change what the editor says about a failing widget | `ui/src/admin/health.ts` (pure, tested), `useHealth.ts` (stores, socket, the fixes), `server/src/providers/health.ts` (the `config:health` channel) |
| pair a device, the remote listener | `server/src/devices/`, `ui/src/admin/DevicesSection.vue` |
| change the iPad app | `ios/FremkitKit/Sources/FremkitKit/` (logic, `AppModel.swift` for the screens' state, `PairingFlow.swift` for pairing; test there), `ios/Fremkit/` (`RootView.swift`, `DashboardView.swift` for the web view, `LocalNetwork.swift` for Bonjour), `ui/src/dashboard/native.ts` (what the page tells the app), `scripts/build-ios.sh` |
| demo mode, widget previews | `server/src/demo/` (fakes, seed), `server/src/cli/preview.ts`, `previewProblems` in `server/src/widgets/manifest.ts` (vendored by the Sietch), `ui/src/admin/WidgetPreviewPopover.vue` |
| export or import a layout | `server/src/share/` (file format, export, import), `ui/src/admin/share.ts`, `shareApply.ts`, `Share*Dialog.vue`, `docs/sharing.md` |
