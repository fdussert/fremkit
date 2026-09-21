# Changelog

What changed for the person using Fremkit, release by release. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver, and the
version is the one `FREMKIT_VERSION` carries — the registry compares a widget's `sdk` against it.

Anything that changes what the dashboard, the admin or a widget can do gets a line under
**Unreleased** in the same commit. A release renames that section, bumps the three `0.x.y`
(`package.json`, `server/package.json`, `server/src/version.ts`) and is tagged `vX.Y.Z`.

## Unreleased

### Changed
- **Homey is a declared connection now.** The Homey connection type built into Fremkit is gone:
  both Homey widgets bring their own, so one API key serves the two of them. An existing Homey
  connection is migrated when the server starts — same name, same address, same key — and the
  tiles keep pointing at it. Nothing to redo. Update *Homey devices* from Sietch to get the
  version that uses it.
- The Homey devices widget lost its device picker: the list of devices came from the connection
  type built into Fremkit, and a declared connection serves none. Name the devices by id, or show
  every device and filter by zone. A selection made with the old picker keeps working.
- A connection form declared by a widget now names every widget that connection would serve,
  rather than only the one that declared it.

### Added
- **Claude sessions: go to the session.** Touch a card and its window comes forward — the
  exact Orca pane, the Terminal.app or iTerm2 tab, the VS Code window on that folder, or at
  least the application — for every session, hooked or merely found running. The card also says which application the session lives in, which is what tells two panes of the
  same folder apart. The hook reports that from inside the session; it stays on the server, and
  the dashboard is told only the kind and the name.
- **Claude sessions can chime.** One of the macOS system sounds when a session starts waiting,
  for a question or for any prompt, played by Fremkit rather than by the widget so you hear it
  when the dashboard is not in front of you. At most one every five seconds.
- A ▶ beside the sound setting plays the chosen sound once, so you pick it by ear. (Any
  widget can offer the same on an `enum` setting: `preview` in its manifest names the command.)
- Three more settings on the Claude sessions widget: show only what is waiting, hide finished
  sessions after 30 minutes (on by default), and group the board by application.

### Added
- A registry package says what each version changed, and the admin shows it: under the chip on a
  card with an update waiting, and beside the permissions in the install, update and *Update all*
  dialogs. An update several versions behind lists every version it is taking. The text is the
  package's own `CHANGELOG.md` entry, carried by the registry as plain text and rendered as text.

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
