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

## Coding agents

[AGENTS.md](../AGENTS.md) at the repository root is written for coding agents (and is what
`CLAUDE.md` loads): layout, commands, conventions and the gotchas that are easy to trip on.
Keep it in step with this document when a convention changes.
