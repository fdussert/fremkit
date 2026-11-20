# Widgets

Every widget Fremkit has, with the settings its manifest declares. The ones that need a printer,
a hub, a NAS or an account are published on the registry rather than shipped; they are listed
apart and documented the same. Sizes are in grid cells (40 px each). **Scope** says which editor offers a setting: *tile* only appears in the
widget inspector, *compact* only in the navigation bar's list, *both* in either.

To write your own, see [writing-widgets.md](writing-widgets.md).

| Widget | Shows | Connection | Compact | Default size |
|---|---|---|---|---|
| [battery](#battery) | The Mac and its Bluetooth peripherals | — | 5 cells | 8 × 6 |
| [brightness](#brightness) | The brightness of the screen it is on, with a slider | — | 5 cells | 12 × 4 |
| [calendar](#calendar) | The next events of published calendars | ICS calendar | 8 cells | 16 × 10 |
| [claude-sessions](#claude-sessions) | Live Claude Code sessions | — | — | 16 × 8 |
| [claude-usage](#claude-usage) | Claude 5 h / 7 day limits | — | 9 cells | 16 × 4 |
| [clipboard](#clipboard) | Recent clipboard entries, tap to copy back | — | — | 16 × 8 |
| [clock](#clock) | Time, date and other cities | — | 5 cells | 16 × 4 |
| [cpu](#cpu) | CPU load and temperature | — | 4 cells | 8 × 4 |
| [disk](#disk) | Disk usage and available space | — | — | 16 × 4 |
| [disk-map](#disk-map) | What fills the disk, as rings you drill into | — | 2 cells | 24 × 9 |
| [fremplay](#fremplay) | The video of a Chrome tab, with touch controls | — | 3 cells | 28 × 16 |
| [gif-board](#gif-board) | Favourite GIFs in groups, tap to copy one | Giphy (search only, optional) | 2 cells | 16 × 8 |
| [memory](#memory) | Memory usage, available RAM and swap | — | 4 cells | 8 × 4 |
| [uptime](#uptime) | Time since the Mac last booted | — | — | 8 × 4 |
| [network](#network) | Live network throughput | — | 6 cells | 12 × 4 |
| [notifications](#notifications) | Unread badges read from the Dock | — | — | 16 × 4 |
| [pomodoro](#pomodoro) | A work and break timer | — | 5 cells | 8 × 6 |
| [processes](#processes) | Top processes | — | — | 16 × 8 |
| [recent-projects](#recent-projects) | The folders you worked in lately, one tap away | — | 8 cells | 12 × 8 |
| [service-status](#service-status) | A dot per service, up, warn or down | — | 4 cells | 8 × 6 |
| [shortcuts](#shortcuts) | Big buttons that open apps, links and shortcuts | — | — | 16 × 8 |
| [spotify](#spotify) | Spotify transport controls | — | long press opens the app | 16 × 4 |
| [volume](#volume) | System volume | — | — | 8 × 4 |
| [weather](#weather) | Current weather and forecast | — | 5 cells | 16 × 6 |

## On the sietch

These are published on the [widget registry](https://github.com/fdussert/fremkit-sietch) rather
than shipped with Fremkit: they only do anything with a printer, a hub, a NAS, an account or
another application behind them, and the core ships what works on any Mac with nothing set up. Install them from the
**Sietch** panel in the admin. The provider or connection type each one reads is part of Fremkit,
or declared by the widget itself, so there is nothing else to install — see [connections.md](connections.md).

Their settings are documented below like any other, because the widget is the same widget.

| Widget | Shows | Connection | Compact | Default size |
|---|---|---|---|---|
| [ado-pipelines](#ado-pipelines) | Azure DevOps builds | Azure DevOps | — | 24 × 10 |
| [bambu-job](#bambu-job) | A Bambu Lab printer's current job | Bambu Lab | — | 16 × 6 |
| [cleanshot](#cleanshot) | Big buttons for CleanShot X captures | — | — | 12 × 6 |
| [codex-sessions](#codex-sessions) | Codex sessions grouped by folder | — | 6 cells | 20 × 12 |
| [codex-usage](#codex-usage) | Codex account quotas and usage | — | 7 cells | 20 × 12 |
| [docker-containers](#docker-containers) | Local Docker containers: state, start, stop, restart | — | — | 32 × 8 |
| [github-actions](#github-actions) | Running and finished GitHub Actions workflows | GitHub | — | 24 × 10 |
| [github-inbox](#github-inbox) | GitHub notifications, review requests, pull requests | GitHub | 5 cells | 20 × 10 |
| [homey-devices](#homey-devices) | Lights, plugs and sensors | declared | 6 cells | 24 × 8 |
| [homey-flows](#homey-flows) | Buttons that run flows | declared | — | 16 × 8 |
| [key-light](#key-light) | An Elgato Key Light: on or off, brightness, warmth | declared | 5 cells | 12 × 6 |
| [local-models](#local-models) | Ollama models and MLX processes | — | — | 32 × 8 |
| [mac-temperatures](#mac-temperatures) | The CPU temperature and where it was read | — | 5 cells | 16 × 6 |
| [mutedeck](#mutedeck) | Meeting controls | — | — | 8 × 4 |
| [rtk-gain](#rtk-gain) | Tokens RTK saved, today and overall | — | 6 cells | 12 × 4 |
| [synology-storage](https://github.com/fdussert/fremkit-sietch) | Volumes, disk health and temperature | Synology | 5 cells | 16 × 8 |
| [synology-system](https://github.com/fdussert/fremkit-sietch) | CPU, memory, network and uptime of a NAS | Synology | 5 cells | 16 × 8 |

---

## battery

*Batteries* — one row per battery, each with a glyph filled to its charge and turning red below
20 %: the Mac first, then every Bluetooth peripheral that reports a level, lowest first.

The Mac's own battery comes from `pmset`; a desktop has none, and the row is then absent rather
than zero. Peripherals are read from `system_profiler SPBluetoothDataType` and from the HID
service in `ioreg`, matched on the device address — recent macOS returns an empty product name
over ioreg, so the name comes from the Bluetooth side and the charge from whichever source has
one. A set of earbuds shows its left, right and case levels beside the lowest of the three.

Polled every thirty seconds: `system_profiler` is slow and a battery level barely moves.

Minimum size 8 × 4, default 8 × 6. Compact width 5 cells: the battery that will run out first.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showMac` | boolean | `true` | tile | Show the Mac's own battery |
| `max` | number | `6` | tile | Most rows to show |

## brightness

*Brightness* — the brightness of the screen the tile is on: a slider to slide a finger along, the
level as a number, and a line saying what drives it — manual, day / night with the time of the
next switch, following the Mac's screen, or both. A change by hand holds until the next switch
or until the Mac's brightness moves noticeably, and **Auto** ends it at once. The day and night
levels and what the screen follows are set per screen, in *Settings → your screen → Brightness*.

It works over DDC/CI on Apple silicon and needs the helper. A display that does not answer says
so in the tile instead of failing silently: see
[troubleshooting](troubleshooting.md#brightness-says-not-adjustable). On a screen shown by a
paired tablet, the tile sets that tablet's own brightness, never the Edge's.

Minimum size 8 × 3, default 12 × 4. Compact width 5 cells: the slider and the level, slid in the
bar itself. No settings.

## calendar

*Next events* — merges any number of ICS calendars, each keeping its own colour, and groups the
coming events by day: Today, Tomorrow, then the weekday date. Needs one or more
[ICS calendar connections](connections.md#ics-calendars).

Minimum size 8 × 4, default 16 × 10. Compact width 8 cells: the next event of the coming day on
one line, or "Free".

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `calendars` | connections (`ics`) | `[]` | both | The calendars to merge, each shown with its colour |
| `days` | number | `7` | tile | How many days ahead to look |
| `max` | number | `8` | tile | How many events to draw |
| `showLocation` | boolean | `true` | tile | Show each event's location |

## claude-sessions

*Claude sessions* — every live Claude Code session: project, branch, model, state (working, idle,
waiting), subagents and elapsed time. Fed by the hooks described in
[claude-code.md](claude-code.md).

Minimum size 16 × 4, default 16 × 8.

A card that is waiting for you goes to its session when you touch it; every other card has a ↗
in its corner that does the same. Which window is raised depends on the terminal application —
see [claude-code.md](claude-code.md#going-to-a-session).

A card is titled with the session's name, the one Claude Code's `/rename` gives it, and otherwise
with the repository's name. The line under the title says where the session sits: the repository,
the worktree or subfolder it runs in, and the branch (`platform/tools/bg-rollup@develop`). An idle
or finished card says how long it has been silent.

**Pinning.** A long press on a card (on the Edge: hold for a second, then lift) pins the session: it moves to the top of the tile as a small
card, its name and the model's context bar and nothing else, so that several pinned sessions leave
room for the ones that are moving. A pinned session is shown whatever the filters below say, stays
on the board however long it has been quiet, shows three moving dots in its corner while it is
working, and turns orange and pulses when it waits for you. A
touch still goes to its window; a long press on it lets it go. The pins are the server's, so every
*Claude sessions* tile and every paired device shows the same ones, in the order they were pinned,
and a pin follows its terminal through `/clear`. It ends when the session closes. Dragging a pin
onto another puts it in that place (on the Edge, hold it for a moment before sliding; on a
tablet, set off sideways).

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `max` | number | `0` | both | Sessions shown; `0` means all of them |
| `onlyWaiting` | boolean | off | both | Show only the sessions waiting for you |
| `hideDone` | boolean | on | both | Drop a finished or idle session from the board after 30 min |
| `showCount` | boolean | on | both | The number of sessions after the tile's title (`Claude sessions · 18`); nothing when the title is hidden |
| `showStats` | boolean | on | both | Today's summary above the cards: sessions, finished, commits |
| `sort` | enum | `state` | both | `state`: the sessions waiting for you first, then working, failed, finished and idle, the most recent first within each; `recent`: by last activity alone |
| `pinSize` | enum | `card` | both | `card`: a pinned session is as wide as a card, so pins and cards line up; `small`: narrower, to fit more of them on a row |
| `groupByClient` | boolean | off | both | One section per application (Orca, Terminal, …) |
| `sound` | enum | `none` | both | A macOS system sound when a session starts waiting |
| `soundOn` | enum | `attention` | both | What the sound is for: a question, or a question or a permission |

The count in the header is always the real total — a filter changes what is worth looking at, not
what is running. The sound is played by Fremkit rather than by the widget, and only the first
placed tile that chose one is heard; see [claude-code.md](claude-code.md#a-sound-when-a-session-waits).

## claude-usage

*Claude limits* — the 5 h and 7 day limits and today's token count, plus the per-model weekly
limits when the account provider can read them. See [claude-code.md](claude-code.md).

Minimum size 16 × 4, default 16 × 4. Compact width 9 cells. No settings.

## clipboard

*Clipboard* — the texts you copied recently, newest first; tapping one puts it back on the
pasteboard, so the next ⌘V pastes it. **Clear** empties the history.

Privacy: the history lives in memory only — nothing is written to `data/`, nothing is logged and
nothing leaves the Mac. The pasteboard is read once a second, and only while a widget is showing
the channel — the history is dropped as soon as the last one stops. Twenty distinct entries are
kept, each capped at 2 kB. An entry that looks like a secret — 32 characters or more with no
space, or containing *password*, *secret*, *Bearer*, *PRIVATE KEY*, `sk-` or `ghp_` — is listed
as "••• secret": its text is still copyable back, but it is never sent to the screen.

Minimum size 8 × 4, default 16 × 8.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `max` | number | `8` | both | How many entries to draw, out of the twenty kept |
| `showTime` | boolean | `true` | both | Show how long ago each entry was copied |

## clock

*Clock* — time, date, and any number of other cities in their own time zones.

Minimum size 8 × 4, default 16 × 4. Compact width 5 cells, widened to 8 when `compactDate` or
`compactCities` is on.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `hour12` | boolean | `false` | both | 12-hour clock |
| `seconds` | boolean | `false` | both | Show seconds |
| `showDate` | boolean | `true` | tile | Show the date under the time |
| `compactDate` | boolean | `false` | compact | Bar: add the date. Widens the widget to 8 cells |
| `compactCities` | boolean | `false` | compact | Bar: add the cities. Widens the widget to 8 cells |
| `locale` | string | `""` | both | BCP 47 tag the time and date are formatted with; empty means the app's language |
| `cities` | list, max 6 | `[]` | both | Extra clocks — see below |

Each `cities` item: `label` (string), `timezone` (timezone), `hour12` (boolean, `false`),
`seconds` (boolean, `false`).

## cpu

*CPU* — load and, when the machine reports one, temperature. On Apple Silicon, install the third-party open-source tool with `brew install macmon`, then enable **Read the CPU temperature with macmon** in Screen privacy settings. Fremkit does not install macmon. After opt-in, it runs only `/opt/homebrew/bin/macmon` or `/usr/local/bin/macmon` locally every 10 seconds, returns the last reading without delaying CPU load, and falls back to the system value if no recent macmon sample is available.

Minimum size 8 × 4, default 8 × 4. Compact width 4 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showTemp` | boolean | `true` | both | Show the temperature next to the load |

## disk

*Disks* shows used and available capacity of the Mac disk and volumes under `/Volumes`. On APFS it prefers the data volume to avoid presenting the sealed system volume as the usable disk. The Mac disk uses container size minus reported available space so its numbers add up. APFS volumes that share one container — the Mac disk and a volume added to it in Disk Utility, or two volumes of one external disk — are one row: macOS reports each of them with the whole container's size and the same free space, so the row's bar is split into one segment per volume, then *System* for what the rest of the container holds (system volumes, snapshots). Sizes are in decimal units, as Finder and Disk Utility count them. System disk readings omit purgeable capacity, so free space may be lower than Finder shows.

Minimum size 8 × 4, default 16 × 4. No settings.

## disk-map

*Disk map* — what takes the space, DaisyDisk-style: the folders of the home folder or of a volume
as rings around the folder in the centre, and beside them the same folders as a list with their
sizes. Tap a segment or a row to go into that folder, tap the centre or a crumb of the path to go
back up, hold a row or a segment to show it in Finder. ↻ scans again, ✕ stops a scan. Nothing is
ever deleted or moved: the widget only looks.

Sizes are the space a file actually takes on the disk, as `du` counts it; a hard-linked file counts
once, a symlink is never followed, another volume mounted inside is not entered, and an iCloud
file that is only in the cloud counts what it takes locally — it is never downloaded. A folder that
could not be read is drawn hatched with a lock and counted apart, never as small: see
[troubleshooting](troubleshooting.md#the-disk-map-says-folders-could-not-be-read).

A scan runs only when asked — the ↻, or the first time a root is shown — never on a timer, one at
a time. Under the helper it uses `fremkit-scan`, which ships inside the helper's bundle and reads
at low priority; without the helper (`pnpm dev`) it falls back to `du`, slower and without single
files. The last scan is kept under `data/disk-map/` and shown with its date after a restart.

Minimum size 8 × 6, default 24 × 9. A tile at least 1.6 times wider than tall gets the list
beside the ring; a narrower one, and the compact rendering (2 cells), show the ring alone.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `root` | enum | `home` | both | `home` (the home folder) or `volume` |
| `volume` | string | `""` | both | With `volume`: its name under `/Volumes`. Network volumes are not offered |
| `rings` | enum | `3` | tile | Rings around the centre, 2 to 4 |

## fremplay

*Fremplay* — the video playing in a Chrome tab, sent by the Fremkit Companion extension, with
its title, its site and its position. A tap shows the controls for four seconds: −10 s, play or
pause, +10 s, volume down and up, mute, fill, bring the tab forward in Chrome, and stop sharing.
Until a share starts the tile says what is missing: the extension, the browser, or a video.

Minimum size 8 × 5, default 28 × 16 — a full page of the Edge is where it is meant to be. In the
bar it is a live thumbnail; a tap opens the full widget in the popover.

| Setting | What it does |
|---|---|
| **Video framing** | *Whole, with bars* (the default) shows the whole picture; *Fill, cropping* fills the tile and crops what overflows. The fill button on the Edge swaps the two for the current share only. |

The picture goes from Chrome to the dashboard directly, over this Mac; the server only passes
the connection details along.

## gif-board

*GIFs* — your favourite GIFs, sorted into groups shown as tabs. Touching one copies it to the
pasteboard as an animated GIF, so the next ⌘V sends it animated in Teams, Slack or Messages.
When the GIFs do not fit the tile, the row loops: past the last one comes the first again, in
either direction.

In the navigation bar it is a **GIF** badge. Tick *Full widget on touch* for it (your screen →
Navigation bar widgets) and touching the badge opens the whole board above the bar.

The collection is one per Mac: every GIF board tile shows the same groups. Fill it from the tile's
inspector, **Manage the GIFs…**: create and rename groups, search Giphy and add a result to the
chosen group, or paste a GIF's address. Drag a GIF to reorder it or move it to another group,
and a group by its name to reorder the groups (the order of the widget's tabs); right-click it to label or remove it, right-click a group to rename or delete it. Every change is
undoable like any other edit.

Searching needs a [Giphy connection](connections.md#giphy); pasting an address works without one.
A Giphy GIF is kept as its id and fetched from Giphy when touched; a GIF added by its own `https:`
address is checked and copied to a cache on this Mac when it is added, and shown from there.

On a paired iPad or Android tablet the board works the same way and copies to the **Mac's**
clipboard: the tablet is a second Edge beside the Mac. It reaches the cached GIFs of the
collection only, and only while its screen shows a GIF board.

Minimum size 8 × 4, default 16 × 8.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showLabels` | boolean | `true` | both | Show each GIF's label on it |
| `rows` | enum `1`, `2` | `1` | both | One row of large GIFs, or two of smaller ones in the same space |

## memory

*Memory* shows used and available RAM plus swap usage when the system reports it.

Minimum size 8 × 4, default 8 × 4. Compact width 4 cells. No settings.

## uptime

*Uptime* shows the time since the Mac last booted in days, hours and minutes. If the system cannot provide a reading, the widget shows it as unavailable.

Minimum size 8 × 4, default 8 × 4. No settings.

## network

*Network* — live throughput of the interface the default route goes out of: the two rates as big
numbers, a sparkline of the last minute, and the interface, IPv4 address and Wi-Fi network.

The rates are deltas between two samples of the kernel's counters, taken every two seconds, so the
first reading after a tile opens is zero. The last minute is kept by the server rather than by the
widget, so a tile opened a moment ago still draws a graph.

On macOS 14 and later the SSID is redacted for a process without the Location permission. Fremkit
does not ask for it: the network name is a label, and the tile simply leaves it out.

Minimum size 8 × 4, default 12 × 4. Compact width 6 cells: the two rates.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showGraph` | boolean | `true` | tile | Draw the sparkline of the last minute |
| `showAddress` | boolean | `true` | tile | Show the interface, IP and Wi-Fi network |

## notifications

*Notifications* — the unread badges macOS draws on the Dock, read by the native helper. Tapping an
icon brings that app to the front. Needs the helper running with Accessibility granted.

Minimum size 8 × 3, default 16 × 4.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `apps` | apps | `[]` | both | Which of the apps the Dock currently shows to draw, in the order you set |
| `size` | enum `petite` \| `normale` | `normale` | both | Icon size (small / normal) |

## pomodoro

*Pomodoro* — a work and break timer driven by three big buttons. The phase label, the remaining
`mm:ss` and a ring in the accent colour fill the tile; a row of dots below shows how many work
phases of the current set are done. Work and break alternate on their own, with a long break every
few cycles. The countdown is read from the clock on each tick, so a throttled iframe does not make
it drift.

Minimum size 8 × 4, default 8 × 6. Under about 190 px tall the ring gives way to a bar. Compact
width 5 cells: the phase glyph and the remaining time, read only — the bar is too small to aim at,
and a bar instance keeps its own timer, separate from any tile.

The end-of-phase beep is WebAudio, unlocked by the first button press because the browser wants a
user gesture; where the context is refused the beep is skipped and nothing else changes. Widget
iframes are sandboxed to `allow-scripts`, an opaque origin where `localStorage` throws, so the
timer normally lives in memory for as long as the widget is mounted; the save and restore are
written anyway, guarded, for hosts where storage is reachable.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `work` | number | `25` | tile | Minutes of a work phase |
| `shortBreak` | number | `5` | tile | Minutes of a short break |
| `longBreak` | number | `15` | tile | Minutes of a long break |
| `cycles` | number | `4` | tile | Work phases before the long break |
| `sound` | boolean | `true` | tile | Beep at the end of a phase |
| `autoStart` | boolean | `false` | tile | Start the next phase on its own instead of waiting |

## processes

*Processes* — the top processes by CPU.

Minimum size 16 × 4, default 16 × 8.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `count` | number | `6` | both | Number of rows |

## recent-projects

*Recent projects* — the folders you worked in lately, most recent first: the git repositories
under the folders you name, plus, when ticked, what Claude Code, Codex, VS Code, Cursor, the
JetBrains IDEs, zoxide, tmux and Herdr remember. A tap opens the folder in Finder, a terminal,
your editor or Herdr (the pane already in that folder, else a new one), or starts Claude Code or
Codex on it in a new Herdr pane or tmux window. A long press offers the other installed
applications and can make one the project's own for every later tap. Without such a choice, the
files at a project's root can suggest the right IDE: a `.sln` for Rider, a `Cargo.toml` for
RustRover.

Only folder paths, dates and the names at a project's root are read, never a conversation or a
file's contents.

Minimum size 8 × 4, default 12 × 8. Compact width 8 cells: the most recent projects by name.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `source_git` | boolean | `true` | both | Source: the git repositories under the folders of `gitRoots` |
| `gitRoots` | list of `path` | `[]` | both | Folders to look for git repositories in, three levels deep (`~/Dev`, `/Volumes/Dev`…), twenty at most |
| `source_claude` | boolean | `false` | both | Source: Claude Code |
| `source_codex` | boolean | `false` | both | Source: Codex |
| `source_vscode` | boolean | `false` | both | Source: the folders VS Code opened recently |
| `source_cursor` | boolean | `false` | both | Source: the folders Cursor opened recently |
| `source_jetbrains` | boolean | `false` | both | Source: the recent projects of the JetBrains IDEs |
| `source_zoxide` | boolean | `false` | both | Source: zoxide |
| `source_tmux` | boolean | `false` | both | Source: the open tmux panes |
| `source_herdr` | boolean | `false` | both | Source: the open Herdr panes |
| `defaultApp` | enum | `finder` | both | What a tap opens a project with: `finder`, a terminal (`terminal`, `iterm`, `ghostty`), an editor (`vscode`, `cursor`, `zed`, `xcode`, a `jetbrains-…` IDE), `herdr` or `tmux`, or Claude Code or Codex started on it (`herdr-claude`, `herdr-codex`, `tmux-claude`, `tmux-codex`) |
| `suggestApp` | boolean | `true` | both | Suggest an application from the files at the project's root |
| `herdrTerminal` | enum `auto` \| `terminal` \| `iterm` \| `ghostty` | `auto` | both | The terminal Herdr runs in, brought to the front |
| `max` | number | `8` | both | Rows shown |
| `compactCount` | number | `3` | compact | Bar: how many projects |

## service-status

*Service status* — pings a list of services and draws one dot each: green when it answers, amber
when it answers badly, red when it does not answer at all. Beside the name go the latency of the
last probe and a strip of the last twenty, so a service that flaps is visible without a graph. A
summary line under the list says whether everything is up. Compact, it is a single dot in the
worst colour of the list and how many services are up.

Three kinds of probe. `http` sends a GET and reads the status: 2xx and 3xx are up, 4xx is amber,
5xx is down, and so is a request that times out. `tcp` opens a connection to `host:port` and
closes it again. `ping` runs one ICMP echo. The probe list lives in the widget's settings rather
than in the server, so the widget keeps its own clock and hands the list over on every tick; the
server validates it before anything leaves the machine — `http` and `https` only, so no `file:`
or `javascript:` address, hosts made of letters, digits, dots, hyphens and colons, at most twenty
services, five seconds each, run in parallel. No redirect is ever followed, no credentials are
sent, and the only header is the Fremkit user agent. A probe asked for by anything but a client
on this Mac is refused.

Minimum size 8 × 4, default 8 × 6, compact 4 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `services` | list of `{ name, kind, url }` | `[]` | both | One row per service, in the order drawn |
| `interval` | number | `30` | both | Seconds between two probes; anything under 10 is read as 10 |
| `showLatency` | boolean | `true` | tile | Draw the last probe's latency beside the name |
| `columns` | number | `2` | tile | How many services per row |

A `services` row holds `name` (what the dot is labelled; the target is used when it is empty),
`kind` (*HTTP*, *TCP* or *Ping*) and `url` — an `http(s)` link, a `host:port` pair, or a bare
host, depending on the kind.

## shortcuts

*Shortcuts* — a grid of large touch buttons that open an application, a link or a Shortcuts.app
shortcut. A tap lights the button and answers with a brief ✓ or ✗. Application buttons draw the
app's real icon: the one the native helper uploaded when it is in the Dock, and otherwise one the
server extracts from the installed bundle itself (`sips`, cached under `data/icons/apps/`), so an
application that has never been docked still shows its icon. The name on the button is matched
against the installed applications, asked for through the host page (`Fremkit.installedApps`), to
find the bundle identifier that icon is filed under. The kind's glyph is the last resort.

In the admin, the *Target* box of an application row offers the applications installed on this
machine as you type — `/Applications` and its subfolders, `~/Applications`, and the system ones.
It is a suggestion, not a list: any name can still be typed.

A link button draws the site's own favicon, asked for through the host page (`Fremkit.favicon`)
and retried every thirty seconds while the site does not answer. The server reads the page at the origin and takes the
icon it declares — an `apple-touch-icon` first, a plain `icon`/`shortcut icon` second, the largest
declared `sizes` breaking the tie — and falls back to `/favicon.ico` when the page declares none.
A site that serves its icon as `application/octet-stream` or with no type at all, which is common
for `favicon.ico`, is judged by the file's first bytes rather than by what it claims: PNG, GIF,
WebP, ICO and JPEG are recognised, anything else is dropped.

**SVG is not**, and a site whose only icon is one gets no icon. An SVG is a document that can
carry script, and it would be served back from this server's own origin — the one the WebSocket
and the connections API trust.

**A site on a private or local address gets no icon either.** A button pointing at a NAS, a
router, Home Assistant or anything else on the LAN keeps working; it simply draws its glyph
instead of a favicon. The server will not fetch from a loopback, private, link-local or reserved
address, because it runs on your Mac and that would make it a way to reach the services on it.

Privacy: that favicon is the one thing here that reaches the outside. The server asks the site
itself — only its origin, never the path the button points at — at most once a week, keeps the
image under `data/icons/favicons/` and never logs the address; a site that is down keeps serving
the icon it last had, and turning `showIcons` off fetches nothing at all.

A button of kind *Group* holds up to twelve buttons of its own, a *Subgroup* among them if need be
(which holds twelve more, and no further group), and draws up to four of their icons
in a small square, as a folder does. A tap opens it in place of the grid, its buttons flying out of
it, with a back button in the first cell, and stays open until that button is touched. Its buttons
are the size of the grid's, so more of them than fit scroll, the back button staying put. In the admin, drop a button onto the middle of a group to put it in,
and use *Take out of the group* in its fields to put it back. The widget only says which button of
which group was touched; the server reads what it opens from the saved settings, as for any button.

A link may open in **a browser profile**: its *Open in* box offers the profiles of the Brave,
Chrome and Edge installed on this Mac, as `Brave — Perso`, read from each browser's own
`Local State` (the profile's name only, never the account signed into it). macOS keeps that file
from an app it did not give **Full Disk Access** (System Settings → Privacy & Security), and then
the box offers the profile folders instead, `Brave — Default`, `Brave — Profile 1`…, which work
just as well; grant the access to *Fremkit Helper* to see the names. A profile the list does not
show can be typed by its folder name, `Brave — Profile 3`; `brave://version` shows a profile's
folder as the last part of its *Profile path*. The server finds the browser in
`/Applications` or `~/Applications` and the profile folder in the browser's data folder, then runs
`open -n -a <browser> --args --profile-directory=<folder> <url>`; a browser or a profile it cannot
find is an error, never the default browser. The button wears the profile's initial in its corner
unless `profileBadge` is off.

Only three kinds exist, and none of them is a shell: `app` runs `open -a <name>`, `url` runs
`open <url>` for an `http`, `https` or `mailto` address only, and `shortcut` runs
`shortcuts run <name>`. The server validates every payload — a name holding a path separator or a
shell metacharacter, or a `file:` or `javascript:` address, is refused — and runs the program with
an argument list, never through a shell.

Minimum size 8 × 4, default 16 × 8. The rows share the tile's height — two rows of buttons are
tall, with icons to match — down to a finger-sized minimum, past which the grid scrolls.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `buttons` | list of `{ label, kind, target, profile, icon, items }` | `[]` | both | One row per button, in the order drawn |
| `columns` | number | `4` | both | How many buttons per row |
| `profileBadge` | boolean | `true` | both | Draw the initial of the browser profile a link opens in |
| `showIcons` | boolean | `true` | both | Draw the icon of an application button, and the site's favicon for a link |
| `background` | `tinted` / `accent` / `custom` / `none` | `tinted` | both | What the buttons are drawn on: a translucent tint, the tile's accent, the colour below, or nothing |
| `color` | colour | `#d9b36a` | both | The buttons' colour when `background` is `custom`; the text on it is black or white, whichever reads |

A `buttons` row holds `label` (what the button says; the target is used when it is empty), `kind`
(*Application*, *Link* or *Shortcut*) and `target` (the application name, with suggestions from the
installed applications, the address, or the shortcut's name as Shortcuts.app spells it). `icon` is
optional and wins over the button's own icon: an emoji, drawn as it is, the address of an image
(PNG, ICO, … — no SVG, nothing on the LAN), or the address of a site whose favicon the button
borrows — for a link whose site only paints its icon once you are signed
in, or one on the LAN, which gets none of its own.

`icon` may also be one of **your own icons**: the folder button beside the field opens the library
the tiles' title icons come from, where you pick one or import a PNG, WebP or SVG (256 KB at most).
That is the way to an SVG mark, such as a CI service's pipeline icon: imported files are checked
and served so that they cannot run anything, and the widget draws them as plain images. A group
takes an icon the same way, an address included, instead of the square of what it holds.

## spotify

*Spotify* — the current track's cover, title and artist, with previous / play-pause / next.

Minimum size 16 × 4, default 16 × 4.

| Setting | What it does |
|---|---|
| **Long press: open Spotify** | A press held on the tile brings the Spotify application forward. Off by default: a tile you touch to pause should not leave the dashboard by surprise. |

The tap that would have followed a long press is swallowed, so holding the play button opens the
app without also toggling playback.

## volume

*Volume* — the system output volume, with a slider and a mute toggle.

Minimum size 8 × 4, default 8 × 4. No settings.

## weather

*Weather* — the current temperature with its condition glyph, the feels-like, wind and humidity,
then a row of the coming hours (hour, glyph, temperature, rain chance) and optionally the next
days' minimum and maximum. Data comes from [Open-Meteo](https://open-meteo.com), which needs no
account and no key: the city is geocoded once through their geocoding API and the coordinates are
then reused, both hosts declared in `permissions.network` and reached through the widget proxy.

Refreshed every ten minutes. A failed poll keeps the last forecast on screen and raises a small
amber dot in the corner rather than blanking the tile. Numbers, hours and weekdays are formatted
with `Intl` in the dashboard's language, and the hourly row drops its last columns rather than
squashing them when the tile is narrow.

Minimum size 8 × 4, default 16 × 6. Compact width 5 cells: the glyph and the temperature, plus the
city where the bar has room for it.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `location` | string | `Paris` | both | The city to geocode, in any language |
| `units` | enum `metric` \| `imperial` | `metric` | both | °C and km/h, or °F and mph |
| `hours` | number | `6` | tile | How many upcoming hours to draw, capped by the tile's width |
| `showDaily` | boolean | `true` | tile | The next days' minimum and maximum, on tall enough tiles |
| `compactCity` | boolean | `false` | compact | Bar: add the city name after the temperature |

---

# Widgets on the sietch

The same reference, for the widgets published on the
[registry](https://github.com/fdussert/fremkit-sietch). Nothing about a widget changes when it is
installed from there rather than shipped: same manifest, same settings, same permissions — only
the folder it arrives in.

## ado-pipelines

*Azure DevOps pipelines* — runs in progress with their stage chain, then recent history. Tapping a
run opens it in your browser. Needs an [Azure DevOps connection](connections.md#azure-devops).

Minimum size 16 × 6, default 24 × 10.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`azure-devops`) | — | both | Which organisation and project to read |
| `history` | number | `8` | both | How many finished runs to keep under the running ones |
| `branchFilter` | string | `""` | both | Keep only branches starting with this. `refs/heads/` is already stripped, so type `feature/` |

## bambu-job

*Bambu print* — the file, progress, layer, remaining time and temperatures of the current job,
plus the AMS and the chamber camera on demand. Needs a
[Bambu Lab connection](connections.md#bambu-lab).

Minimum size 12 × 4, default 16 × 6.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`bambu`) | — | both | Which printer |
| `showAms` | boolean | `false` | both | One row per AMS unit: humidity, temperature, slot colours and types, filament left, slot in use. An external spool gets its own row |
| `showCamera` | boolean | `false` | both | The chamber camera. X1 and H2 printers need ffmpeg and "LAN Mode Liveview" — see the [connection notes](connections.md#the-chamber-camera) |

## cleanshot

*CleanShot X* — a grid of large touch buttons that drive [CleanShot X](https://cleanshot.com)
through its `cleanshot://` [URL scheme](https://cleanshot.com/docs/api). A tap lights the button
and answers with a brief ✓ or ✗. **CleanShot X must be installed on the Mac running Fremkit**;
without it macOS has nothing to open the URL with and every button answers ✗. **CleanShot must
also be allowed to take URL commands**: in CleanShot X → Settings → Advanced → API, turn on
*Allow URL scheme API*. It is off by default; with it off, every button answers ✓ (macOS did
hand the URL over) and nothing happens.

The widget never sends a URL. It names an action, and the server builds the URL from a closed
allow-list — fourteen actions, no parameter that is not an enum or a boolean, no file path, no
geometry — then runs `open <url>` with an argument list rather than through a shell. An action
that is not on the list is refused, and, like the `shortcuts` widget, a command is only obeyed
when it comes from this machine.

The URL goes to the CleanShot X that is **running right now**, found by its bundle path: a Mac
that keeps an older copy around — in `~/Downloads`, in a second `Applications` folder — otherwise
risks having LaunchServices hand the URL to that one, which launches, does nothing and quits. With
no copy running, the bundle id is used instead, which at least keeps the URL away from an
application that is not CleanShot at all.

| Action | Button | URL |
|---|---|---|
| Area | ⛶ | `cleanshot://capture-area` |
| Window | 🪟 | `cleanshot://capture-window` |
| Fullscreen | 🖥 | `cleanshot://capture-fullscreen` |
| Scrolling | 📜 | `cleanshot://scrolling-capture` |
| Text (OCR) | 🔡 | `cleanshot://capture-text` |
| Record | ⏺ | `cleanshot://record-screen` |
| Previous area | ↺ | `cleanshot://capture-previous-area` |
| All-in-one | ✳ | `cleanshot://all-in-one` |
| Self-timer | ⏱ | `cleanshot://self-timer` |
| History | 🕘 | `cleanshot://open-history` |
| Clipboard | 📋 | `cleanshot://open-from-clipboard` |
| Pin | 📌 | `cleanshot://pin` |
| Desktop icons | 🗂 | `cleanshot://toggle-desktop-icons` |
| Restore | ♻ | `cleanshot://restore-recently-closed` |

Minimum size 8 × 4, default 12 × 6.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showCaptureArea` | boolean | `true` | both | Capture a selected area |
| `showCaptureWindow` | boolean | `true` | both | Capture a window |
| `showCaptureFullscreen` | boolean | `true` | both | Capture the whole screen |
| `showScrollingCapture` | boolean | `true` | both | Scrolling capture |
| `showCaptureText` | boolean | `true` | both | Text recognition (OCR) |
| `showRecordScreen` | boolean | `true` | both | Record the screen |
| `showCapturePreviousArea` | boolean | `false` | both | Capture the previous area again |
| `showAllInOne` | boolean | `false` | both | CleanShot's all-in-one mode |
| `showSelfTimer` | boolean | `false` | both | Capture after the self-timer |
| `showOpenHistory` | boolean | `false` | both | Open the capture history |
| `showOpenFromClipboard` | boolean | `false` | both | Open what the clipboard holds |
| `showPin` | boolean | `false` | both | Pin the last capture to the screen |
| `showToggleDesktopIcons` | boolean | `false` | both | Show or hide the desktop icons |
| `showRestoreRecentlyClosed` | boolean | `false` | both | Bring back the last closed capture |
| `columns` | number | `3` | both | How many buttons per row |

With every button off the tile says so rather than going blank.

## codex-sessions

*Codex sessions* — at most fifty stored Codex sessions, grouped by the name of the folder each
one ran in, each card with what was observed of it: model, thinking effort, turn duration, source
and direct subagents. What was not observed stays unknown rather than guessed. Touching a card
opens that chat in the Codex desktop application, when the server can prove it is a local chat
that moved in the last two minutes; a session in a terminal has no window Fremkit can find and
does not open.

Nothing is read until you choose what may be: tick the sources under **Codex history to show**
in the admin's privacy settings. Codex must be installed on the Mac. What is read, and what never
is: [codex.md](codex.md).

Minimum size 12 × 6, default 20 × 12. Compact width 6 cells: a count of sessions. No settings.

## codex-usage

*Codex usage* — the account's type and plan, up to six quota windows with the time each resets,
and the account's usage figures. A value the account does not report is shown as unknown, never
as zero, and a stale one keeps its date. Quotas come with a ChatGPT sign-in; with an API key or
Amazon Bedrock the tile explains why there are none. The account's e-mail address is never part
of it.

Off until **Read Codex account quotas and usage** is ticked in the admin's privacy settings.
Codex must be installed and signed in on the Mac: see [codex.md](codex.md).

Minimum size 12 × 6, default 20 × 12. Compact width 7 cells: the quota windows. No settings.

## docker-containers

*Docker containers* — the containers of the Docker running on this Mac: name, image, state and,
for a running one, CPU, memory, processes, network and disk I/O. From its version 1.1.0 a tap on a
card unfolds it with **Stop** and **Restart** for a running container, **Start** for a stopped
one; Stop and Restart take a second tap to confirm, and the card folds back after ten seconds.
Nothing here removes or kills a container. Updating from 1.0.x asks you to accept the new
permission, and on a Fremkit older than these commands the cards do not unfold. Only a local
Docker socket is used; a context that points at another machine is refused and the tile says so.
See [local-operations.md](local-operations.md#docker).

Minimum size 24 × 8, default 32 × 8. No settings.

## github-actions

*GitHub Actions* — the workflow runs of the repositories the connection watches: the ones still
going at the top, each with a pulsing dot, then the finished ones as history rows coloured by
conclusion, with the repository, the workflow name, the branch, who triggered it and how long ago.
Needs a [GitHub connection](connections.md#github), whose `repos` field decides which repositories
are fetched at all.

Minimum size 16 × 6, default 24 × 10.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`github`) | — | both | Which GitHub account |
| `repos` | pick (`repos` of `connection`) | `[]` | both | Narrows the display to these repositories; empty shows every repository the connection fetches |
| `max` | number | `4` | both | How many running or queued workflows to draw |
| `history` | number | `8` | both | How many finished runs to draw under them |

## github-inbox

*GitHub inbox* — your unread notifications, the pull requests waiting for your review and, on
demand, your own open pull requests. Each row carries a glyph for its kind (pull request, issue,
release, CI), the repository, the title and how long ago it moved. Tapping a notification marks
that thread read — greyed out at once, confirmed by the next poll — and the **Mark all read**
button clears the lot. Needs a [GitHub connection](connections.md#github).

In the navigation bar it shows a short `GH` label, the unread count and the number of review
requests in the accent colour.

A source the connection cannot read draws one line under its header rather than emptying the tile
— "Notifications need a classic token" for a fine-grained token, "No access", "Rate limited" or
"Offline" — and its count leaves the header line. With a fine-grained token the widget therefore
shows the review count alone and keeps drawing reviews and pull requests. See
[the GitHub connection](connections.md#github).

Minimum size 12 × 5, default 20 × 10. Compact width 5 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`github`) | — | both | Which GitHub account |
| `showNotifications` | boolean | `true` | tile | The unread notification rows |
| `showReviews` | boolean | `true` | tile | The pull requests waiting for your review |
| `showMyPrs` | boolean | `false` | tile | Your own open pull requests |
| `max` | number | `12` | tile | Total rows drawn, shared between the sections in that order |

## homey-devices

*Homey devices* — a grid of device tiles: a large toggle for a switchable device, a slider for a
dimmable one, the main reading for a sensor, a badge for each raised alarm. An unavailable device
is dimmed. Brings its own [Homey connection](connections.md#homey) — the same shape as the flows
widget's, so one API key serves both.

Minimum size 8 × 4, default 24 × 8. Compact width 6 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`decl:homey-devices:homey-devices`) | — | both | Which Homey |
| `all` | boolean | `false` | both | Show every device instead of the listed ones |
| `deviceIds` | list of `id` | `[]` | both | The devices to draw, named by id. There is no picker: its options came from a coded connection type and a declared connection has none. A selection made with the old picker (`devices`) is still read |
| `zone` | string | `""` | tile | Keep only devices of this zone |
| `max` | number | `12` | tile | How many devices to draw |
| `showZone` | boolean | `true` | tile | Show each device's zone |
| `compactMode` | enum `on` \| `sensor` | `on` | compact | Bar: the number of devices that are on, or the first sensor value |

## homey-flows

*Homey flows* — one large button per flow, plain or advanced, that runs it on tap with a brief
confirmation. A flow switched off in the Homey app is dimmed and refuses the tap. Brings its own
[Homey connection](connections.md#homey).

Minimum size 8 × 4, default 16 × 8.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`decl:homey-flows:homey-flows`) | — | both | Which Homey |
| `all` | boolean | `false` | both | Show every flow instead of the picked ones |
| `flows` | pick (`flows` of `connection`) | `[]` | both | The flows to draw, picked live and stored as ids |
| `folder` | string | `""` | both | Keep only flows of this folder |
| `max` | number | `8` | both | How many flows to draw |

## key-light

*Key Light* — an Elgato Key Light: a button that switches it on or off, and its brightness and
warmth, each moved by the step you set. Brings its own connection, which is the light's address
on your network with port 9123 — a Key Light has no account and no key. The address is in the
Elgato Control Center application (Settings → Network), or on your router. See
[Connections a widget declares](connections.md#connections-a-widget-declares).

Minimum size 8 × 4, default 12 × 6. Compact width 5 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`decl:key-light:key-light`) | — | both | Which light |
| `step` | number | `10` | tile | How much one press changes the brightness or the warmth, in percent |

## local-models

*Local AI* — the Ollama models installed on this Mac, the ones loaded into memory with their
footprint and context size, and the MLX or oMLX server processes found running. A model loaded
into memory is not a model generating, and the tile says so; no prompt and no answer is ever
read. Ollama is asked on `127.0.0.1:11434`. See
[local-operations.md](local-operations.md#local-models).

Minimum size 24 × 8, default 32 × 8. No settings.

## mac-temperatures

*Mac temperatures* — the CPU temperature in °C, with where the reading came from. On Apple
silicon the measured value comes from macmon: install it with `brew install macmon`, then tick
**Read the CPU temperature with macmon** in the admin's privacy settings, as for the
[cpu](#cpu) widget. Without it the system's own sensor is used when it has a reading. The tile
says which of these is missing rather than showing a zero, and a reading that could not be taken
is `?`.

Minimum size 8 × 4, default 16 × 6. Compact width 5 cells: the same value. No settings.

## mutedeck

*MuteDeck* — meeting controls, through the MuteDeck app's own HTTP API on `localhost:3491`. The
buttons act on whatever meeting MuteDeck reports; without MuteDeck running the tile stays idle.

Minimum size 8 × 4, default 8 × 4.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showMute` | boolean | `true` | both | Microphone button |
| `showVideo` | boolean | `true` | both | Camera button |
| `showShare` | boolean | `false` | both | Screen share button |
| `showRecord` | boolean | `false` | both | Record button |
| `showLeave` | boolean | `true` | both | Leave button |

## rtk-gain

*RTK savings* — the tokens [RTK](https://github.com/rtk-ai/rtk) saved today and overall, the
number of commands it compacted, and a history by day. Fremkit only reads what RTK already
records, once a minute; RTK has to be installed (`brew install rtk`) and set up for your coding
agent. See [local-operations.md](local-operations.md#rtk).

Minimum size 8 × 3, default 12 × 4. Compact width 6 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `days` | enum `7` \| `14` \| `30` | `14` | both | How many days of history to draw |
