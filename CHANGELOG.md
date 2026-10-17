# Changelog

What changed for the person using Fremkit, release by release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver, and the
version is the one `FREMKIT_VERSION` carries. A widget's `sdk` is a separate number,
`SDK_VERSION` in `server/src/bridge/sdk.ts`, that moves only when the bridge grows.

Anything that changes what the dashboard, the admin or a widget can do gets a line under
**Unreleased** in the same commit. A release renames that section, bumps the four `0.x.y`
(`package.json`, `server/package.json`, `ui/package.json`, `server/src/version.ts`) and is
tagged `vX.Y.Z`.

## Unreleased

### Added
- **Choose page names in the Edge bar.** Screen can keep the familiar page dots or show scrolling
  names with a current-page marker. Arrows move by a visible page, and the admin reserves room
  for compact widgets. Page taps still work with the admin gestures.

## 0.4.1 — 2026-10-16

### Fixed
- **The disk map no longer looks stuck while macOS asks for access to a folder.** When a scan
  reaches Documents, Desktop, Downloads, iCloud Drive or a removable volume for the first time,
  macOS asks whether Fremkit may open it, and the scan cannot go on until somebody answers — a
  question that could sit unseen behind the dashboard. The tile now says which folder macOS is
  asking about, and its **Show the request** button moves the dashboard out of the way for 45
  seconds so the window can be answered on the Edge; after 30 seconds without an answer, the scan
  goes on without that folder and counts it as unreadable.

## 0.4.0 — 2026-10-16

### Added
- **Fremkit as an app.** A signed, notarized `Fremkit.app`, on a DMG or with
  `brew install --cask fdussert/fremkit/fremkit`, runs the whole dashboard on its own: no
  checkout, no Node, no Xcode tools. Drag it to Applications, open it, grant two permissions.
  Its data lives in `~/Library/Application Support/Fremkit`. Building from source works as
  before and is untouched.
- **Updates from the menu.** The app updates itself through Sparkle, and *Check for Updates…* in
  the menu bar menu asks right away. Updates are signed; the dashboard server stops and starts
  again around the update on its own.
- The Claude Code hook and status line ship inside the app, at
  `/Applications/Fremkit.app/Contents/Resources/scripts/`, for `~/.claude/settings.json` to name.
- **Disk map.** A new built-in widget shows what fills your home folder or a volume, as rings you
  drill into with a finger beside a list of folders and sizes; holding one shows it in Finder.
  A scan runs only when you tap — the tile's **Scan** button the first time, ↻ after that — never on
  a timer, and never deletes anything; two tiles on two roots scan one after the other instead of
  interrupting each other. Folders macOS would not let it read are shown as such, with a button to
  the Full Disk Access settings. The scanner ships inside the helper and runs at low priority;
  without the helper (`pnpm dev`) the disk map falls back to `du`, slower and without single files.
  Only the built-in widget can read it: a widget from the registry that asks for the disk map is
  refused, since it would see your files' names.
- **About.** **/admin → Screen → About** shows the Fremkit version, who wrote it, and links to
  Fremkit's and the Sietch's repositories, which open in your browser, from the Fremkit admin
  window too.
