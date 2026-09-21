# Widgets

Every widget Fremkit has, with the settings its manifest declares. The ones that need a printer,
a hub, a NAS or an account are published on the registry rather than shipped; they are listed
apart and documented the same. Sizes are in grid cells (40 px each). **Scope** says which editor offers a setting: *tile* only appears in the
widget inspector, *compact* only in the navigation bar's list, *both* in either.

To write your own, see [writing-widgets.md](writing-widgets.md).

| Widget | Shows | Connection | Compact | Default size |
|---|---|---|---|---|
| [battery](#battery) | The Mac and its Bluetooth peripherals | — | 5 cells | 8 × 6 |
| [calendar](#calendar) | The next events of published calendars | ICS calendar | 8 cells | 16 × 10 |
| [claude-sessions](#claude-sessions) | Live Claude Code sessions | — | — | 16 × 8 |
| [claude-usage](#claude-usage) | Claude 5 h / 7 day limits | — | 9 cells | 16 × 4 |
| [clipboard](#clipboard) | Recent clipboard entries, tap to copy back | — | — | 16 × 8 |
| [clock](#clock) | Time, date and other cities | — | 5 cells | 16 × 4 |
| [cpu](#cpu) | CPU load and temperature | — | 4 cells | 8 × 4 |
| [disk](#disk) | Disk usage | — | — | 16 × 4 |
| [memory](#memory) | Memory usage | — | 4 cells | 8 × 4 |
| [network](#network) | Live network throughput | — | 6 cells | 12 × 4 |
| [notifications](#notifications) | Unread badges read from the Dock | — | — | 16 × 4 |
| [pomodoro](#pomodoro) | A work and break timer | — | 5 cells | 8 × 6 |
| [processes](#processes) | Top processes | — | — | 16 × 8 |
| [service-status](#service-status) | A dot per service, up, warn or down | — | 4 cells | 8 × 6 |
| [shortcuts](#shortcuts) | Big buttons that open apps, links and shortcuts | — | — | 16 × 8 |
| [spotify](#spotify) | Spotify transport controls | — | long press opens the app | 16 × 4 |
| [volume](#volume) | System volume | — | — | 8 × 4 |
| [weather](#weather) | Current weather and forecast | — | 5 cells | 16 × 6 |

## On the sietch

These are published on the [widget registry](https://github.com/fdussert/fremkit-sietch) rather
than shipped with Fremkit: they only do anything with a printer, a hub, a NAS or an account
behind them, and the core ships what works on any Mac with nothing set up. Install them from the
**Sietch** panel in the admin. The provider or connection type each one reads is part of Fremkit,
so there is nothing else to install — see [connections.md](connections.md).

Their settings are documented below like any other, because the widget is the same widget.

| Widget | Shows | Connection | Compact | Default size |
|---|---|---|---|---|
| [ado-pipelines](#ado-pipelines) | Azure DevOps builds | Azure DevOps | — | 24 × 10 |
| [bambu-job](#bambu-job) | A Bambu Lab printer's current job | Bambu Lab | — | 16 × 6 |
| [cleanshot](#cleanshot) | Big buttons for CleanShot X captures | — | — | 12 × 6 |
| [github-actions](#github-actions) | Running and finished GitHub Actions workflows | GitHub | — | 24 × 10 |
| [github-inbox](#github-inbox) | GitHub notifications, review requests, pull requests | GitHub | 5 cells | 20 × 10 |
| [homey-devices](#homey-devices) | Lights, plugs and sensors | Homey Pro | 6 cells | 24 × 8 |
| [homey-flows](#homey-flows) | Buttons that run flows | Homey Pro | — | 16 × 8 |
| [mutedeck](#mutedeck) | Meeting controls | — | — | 8 × 4 |
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

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `max` | number | `0` | both | Sessions shown; `0` means all of them |
| `onlyWaiting` | boolean | off | both | Show only the sessions waiting for you |
| `hideDone` | boolean | on | both | Drop a finished or idle session from the board after 30 min |
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

*CPU* — load and, when the machine reports one, temperature.

Minimum size 8 × 4, default 8 × 4. Compact width 4 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `showTemp` | boolean | `true` | both | Show the temperature next to the load |

## disk

*Disks* — usage of the startup disk and of every volume mounted under `/Volumes`.

Minimum size 8 × 4, default 16 × 4. No settings.

## memory

*Memory* — memory usage.

Minimum size 8 × 4, default 8 × 4. Compact width 4 cells. No settings.

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
application that has never been docked still shows its icon. The kind's glyph is the last resort.

In the admin, the *Target* box of an application row offers the applications installed on this
machine as you type — `/Applications` and its subfolders, `~/Applications`, and the system ones.
It is a suggestion, not a list: any name can still be typed.

A link button draws the site's own favicon. The server reads the page at the origin and takes the
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

Only three kinds exist, and none of them is a shell: `app` runs `open -a <name>`, `url` runs
`open <url>` for an `http`, `https` or `mailto` address only, and `shortcut` runs
`shortcuts run <name>`. The server validates every payload — a name holding a path separator or a
shell metacharacter, or a `file:` or `javascript:` address, is refused — and runs the program with
an argument list, never through a shell.

Minimum size 8 × 4, default 16 × 8.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `buttons` | list of `{ label, kind, target }` | `[]` | both | One row per button, in the order drawn |
| `columns` | number | `4` | both | How many buttons per row |
| `showIcons` | boolean | `true` | both | Draw the icon of an application button, and the site's favicon for a link |

A `buttons` row holds `label` (what the button says; the target is used when it is empty), `kind`
(*Application*, *Link* or *Shortcut*) and `target` (the application name, with suggestions from the
installed applications, the address, or the shortcut's name as Shortcuts.app spells it).

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
is dimmed. Needs a [Homey Pro connection](connections.md#homey-pro).

Minimum size 8 × 4, default 24 × 8. Compact width 6 cells.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`homey`) | — | both | Which Homey |
| `all` | boolean | `false` | both | Show every device instead of the picked ones |
| `devices` | pick (`devices` of `connection`) | `[]` | both | The devices to draw, picked live from the Homey and stored as ids, so a rename in the Homey app changes nothing |
| `zone` | string | `""` | tile | Keep only devices of this zone |
| `max` | number | `12` | tile | How many devices to draw |
| `showZone` | boolean | `true` | tile | Show each device's zone |
| `compactMode` | enum `on` \| `sensor` | `on` | compact | Bar: the number of devices that are on, or the first sensor value |

## homey-flows

*Homey flows* — one large button per flow, plain or advanced, that runs it on tap with a brief
confirmation. A flow switched off in the Homey app is dimmed and refuses the tap. Needs a
[Homey Pro connection](connections.md#homey-pro).

Minimum size 8 × 4, default 16 × 8.

| Setting | Type | Default | Scope | What it is |
|---|---|---|---|---|
| `connection` | connection (`homey`) | — | both | Which Homey |
| `all` | boolean | `false` | both | Show every flow instead of the picked ones |
| `flows` | pick (`flows` of `connection`) | `[]` | both | The flows to draw, picked live and stored as ids |
| `folder` | string | `""` | both | Keep only flows of this folder |
| `max` | number | `8` | both | How many flows to draw |

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
