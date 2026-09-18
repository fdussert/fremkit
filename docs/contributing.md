# Contributing

Notes for people working on Fremkit itself. For writing a widget — which needs none of this — see
[writing-widgets.md](writing-widgets.md).

## Language

The repository is in English: code, comments, commit messages, documentation. The interface
itself is French *and* English; every user-facing
string goes through `ui/src/shared/locales/`, and every manifest text is either one string or a
`{ fr, en }` pair.

## Layout

```
server/    Fastify 5 server on 127.0.0.1:4242 — config, widget catalog, providers, connections,
           the secret store, the widget bridge and the WebSocket
ui/        Vue 3: the dashboard (src/dashboard), the admin (src/admin), shared code (src/shared)
native/    The Swift helper: kiosk window, HID touch driver, mouse fence, admin window,
           Dock badges, server supervision
widgets/   One folder per widget
scripts/   setup, dev, build/install/test the helper, signing identity, kiosk, Claude Code hooks
data/      Your configuration and its assets. Git-ignored, never edited by hand while the
           server runs
brand/     Icon, menu bar glyph, favicons, social image
docs/      This documentation
```

## Scripts

```sh
pnpm dev          # server on 4242 + Vite on 5173 (dashboard http://localhost:5173, admin /admin)
pnpm build        # ui + server
pnpm start        # production: http://127.0.0.1:4242 and /admin
pnpm test         # vitest, server + ui
pnpm typecheck
pnpm helper:build   # native/dist/Fremkit Helper.app
pnpm helper:install
pnpm helper:test
```

`pnpm dev` exports `FREMKIT_DEV=1`, which is what puts the Vite origin
(`http://localhost:5173`, `http://127.0.0.1:5173`) on the list of origins the server accepts a
WebSocket and a write from. Without it only `http://127.0.0.1:4242` and `http://localhost:4242`
are trusted, plus the port `FREMKIT_PORT` moved a second checkout to. A production instance must
not trust 5173: it is Vite's default port, so any unrelated project serving on it would be
trusted to save this dashboard's config. Running Vite by hand (`pnpm --filter ui dev`) against a
server started without the flag gives a dashboard whose WebSocket is refused — export
`FREMKIT_DEV=1` for the server too.

## Running against another data directory

`FREMKIT_DATA_DIR` moves the config, the background library and the caches somewhere else. It
must be an absolute path, and it is created on demand:

```sh
FREMKIT_DATA_DIR=/tmp/fremkit-fresh pnpm start
```

That is a from-scratch install on the live checkout: the dashboard, the connections and the
backgrounds all come out of that folder, so you get the default config and the shipped wallpaper
without moving anything aside. The keychain is keyed by connection id, so a fresh config never
names the real items and your own secrets are untouched — nothing is read and nothing is
overwritten. Stop the helper's server first if you want the same port, or pair it with
`FREMKIT_PORT`.

The other way round is to move `data/` aside while the helper's server is stopped, which is the
same thing done by hand.

## Upgrading an existing install

Pulling this release **requires restarting the server**. Every widget now depends on
`Fremkit.esc()`, `Fremkit.el()` and `Fremkit.color()`, which live in
`server/src/bridge/fremkit.js` — and that file is read **once, at server start**, unlike a
widget's `index.html`, which is read per request. A dashboard reloaded against a server that
started before the pull gets the old bridge, and every widget using one of those helpers fails
silently, looking exactly like a broken widget.

Under the helper: `kill $(lsof -nP -iTCP:4242 -sTCP:LISTEN -t)` and it respawns within seconds.

## Backup and restore

**/admin → Screen → Backup.** "Back up" downloads `fremkit-backup-<date>.zip`; "Restore…" takes
one back.

What is in the archive:

| Entry | What it is |
|---|---|
| `fremkit.json` | the live config, as the store has migrated it |
| `backgrounds/*` | the whole background library, the shipped wallpaper included |
| `manifest.json` | the Fremkit version, the date, the config version, and `secrets: "excluded"` |

**No secrets, ever.** They live in the macOS keychain (or `data/secrets.json` under the file
backend), keyed by connection id, and the point of keeping them there is that a file copied to a
USB stick does not carry them. A restore therefore brings each connection back with its host, its
organisation and its repository list, and nothing to authenticate with.