- **RTK token savings.** For registry widgets: the tokens [RTK](https://github.com/rtk-ai/rtk) saved
  today, in total, and over the last 30 days, read from the `rtk` program when it is installed.

### Changed
- **Missing permissions say where to go.** A menu bar line such as "Touch: Input Monitoring
  missing — open Settings…" or "Fence: Accessibility missing — open Settings…" can be clicked: it
  opens the right pane of System Settings → Privacy & Security, with Fremkit listed there. The
  login item waiting for approval opens Login Items the same way.
- **Touch tells you when a relaunch is all it needs.** Once Input Monitoring is granted, touch
  starts by itself within a few seconds; when macOS wants Fremkit reopened before the grant
  applies, the line says "Touch: allowed — quit and reopen Fremkit…", and clicking it does that.
- **The signed app asks for Input Monitoring and Accessibility once more** on its first launch:
  macOS ties those grants to the signature, and the app is signed with the project's Developer ID
  rather than the local certificate of a source install. If the old grant is still ticked and
  touch does not work, run `tccutil reset ListenEvent dev.fremkit.helper` and
  `tccutil reset Accessibility dev.fremkit.helper`, then open Fremkit again.
- The helper reports its real version (it said 0.1.0).
- A helper with touch, the mouse fence and the Dock badges all off no longer asks for
  Accessibility, which none of the three is using.

### Fixed
- **Input Monitoring is asked on a first launch.** Fremkit asked for Accessibility and Input
  Monitoring at the same moment, and macOS, which shows one such prompt at a time, dropped the
  second: touch said "permission missing" and Fremkit was not even listed under Input Monitoring.
  It now asks for Input Monitoring first and for Accessibility once that is answered.
- **Disks counts like Finder.** Sizes were binary gigabytes labelled GB, about 7 % below what
  Finder and Disk Utility show; they are decimal now, and a disk past 1,000 GB reads in TB.
- **One row per disk on Disks.** Volumes that share one APFS disk — the Mac's own and a volume
  added to it, say — each showed the whole disk and the same free space; they are one row now, its
  bar split into a segment per volume and what the system takes.
- **Save a backup from the Fremkit admin window.** **Screen → Backup → Save** did nothing in the
  helper's own admin window, which dropped the download; it now asks where to save the archive,
  as a browser does.
- **Restore a backup from the Fremkit admin window.** **Restore…** there only let you pick images,
  so the archive could not be chosen.

### Security
- **Only the built-in clipboard widget can read the clipboard.** A widget from the registry that
  asks for the clipboard history is refused at install, and one already in `data/widgets` is
  reported as an error and granted nothing: it would see a preview of everything you copy.

## 0.3.0 — 2026-10-15

### Added
- **Codex quotas, usage and chats.** For registry widgets: your Codex account's quotas and token
  usage, and the chats and turns of the local history sources you pick (Codex desktop, VS Code,
  the CLI, subagents). Both start off, under **/admin → Screen → Privacy**, which says that a
  picked source sends chat titles, model and folder or branch labels to every widget that
  subscribes. Fremkit only reads: a chat opens only once it is found in the Codex desktop
  catalog, and turning a source or account reads off also drops what was cached for it
  (@FlorianBruniaux, #14).
- **Local Docker and AI models.** Registry widgets can show up to 200 local containers and the
  Ollama or MLX models running on the Mac. Fremkit refuses remote Docker contexts, tells a
  missing Docker apart from a stopped one, and keeps the container list when stats fail
  (@FlorianBruniaux, #17).
- **CPU temperature on Apple Silicon, if you want it.** Install macmon yourself
  (`brew install macmon`) and tick the box under **/admin → Screen → Privacy**; off by default.
  The reading stays on the Mac, and a slow sample never holds up the other system metrics
  (@FlorianBruniaux, #22).
- **Uptime.** A tile that shows how long the Mac has been up, read from macOS; it says so when
  the system cannot tell (@FlorianBruniaux, #16).
- **Your Claude plan on the Claude limits tile.** When the local Claude CLI reports a known
  subscription, a small badge beside the footer names it, histogram shown or not
  (@FlorianBruniaux, #19).
- **Claude sessions: go to the session.** Touch a card and its window comes forward — the
  exact Orca pane, the Terminal.app or iTerm2 tab, the VS Code window on that folder, or at
  least the application — for every session, hooked or merely found running. In cmux, the card
  selects the session's own panel when the process says which workspace and surface it is in,
  and brings cmux forward otherwise (@FlorianBruniaux, #11). The card also says which
  application the session lives in, which is what tells two panes of the same folder apart. The
  hook reports that from inside the session; it stays on the server, and the dashboard is told
  only the kind and the name.
- **Claude sessions can chime.** One of the macOS system sounds when a session starts waiting,
  for a question or for any prompt, played by Fremkit rather than by the widget so you hear it
  when the dashboard is not in front of you. At most one every five seconds.
- **Hear a sound before choosing it.** A ▶ beside the sound setting plays the chosen sound once,
  so you pick it by ear. (Any widget can offer the same on an `enum` setting: `preview` in its
  manifest names the command.)
- **Claude sessions board options.** Show only what is waiting, hide finished sessions after
  30 minutes (on by default), and group the board by application.
- **GitHub rows open on the Mac.** A saved run, notification or pull request opens from its
  widget without being marked read (@FlorianBruniaux, #13).
- **Borrow the Edge display.** Hide or show the dashboard from the helper's menu without
  quitting it. It stays hidden across display rearrangements, and the mouse fence pauses while
  the Edge is borrowed; touch and data collection go on, and a helper restart brings the
  dashboard back (@FlorianBruniaux, #15).
- **A shortcut button's own icon.** An emoji, the address of an image, or that of a site whose
  icon it borrows — for a link whose site shows its icon only once you are signed in, or one on
  the LAN.
- **Shortcut button backgrounds.** None, the tile's accent, or a colour of your choosing (the
  text picks black or white to stay readable).
- **What an update changes.** A registry package says what each version changed, and the admin
  shows it: under the chip on a card with an update waiting, and beside the permissions in the
  install, update and *Update all* dialogs. An update several versions behind lists every
  version it is taking. The text is the package's own `CHANGELOG.md` entry, carried by the
  registry as plain text and rendered as text.
- **Widget SDK 2.** For widget authors: `Fremkit.sdk` is now `2`, the generation that brought
  `favicon(url)` (a site's icon), `image(url)` (an image whose address the user typed into the
  widget's settings), `installedApps()` (an application name to the bundle id its icon is filed
  under) and `appIcon()` (that icon), the last two for a widget that subscribes to `dock`. The
  host page fetches all four for the widget, whose sandboxed frame cannot. A widget that calls
  them declares `"sdk": 2`, and an older Fremkit then says it needs an update instead of
  installing it broken. Widgets declaring `1` keep installing as before.

### Changed
- **Clock in the compact bar.** An accent-coloured clock icon beside the time, matching the
  weather icon (@FlorianBruniaux, #21).
- **System tiles show what the Mac has left.** Disk usage reads the APFS data volume and shows
  the space available; memory shows available RAM and swap (@FlorianBruniaux, #16).
- **Homey is a declared connection now.** The Homey connection type built into Fremkit is gone:
  both Homey widgets bring their own, so one API key serves the two of them. An existing Homey
  connection is migrated when the server starts — same name, same address, same key — and the
  tiles keep pointing at it. Nothing to redo. Update *Homey devices* from Sietch to get the
  version that uses it. That widget lost its device picker, since a declared connection serves
  none: name the devices by id, or show every device and filter by zone. A selection made with
  the old picker keeps working.
- **A connection form names every widget it serves.** A connection declared by a widget lists
  every widget it would serve, rather than only the one that declared it.
- **The Spotify tile fits its shape.** A row when wide, the transport under the cover and the
  song from 440 × 340, a column when square or taller; minimum size 8 × 4 (@mcouzinet, #4).
- **Shortcut buttons fill the tile.** The rows share its height, and the icons and labels grow
  with them, down to a finger-sized minimum past which the grid scrolls as before.

### Fixed
- **Widgets load on the native dashboard again.** WebKit can now load the bridge and a widget's
  own script, style, image, font and media files inside the sandboxed frame
  (@FlorianBruniaux, #10).
- **The Claude limits tile shows today's tokens and its hourly histogram again.** It reached for
  the bridge's escaping helper by the wrong name, so every render threw where the footer begins
  and everything under the gauges stayed empty (@mcouzinet, #5); and the histogram's bars were
  then laid out with no width, so its row showed only the peak label.
- **Application icons in shortcuts and notifications.** Shortcut buttons draw the real icon of
  an application that is not in the Dock again, and the notifications widget draws its apps'
  icons: a widget frame cannot fetch them itself, so they fell back to a glyph. The host page
  fetches them for it now (@FlorianBruniaux, #12; @mcouzinet, #6).
- **Link icons on the shortcuts widget.** Link buttons show their favicon again: the cross-site
  refusal on the favicon route (0.2.0) also caught the widget's own request, and the host page
  now fetches the icon for it. A site that answers the icon request with anything but HTML — a
  workspace's login page, for one — declares its icon far down a long page head, or turned away
  requests that did not look like a browser's gets its icon too. A site that is down when the
  dashboard loads gets its icon within a minute of coming back; one that yields no icon is left
  alone for fifteen minutes rather than asked on every retry.
- **Fresh data after a provider is replaced.** A tile opened after a widget's data source was
  retired, or after the dashboard reconnects to the server, no longer starts from the retired
  source's last reading. A tile already open keeps its value until the new source publishes
  (@FlorianBruniaux, #24).
- **The helper keeps its permissions across rebuilds again.** On Macs where
  `scripts/create-signing-identity.sh` failed at the import step ("MAC verification failed"),
  the identity was never created, so every build stayed ad-hoc signed and lost the Input
  Monitoring and Accessibility grants of the one before, which shows up as the touch panel
  clicking on another display (@mcouzinet, #8).
- **Spotify's progress bar moves.** On a Mac whose number format uses a decimal comma the
  position read as nothing, and the bar sat at zero. It now glides across each second instead
  of stepping, lands at once on a seek, a new track or a pause, and empties when Spotify closes
  (@mcouzinet, #4).
- **Delete and restore work in the helper's admin window.** Deleting a connection or a page and
  restoring a backup asked with a browser dialog the helper never shows, so the button did
  nothing. The first tap now arms it — red, "Confirm?" — and a second within four seconds does
  it; a refusal from the server shows in the banner.
- **Connections a widget declares can be saved.** Saving one failed with "invalid connection
  id", since the admin built the id from the type's, which a declared type writes with colons.
- **A Homey that refuses its key says so.** It showed as offline, which sent you to check the
  network when the Homey wanted a new key.

### Security
- **Application icons cannot be used to probe the Mac.** Cross-site requests to the icon route
  are refused, and only a widget that subscribes to `dock` gets the list of installed
  applications, so another widget's frame cannot find out what is installed
  (@FlorianBruniaux, #12).
- **Account e-mail addresses stay private by default.** A rule for every provider that reads an
  account: the e-mail address leaves the server only when **/admin → Screen → Privacy → Show
  the account e-mail address** is ticked, and the box is off by default. Until then a widget
  gets the plan and how you signed in, and no widget — one from the marketplace included — can
  show the address or pass it on. In 0.3.0 no provider publishes an address yet, so ticking the
  box changes nothing on screen; it decides for the providers that will.

## 0.2.0 — 2026-09-21

The first release after publication. Fremkit went public on 2026-09-18 with the widgets it had;
three days later it has a registry, themes, and a way for a widget to bring its own connection.

### Added
- **A widget marketplace.** *Sietch* in the admin's top bar lists the widgets published on the
  registry ([fremkit-sietch](https://github.com/fdussert/fremkit-sietch)), shelved by category,
  with the permissions each one asks for. Install, update, remove; *Update all* behind one
  dialog; a badge when updates wait. A package is verified against the hash the registry
  published before a byte of it is read, and an installed widget can do only what the consent
  dialog showed — an update that asks for more asks again.
- **Themes.** A theme is a folder of design tokens the dashboard, the editor and every widget
  read (contributed by @mcouzinet, #2). Two ship — `fremkit` and `edge`; `nuit`, `brume`,
  `terminal` and `papier` are on the registry, installed from *Sietch* like a widget and chosen
  under Screen → Theme.
- **Connections a widget declares.** A registry widget can describe the connection it needs —
  a host you type, a key the core stores, an allow-list of requests — and the core makes the
  calls for it, injecting the key. The widget never sees the secret; the consent dialog says
  which key goes to which host for which requests. First cases on the registry: Key Light,
  Homey flows 2.0.
- **Synology.** A connection type and provider for a DSM NAS (load, volumes, disks, SMART,
  temperature), read by the `synology-storage` and `synology-system` registry widgets.
- **Widget categories** and a library on shelves; an inspector whose sections fold
  (@mcouzinet, #3).
- A **volume knob** you turn with a finger, beside the slider.
- A **default opacity for new tiles**, under Screen → Layout.
- A tile whose widget is not installed says so, and offers to install it from the registry;
  a connection lists the registry widgets that read it.
- Backup and restore of the whole configuration, secrets excluded; `FREMKIT_DATA_DIR` to run
  a second instance beside the live one; `FREMKIT_REGISTRY_URL` under `FREMKIT_DEV=1` to
  install from a registry you are building.
- A default background derived from the project's own artwork, shipped as an ordinary,
  removable one.

### Changed
- **Eight widgets moved to the registry**: `ado-pipelines`, `bambu-job`, `cleanshot`,
  `github-actions`, `github-inbox`, `homey-devices`, `homey-flows`, `mutedeck`. The rule from
  now on: the core ships what works on any Mac with no account, hardware or third-party app;
  everything else is published. Their providers and connection types stay in the core. A
  dashboard that placed them shows "not installed" tiles and a one-press *Install all*; the
  tiles keep their settings.
- The Spotify widget's long press can open the app (a setting).
- The kiosk no longer offers a context menu on long press, or anything else that gives away a
  web page; the admin opens on a long press or a double tap on the dots, as chosen.
- The Sietch and Screen panels keep their height from one view to the next.

### Fixed
- Long press did not work after the context menu was removed (the touch driver sends a right
  click; the page now listens for it).
- The compact service-status popover showed an empty probe.
- A theme's accent did not reach the widgets (#2 follow-up); text on a theme's accent is judged
  against the theme, not the built-in palette.
- Synology: the utilisation answer's `time` is an epoch, not an uptime; the Test button no
  longer spends a one-time code; DSM's login refusals are told apart (disabled account, DSM
  application denied, blocked address, expired password); the account has to be an
  administrator, and the form says so.

### Security
- Pre-publication hardening: SVG favicons refused and byte routes served with a CSP; a global
  Host check and an Origin check on every write; `PUT /api/config` ignores connections and
  secrets; a stored secret never follows a changed host; every widget route carries the
  sandbox CSP; the proxy refuses private addresses on every hop and forces the content type;
  the zip reader is bounded per entry; restore never hands a stored secret to a host an
  archive names.
- The marketplace grants what the user saw: the consent sent is the set the dialog rendered,
  the server refuses a package that asks beyond it, and a bulk update never widens a grant.
- A declared connection's host has one spelling — no userinfo, path, query, port trick or
  trailing dot — and a key is sent to that host only, over https unless the host is private.

## 0.1.0 — 2026-09-18

Published. A Corsair Xeneon Edge widget dashboard for macOS: the kiosk window and touch
driver, the admin editor, twenty-six widgets, connections to Azure DevOps, Bambu Lab, GitHub,
Homey and published calendars, secrets in the keychain.
