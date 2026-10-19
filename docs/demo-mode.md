# Demo mode

A Fremkit server that shows a full, living dashboard without reading anything off the Mac it runs
on, and without any account. Every channel publishes invented data: calendar events ("Weekly
sync", "Design review"), CPU, memory and disks that drift, a battery that drains, a music player
whose track plays, the weather, Claude Code sessions and limits, GitHub and Azure DevOps runs,
Dock badges, brightness, the disk map, and so on — and, for the Sietch's widgets, Codex sessions
and quotas, local AI models, a MuteDeck meeting, a Synology NAS, a Homey's devices and flows and
an Elgato Key Light.

It is what to use when the real data must not be on screen:

- **captures** for the site, a README or a post — nothing personal can leak into a screenshot;
- **App Store review** of the iPad app — a reviewer has no Mac with your accounts on it, so the
  demo server is what the paired app shows them;
- **widget previews** — `pnpm widget:preview` renders every widget against a demo server (see
  [writing-widgets.md](writing-widgets.md#a-preview-image));
- trying Fremkit out before connecting anything.

## Starting it

```bash
pnpm demo                         # http://127.0.0.1:4250, a fresh demo dashboard
FREMKIT_PORT=4260 pnpm demo       # another port
FREMKIT_PORT=4250 pnpm open       # sign a browser in (pnpm open /admin for the editor)
```

`pnpm demo` builds the UI first if `ui/dist` is missing. The same server is started by hand with
`FREMKIT_DEMO=1` (or `--demo`): `FREMKIT_DEMO=1 pnpm exec tsx src/index.ts` from `server/`.

It runs beside the live server: its default port is 4250, never 4242, and it has its own access
secret (`access-4250.token`) like any other instance.

## Its data folder

A demo writes into a folder of its own, never into your dashboard's:

- by default a **temporary folder**, created at start, seeded and removed when the server exits;
- or the one `FREMKIT_DATA_DIR` names, kept between runs — useful to prepare a layout once and
  capture it again later. The folder must be empty or one a demo created (it carries a
  `.fremkit-demo` marker). The server refuses the checkout's `data/` and any folder holding a
  `fremkit.json` that is not a demo's.

A fresh folder is seeded with a two-page dashboard that shows every built-in widget, a bar with a
clock, the weather, Claude's limits and the CPU, two ICS calendars (`Work`, `Home`), a Synology
connection (`NAS`, for the Sietch's Synology widgets, which are not on the dashboard), the Codex
privacy switches turned on, and the settings each widget needs to show something (a service list, shortcut buttons, cities for the
clock). Everything can be edited in the admin as usual; nothing you change there leaves the folder.

## What it does not do

In demo mode **no real provider is constructed**, and a test (`server/test/demo.test.ts`) makes
sure of it. In particular:

- nothing runs a program, reads `/Applications`, the Dock, the clipboard, `pmset`, `ioreg` or the
  disk, and no AppleScript is sent;
- secrets go to a file in the demo folder — the **keychain is never asked**, whatever the config
  says;
- connections (ICS, GitHub, Azure DevOps, Bambu Lab, Synology) keep their forms, but **Test**
  succeeds without contacting anything and their channels publish invented data; the secrets
  typed in are stored in the demo folder and never used;
- the widget proxy runs all of its checks, then answers the two Open-Meteo endpoints itself; any
  other host gets a 503;
- a connection a widget *declares* (Homey, Key Light) runs every check too, then is answered by
  invented devices whatever its address (`declared.ts`): lights switch, flows run, nothing is
  dialled. Its **Test** button goes there too. A path the demo does not know fails as unreachable.

Commands are accepted and acted out on the invented state: play/pause and next track work, the
volume and brightness sliders move, a disk map rescan "finishes" at once, a clipboard can be
cleared, a Claude session can be dismissed, MuteDeck's microphone and camera toggle and leaving
ends the call (another starts a minute later), a Homey light or a Key Light switches. Commands that would act on the Mac — open an
application, reveal a folder in Finder, focus a terminal — answer as if they had worked and do
nothing.

What is not a provider still behaves as on any server: the **Sietch** (the widget registry) is
browsed and installed from over the network, and a shortcut button given a web address fetches
that site's icon. Leave both alone when the network must stay quiet.

## Fixtures are generic

All of it is invented and generic, like the rest of the project: placeholder names
(`Alex Example`), `example.com` and `example-org`, documentation address ranges (`192.0.2.x`,
`198.51.100.x`). The invented machine lives in `server/src/demo/world.ts`, the providers in
`providers.ts` (Codex in `codex.ts`), the connection types in `connections.ts`, the weather in
`fetch.ts`, the declared connections' devices in `declared.ts` and the seeded dashboard in
`seed.ts`. A widget that reads a new channel needs a fake there too; the demo test
fails when a built-in widget subscribes to a channel the demo does not publish.