With one useful exception: because secrets are keyed by connection *id* and a restore keeps those
ids, restoring onto the **same Mac** finds the keychain items that are already there and
everything works straight away. The answer lists only the connections whose secret is genuinely
absent — on another Mac, or with the file backend and a fresh `data/`, that is all of them.

A restore replaces the dashboard: pages, widgets, connections and backgrounds. The store keeps
its usual `.bak` of the config it overwrote, and it refuses to write at all while the file on disk
cannot be read. A v1 archive is migrated on the way in.

Copying `data/` by hand is the same thing without the zip. 

## The helper build

The helper is built by calling `swiftc` directly rather than through SwiftPM: `swift build` and
`swift test` abort in dyld on a machine with mismatched Command Line Tools, and the SDK ships no
XCTest. `native/Package.swift` is kept for the day that is fixed; the real build lives in
`scripts/build-helper.sh`, `scripts/test-helper.sh` and `scripts/lib/swiftc-common.sh`, and the
Swift tests run against a tiny XCTest shim with an explicit registry.

`scripts/build-helper.sh` signs with the identity named in `FREMKIT_SIGN_IDENTITY`, defaulting to
"Fremkit Helper Dev" — see [troubleshooting.md](troubleshooting.md#permissions-reset-every-time-i-rebuild-the-helper)
for why a stable identity matters.

The `--probe` flag is a headless diagnostic for the touch driver; it is documented in
[troubleshooting.md](troubleshooting.md#touch-does-not-work).

## Configuration files

**Helper** — `~/Library/Application Support/Fremkit/helper.json`, created with defaults on first
run:

| Key | Default | What it is |
|---|---|---|
| `repoPath` | `~/fremkit` | the checkout whose server the helper supervises (`pnpm setup` writes the real path) |
| `url` | `http://127.0.0.1:4242/?kiosk=1` | what the kiosk window loads |
| `adminUrl` | `http://127.0.0.1:4242/admin` | what the admin window loads |
| `port` | `4242` | port watched to decide whether a server is already up |
| `display` | `2560 × 720` | the Edge's size, used to find the display |
| `touch` | `true` | the native touch driver |
| `fence` | `true` | keep the mouse cursor out of the Edge |
| `manageServer` | `true` | start and restart the server |
| `launchAtLogin` | `false` | login item |
| `scrollInvert` | `false` | flip the touch scroll direction |
| `dock` | `true` | read the Dock's badges (needs Accessibility) |

**Dashboard** — `data/fremkit.json`, created from the defaults on first start of the server;
`data/fremkit.example.json` is that default, committed for reference. The file is yours and is
git-ignored. It holds `version: 2`, the grid, the pages and their widgets, the connections'
non-secret fields, the secrets backend and the language.

A v1 file (32 × 8 cells of 80 px) is migrated on load — coordinates doubled, cell halved — and the
original kept as `data/fremkit.json.bak`.

**Other data** — background images in `data/backgrounds/`, Dock icons in `data/icons/`, icons
extracted from installed application bundles in `data/icons/apps/`, site favicons in
`data/icons/favicons/`, secrets in the keychain or `data/secrets.json`; all git-ignored. The supervised server's stdout and stderr go
to `~/Library/Logs/Fremkit/server.log`, opened by the menu's *Log…*. It is never rotated, so
delete it by hand if it grows.

## Pull requests

Fork, branch, and open the pull request against `main`. Every pull request runs
`.github/workflows/ci.yml` on Ubuntu with Node 22: `pnpm install --frozen-lockfile`, then
`pnpm typecheck`, `pnpm test` and `pnpm build`. The widget catalogue test reads the real
`widgets/` folder, so a broken manifest fails the run.

The CI cannot see two of the conventions, and `.github/pull_request_template.md` asks about them
instead: a user-facing string exists in French *and* English, and nothing personal — hostname, IP,
organisation, serial number, e-mail address, token — is anywhere in the diff, tests and fixtures
included.

The Swift helper is not built by the CI: `pnpm helper:build` and `pnpm helper:test` need macOS, the
self-signed identity and the local TCC grants. Run them yourself when you touch `native/` and say
so in the pull request.

Commits are small, one concern each, with an imperative subject and a body saying why.

## Coding agents

[AGENTS.md](../AGENTS.md) at the repository root is written for coding agents (and is what
`CLAUDE.md` loads): layout, commands, conventions and the gotchas that are easy to trip on.
Keep it in step with this document when a convention changes.
