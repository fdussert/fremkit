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
- **Messages verification-code provider.** Adds the local, default-off provider for the companion
  [Sietch Messages widget PR #16](https://github.com/fdussert/fremkit-sietch/pull/16); the widget
  is not bundled here, and its trusted integration remains separate. When integrated, codes are
  written as concealed, temporary, current-Mac-only pasteboard content. The provider schedules a
  conditional clear after 60 seconds; if cleanup startup or execution fails, it attempts an
  immediate conditional clear. If macOS refuses both cleanup attempts, the code may remain on the
  pasteboard. A cleanup startup failure is returned as a generic copy failure; a later cleaner
  failure is logged without exposing the code.

- **Recent Projects.** Remembers canonical working directories reported by Herdr panes and opens a
  selected folder in a new pane, optionally starting Claude Code or Codex from a known executable
  location.

- **Paste Pad provider.** Answers the `paste-pad` command channel: a button copies its saved value
  onto the pasteboard as a transient entry, then sends ⌘V — and an optional Return — to the field
  that has focus on the main display. Values come only from the widget's own saved settings, so a
  button cannot be made to paste something the user never typed.



- **Translate Selection reaches editors that hide the selection.** Apps that never publish
  `AXSelectedText` — GPU-rendered editors, terminals — still answer ⌘C, so when the Accessibility
  read comes back empty the widget copies the selection instead of giving up. The translation is
  then pasted back over the still-selected text, replacing it in place; it also stays on the
  pasteboard for a second ⌘V.

### Fixed

- **Tapping the Edge dashboard no longer steals the keyboard.** The dashboard window took the
  key focus on every tap, so the app you were typing into on the main display lost it and a
  shortcut such as ⌘V landed in the dashboard. The window is now a non-activating panel that
  never becomes key; touches still reach the page.
- **The Claude limits tile finds the sign-in again.** Recent Claude Code versions keep the OAuth
  credentials in a keychain item whose name carries a config-dir suffix
  (`Claude Code-credentials-8047733a`), while the plainly named item can hold MCP data instead.
  The provider now looks through every `Claude Code-credentials*` item for the one that has the
  token, instead of reporting "not available on this Mac".
- **The clipboard widget masks one-time codes.** A six-digit code copied from a text message or
  an authenticator (`482913`, `482 913`, `4829-1375`) showed in full on the Edge and on a paired
  iPad; any run of four to eight digits copied on its own is now shown as a secret, and still
  copies back with a tap. Numbers inside a sentence and phone numbers are shown as before.
- **The clipboard widget leaves alone what more password managers copy.** Besides the standard
  "concealed" and "transient" markers, a copy from 1Password, KeeWeb, Butler, Typeit4me or a
  Keyboard Maestro generator is no longer recorded at all.
- **List settings rows reorder by drag.** Each row of a list setting — a Paste Pad button, a
  clock city — carries a grip on its left edge: grab it and drop the row where it belongs. The
  up/down chevrons stay for keyboard reordering.

## 0.5.0 — 2026-10-19

### Added

- **Reload a screen's dashboard from the admin.** **Reload the dashboard**, in the right-click
  menu of the canvas (the screen being edited) and of a screen in the selector above it, and in
  ⌘K, reloads every page showing that screen: the Edge, a browser tab, a paired iPad. Until now
  only the helper's status menu could, and only on the Edge.
- **iPad and extra screens are experimental until the iPad app is available.** Until you tick
  **iPad and extra screens** under **Experimental features**, the admin hides **Settings → Devices**
  and, on a dashboard with a single screen, the screen selector with its **+ Add a screen**;
  importing a layout skips its iPad screens and says so. To show the option, click the version
  number in **Settings → About** seven times (or focus it and press Enter seven times). Unticking it
  hides the same things again. Whatever the option says, a dashboard with several screens keeps
  its selector and **+ Add a screen**, and **Settings → Devices** stays in sight while pairing is on
  or an iPad is paired, so it can always be switched off or the iPad unpaired. A dashboard that
  already has several screens or an iPad screen starts with the option on. A backup restore or
  a restored version keeps the option as it is on this Mac.
- **The iPad follows the brightness set for its screen.** What you set in the admin or with the
  Brightness widget, the day/night schedule included, is applied on the iPad, which reports its own
  level back, so a change in Control Center shows in the admin. When the app is closed or not open
  on that screen, the controls say so within 30 seconds. The iPad also switches to the night theme
  and back on time, rather than at its next reload.
- **The Fremkit iPad app pairs on its own.** Scan the QR code the admin shows, or open its
  `fremkit://` link from the Camera app; without the camera, pick the Mac in the list, check that it
  shows the same four words as the iPad, and type the code; the code only works for the Mac whose
  key the iPad sees, so another machine on the network cannot pass it on. Opening a link while the iPad is paired
  asks before replacing the pairing. The iPad reports the size its dashboard really gets, so it lands
  on the matching screen. After **Reset the certificate**, the iPad says the Mac's key has changed
  and offers **Pair again**. When the address it uses goes away (the Ethernet cable unplugged), the
  iPad finds the Mac at its other network addresses by itself, even when the local network's name
  lookup fails.
- **A fingerprint for your Mac's key.** Under the pairing code, the Devices section shows four words
  derived from the Mac's key; a device that shows the same four words is talking to this Mac. The Mac
  is also announced on the network under its computer name rather than "Fremkit", with its address,
  so an iPad finds it even where the Mac's `.local` name does not resolve.
- **Alignment guides in the editor.** While you drag or resize a widget, or move it with the arrow
  keys, thin accent lines show where its edges or its centre line up with another widget's, or
  with the screen's edges and centre.
- **Select several widgets at once in the editor.** Shift- or Cmd-click adds a widget to the
  selection, dragging on the empty canvas draws a selection rectangle, and Cmd+A selects the whole
  page. Selected widgets move together with the mouse or the arrow keys (locked ones stay where they
  are), and duplicate, copy and paste (keeping their arrangement), lock, change opacity or title,
  move to another page and delete together — from the keyboard, their right-click menu or the
  inspector, each undone in one step.
- **See a widget before placing it.** Hovering a card of the editor's widget library (or reaching
  it with Tab) shows its preview with its name, what it does, its default size and what it may
  read, control and reach.
- **Demo mode acts out the Sietch's widgets too**: Codex sessions and quotas, local AI models, a
  MuteDeck meeting, a Synology NAS, a Homey's devices and flows and an Elgato Key Light all show
  invented data, so they can be tried and get preview images without any account or device.
- **Every built-in widget has a preview**, taken with `pnpm widget:preview` against the demo
  server, so none of it shows anybody's real data.
- **Pictures in the Sietch.** A registry widget that publishes a preview shows it as a thumbnail on
  its row of the Sietch, before you install it.
- **`pnpm widget:preview`.** Takes a widget's preview image for you: it renders the widget alone at
  its default size against a demo server, waits for it to show data, and writes `preview.webp`
  into its folder. Works on the built-ins (`--all`) and on your own widget (`--dir`). See
  [docs/writing-widgets.md](docs/writing-widgets.md#a-preview-image).
- **Widget previews in the manifest.** A widget may name a `preview` image (`preview.webp` or
  `.png`, at most 200 KB, twice its default size in pixels). The installer refuses a package whose
  preview is missing or is not the image it claims to be, and `pnpm widget:check` checks its
  dimensions and warns when a widget has none.
- **Demo mode.** `pnpm demo` (or `FREMKIT_DEMO=1`) starts a server that shows a full, moving
  dashboard of invented data — calendar, CPU, music, weather, Claude sessions, GitHub and Azure
  DevOps runs, Dock badges — without reading anything off the Mac or any account, in a data folder
  of its own. For screenshots, App Store review of the iPad app, and trying Fremkit out. See
  [docs/demo-mode.md](docs/demo-mode.md).
- **Command palette.** ⌘K (or Ctrl+K, or **Commands** in the top bar) opens a search field over
  the editor that reaches everything it can do: add a widget to the page, go to a page or a
  screen, select a widget by its name, open a connection, jump to a widget's setting by its label,
  run the fix of a widget that needs attention, and every command of the menus — the selected
  widget's right-click menu with its submenus (type "move work" to send it to the page Work), the
  page's and the screen's, undo, redo, Edit/Test, the theme, the history, export and import,
  diagnostics. Accents and case do not matter; ↑ ↓ choose, Enter runs, → opens a submenu, Escape
  closes. With nothing typed it starts with the last commands you ran.
- **Keyboard shortcuts sheet.** Press `?` in the editor, or pick **Keyboard shortcuts** in the
  command palette, to see every shortcut of the editor in one place.
- **Tab through the page's widgets.** In the editor, Tab and Shift+Tab select the next and the
  previous widget of the page, top to bottom; the arrows then move it a cell at a time and
  Shift+arrows resize it. Holding an arrow down is one step to undo, not one per cell.
- **Dashboard history.** Settings → History & backup (or the button next to undo) lists every saved version
  of the dashboard for the last month, by day, with what changed in each — pages, widgets,
  screens, theme. Open one to see its pages and restore it in two taps; the version it replaces
  stays in the list, so a restore is undone the same way. The version before a backup restore or
  a Fremkit update is always kept. Your privacy settings, widget permissions and secrets stay as
  they are.
- **Widget health in the editor.** A widget that cannot work — not installed, its connection
  deleted, incomplete or refusing its credentials, its data source out of reach, or no connection
  chosen yet — wears a red or orange dot on its tile in the editor, with the reason in its
  tooltip. Select it and the reason sits above its settings with the button that fixes it (open
  the connection, open the setting, install…); its right-click menu starts with **Fix:**. The
  pages list and the screens selector mark where such a widget is, and the top bar counts them:
  click the count to list them all. An update is not a problem: a widget with a newer version in
  the registry wears a small arrow in the theme's accent instead, its inspector says which
  version is available beside an **Update** button, and its menu offers **Update to vX**; the
  Sietch button counts updates. It follows the dashboard live; a widget whose page has not been
  on screen since Fremkit started has nothing to report yet.
- **Share a page, a screen or your whole setup.** **Export page…** in a page's right-click menu,
  **Export screen…** and **Export the whole setup…** in a screen's, or **Settings → Share → Share your setup**
  write a `.fremkit-layout.json` holding the pages, the bar, the tiles' look and settings, the
  theme and the background images. The export shows what is in the file before you download or
  copy it: connections, secrets, host names, e-mail addresses, device names, privacy choices and
  brightness schedules never are, and settings typed as free text (a label, a link) go in only
  if you tick them. **Import a layout…** — or dropping the file onto the editor — shows what it
  adds, offers to install the widgets you do not have from the Sietch (asking what they may do,
  as always), asks which of your connections a widget should use, and adds the pages or screens
  beside yours unless you choose to replace them. One ⌘Z takes the whole import back.
- **A theme for the night.** Under the theme list, pick another theme for the night and when it
  takes over: at sunrise and sunset where you are, or at fixed times — the same choice as the
  screen brightness's day and night, and its place is offered when it has one. The dashboard,
  the editor, a paired iPad and every widget switch together, with a crossfade, and a screen
  turned on at night starts with the night theme.
- **A background per page.** A page can have its own colour or image, shown instead of the
  screen's while that page is on screen, with a short crossfade when you swipe between pages
  that differ. Set it in the editor's right column when no widget is selected, or from
  **Page background…** in the canvas's right-click menu; **Use the screen's background** puts the
  screen's back. The screen settings name the pages that override its background. Backups carry
  page backgrounds like any other.
- **Right-click menus on the rest of the editor.** On a page in the list: rename, duplicate, page
  background, copy to another screen (as new widgets with the same settings, laid out for that
  screen), move up or down, delete. Pages now reorder by dragging, which the grip at the start of
  each row says, and a row shows a single "…"
  on hover instead of five buttons. On a widget in the library: add it to any page, add it to the
  bar, and for a widget from the Sietch, show it there, update it or uninstall it. On a bar widget,
  in the preview or in the Screen settings: its settings, move left or right, remove. On a page of
  the bar in the preview, that page's menu; on the bar itself: new page, add a widget to the bar,
  the bar's settings. On a screen
  above the canvas: rename it in place (or double-click it), its settings, delete it.
- **Right-click menus in the editor.** A right click on a widget opens a real menu, like a Mac
  app's: show title, appearance (opacity presets, colours, background image, reset),
  copy and paste a widget's style, duplicate, copy and paste, move it to another page or screen,
  show it on another screen too, default or minimum size, open its connection, about the widget
  (version, where it came from, what it asks for, an update when one is waiting), reload it, and
  remove it. A right click on the empty canvas pastes, adds a widget, makes a page or opens the
  screen settings. The menus work from the keyboard as well.
- **Copy and paste widgets.** Cmd+C copies the selected widget and Cmd+V pastes a new one with
  the same settings and look on the page you are on, on any screen.
- **Lock a widget in place.** From its menu or the inspector: a locked widget can no longer be
  dragged, resized or nudged in the editor, and wears a small padlock.
- **Several screens per dashboard** (an experimental feature for now, see above). Add a screen in
  the admin, empty or pre-filled from another one, and give each its own layout. A pre-fill is shown
  as a preview first, naming the widgets that do not fit the new screen, and the Screen panel gives
  each screen its own address. A widget shown on more than one screen is the same widget: edit its
  settings once and every screen follows. Removing it from one screen keeps it on the others; on its
  last screen the admin names it and asks before deleting it. The widget library lists what your
  other screens show, to place the same widget here, and a tile shown on several screens wears the
  number of screens.
- **Choose page names in the bar.** Each screen can keep the familiar page dots or show
  scrolling names with a current-page marker. Arrows move by a visible page, and the admin
  reserves room for compact widgets. Page taps still work with the admin gestures
  (@FlorianBruniaux, #18).
- **Pair an iPad** (Mac side, an experimental feature for now, see above). **Settings → Devices**
  turns on an encrypted listener on the local network, shows a pairing QR code, lists the paired
  devices with the screen each shows, and unpairs one after you confirm. An iPad screen is created
  from the paired iPad, at its exact size. The iPad app is described above;
  [docs/devices.md](docs/devices.md) walks through it.
- **Screen brightness.** A new built-in *Brightness* widget sets the brightness of the screen
  the dashboard is on, from a tile or from the bar, by sliding a finger along it; the
  helper's menu has the same slider. It works over DDC/CI on Apple silicon Macs; a display that
  does not answer DDC says so instead of failing silently. In **Settings → *a screen* → Brightness**, each
  screen can switch between a day and a night level at sunrise and sunset (computed on the Mac
  from coordinates you type, or find with a city search that asks Open-Meteo only when you press
  *Search*) or at fixed times, with a gradual change, and can follow
  the Mac's built-in screen and its light sensor. With both on, the screen follows the Mac with
  the night level as a ceiling; a change by hand holds until the next switch or until the Mac's
  brightness moves noticeably, and *Back to automatic* ends it at once.
- **Only Fremkit itself sets the brightness.** A widget from the registry may show the screen's
  brightness, but one that asks to change it is refused at install: the built-in widget, the
  admin and the helper's menu are what set it. A paired iPad can never change the Edge's
  brightness, only that of its own screen.
- **Widget SDK generation 3.** `Fremkit.screen` names the screen a widget is drawn on, for
  widgets whose data differs from one screen to the next, and `Fremkit.holdSwipe()` keeps the
  page from turning while a finger slides a widget's control past its edge.
- **Search the widgets.** A box above the editor's widget list filters it by name, description
  or category as you type, accents or not ("meteo" finds Météo); Enter adds the first match. The
  pages and the search stay in place while the widget list scrolls under them. The Sietch's
  search ignores accents too now.
- **Tidy the widget list.** Two buttons beside the Widgets title open or fold every shelf at once,
  and a box hides the widgets the selected screen already shows, on a page or in its bar.
- **Copy diagnostics for a bug report.** **Settings → About** prepares a report to paste into a
  GitHub issue: the versions, the widgets and connection types in use with their state, and the
  recent server log. Secrets, IP addresses, e-mails, host names and the names you gave things are
  removed, and the report is shown before you copy it. A link opens the bug form. The menu bar
  **F** has **Copy diagnostics** too, which adds the helper's side (touch, permissions, the
  kiosk display, DDC) and still copies that part when the server is down.
- **For widget authors: live reload.** Start Fremkit with `FREMKIT_WIDGET_DEV=1` (`pnpm dev`
  does) and it also reads the widgets in `data/widgets-dev/` — or the folder
  `FREMKIT_WIDGET_DEV_DIR` names — with the permissions their manifest asks for. Saving a
  widget's file reloads it on the dashboard and in the admin's previews; saving its manifest
  reads the catalogue again first. A shipped Fremkit watches nothing.
- **For widget authors: `pnpm widget:new` and `pnpm widget:check`.** `pnpm widget:new my-widget`
  asks for a name in French and English, a category, a size and the data channel it reads, then
  writes a working widget into that folder — transparent background, theme accent, compact and
  light-tile layouts, every text in both languages — and has a running server pick it up.
  `pnpm widget:check <folder>` applies the registry's and the installer's rules to a widget
  before you open a pull request on the Sietch.
- **End-to-end tests, for contributors.** `pnpm e2e` drives the admin and the dashboard in
  Chromium (and WebKit when installed) against a throwaway server per worker: the library,
  editing with the mouse and the keyboard, every right-click menu, ⌘K, undo, export and import,
  the history, widget health, swipes and the night theme, and a security smoke test. Pull
  requests run it in CI. See `docs/contributing.md`.

### Changed
- **The widget inspector keeps the widget's name in view**, with *Expand all* / *Collapse all* for
  its sections, while they scroll.
- **The Sietch keeps its tabs, search and filters in view** while its list scrolls, with *Expand all*
  / *Collapse all* for its shelves. Escape in its search clears the search before it closes the
  window.
- **Settings, in a window of their own.** The top bar's *Screen* button is now *Settings*, and it
  opens a window laid out like the Mac's: every screen on the left, each with its own settings
  (name, layout and bar, bar widgets, background, brightness, kiosk address), then the app's panes —
  General (the language), Appearance (theme and night theme), Share, History & backup, Privacy,
  Devices and About. The search above them finds a setting in any pane ("opacity", "kiosque",
  "backup"), accents ignored, and shows only what it found; Escape clears it. A pane's title and its
  *Expand all* / *Collapse all* stay in view while its sections scroll. *Screen settings…*,
  *Navigation bar settings…* and the command palette open the window on the right pane.
- **Page dots fit many pages.** With many pages, the dots of the navigation bar draw closer
  together instead of running over the bar's widgets, down to a size a finger can still hit.
- **Upgrading the dashboard file.** Your dashboard is converted to the new screens layout the
  first time this version starts, and the previous file is kept as `data/fremkit.v3.json` — the
  file as it was at that first upgrade, never overwritten after: to go back to an older version,
  put it back as `data/fremkit.json`, knowing that changes made since are not in it.
- **From a checkout, rebuild and reinstall the helper** with this version
  (`pnpm helper:build && pnpm helper:install`): an older helper does not recognise the new
  server, has no access secret and cannot set the brightness. The app updates both at once.
- **Adding a screen** creates an Edge screen; an iPad screen is now created from a paired iPad.
- **Taking a widget off a screen says where it still is.** When another screen (an iPad, say) still
  shows it, a note names that screen and page, with **Show me** to go there — so a widget you
  thought you had deleted no longer keeps a "to fix" badge without a clue why.

### Fixed
- **The server no longer freezes every two seconds.** Reading the disks and the memory for the
  CPU, memory and disk widgets stopped the whole server for about 70 ms each time; they are now read
  without blocking, and the disks once a minute, since free space does not move faster than that.
- **A restarted Fremkit gets the iPad port back.** A server that was told to stop could keep
  holding the remote access port for minutes, so the one replacing it said the port was used by
  another application and turned remote access off. The old one now lets go of both ports as soon
  as it is told to stop and is gone within three seconds whatever it was doing, and the new one
  tries the port again every second for ten seconds before saying it is taken; at startup it then
  leaves remote access on, so the next start tries again.
- **Right-clicking a widget in the bar of the editor's preview opens its menu in Safari and in
  the Mac's admin window too.** WebKit sent the click to the widget itself, so nothing opened.
- Escape in a right-click menu opened inside a dialog (the Screen panel's bar widgets) closes
  the menu only, not the dialog under it.
- **The install instructions say `pnpm run setup`.** They said `pnpm setup`, which runs pnpm's
  own command instead: it edits your shell profile and never sets Fremkit up.
- **A connection used only by the navigation bar is protected.** A widget shown only in the bar
  now keeps its connection from being deleted; before, the connection could be removed while the
  bar widget still used it.

### Security
- **The dashboard asks for a key.** Fremkit's server now answers only callers that show a secret
  made fresh each time the helper starts, so a web page or another account's program can no
  longer read your dashboard or change it. The Edge and the admin window keep working with
  nothing to do. In a browser, open the admin from the **F** menu (*Open the admin in the
  browser*), or from a checkout with `pnpm open`; typing `127.0.0.1:4242` by hand now shows a
  page saying so.
  Scripts calling the server read the secret from
  `~/Library/Application Support/Fremkit/access-4242.token` (see the README).
- **An iPad pairs only from your local network, and only while a code is showing.** With
  *Allow an iPad on the local network* on, the Mac now answers only private and link-local addresses
  (and itself): a public address, IPv4 or IPv6, and Tailscale get no answer. A VPN that hands out the
  same private addresses as a home network cannot be told apart from it and still reaches the Mac,
  though not without a pairing code or a paired iPad's key. Pairing answers
  only while the admin shows a code; the iPad says so when the code has run out, so make a new one.
  Wrong codes are counted per address (per network prefix for most IPv6 addresses), and when the
  Mac answers "too many tries" on one of its addresses the iPad tries the others, so a single machine
  guessing no longer keeps your iPad from pairing. Scanning the QR code can no longer be blocked at
  all: it carries a long one-time secret that pairs even while the Mac is refusing codes. A machine
  guessing from many addresses at once can still hold the typed code until it stops; scan the QR code
  instead.
- **A browser holds a session, not the key.** Signing a browser in now gives it a session of its
  own that ends after a day unused, after a week at most, or when Fremkit restarts, instead of
  the key itself. Another program listening on your Mac can no longer pick the key up from the
  browser's cookies.
- **Fremkit checks it is talking to itself.** Before the menu-bar helper hands over its key or
  shows a page, the server on port 4242 has to prove it holds the key. Another program that took
  the port while Fremkit was restarting is no longer shown on the Edge or as the admin; the **F**
  menu says the port is held by another program, and Fremkit takes it back once it is free. The
  key also changes every time the server starts, and is removed when it stops.
- **Saved passwords no longer pass through a command line.** Tokens and passwords you give a
  connection are now handed to the keychain in a way other accounts on the Mac cannot glimpse.
  Values with accents or line breaks also read back exactly as typed.
- **Setting up the signing identity touches only its own key.** The setup step that lets the
  helper be rebuilt without password prompts used to loosen access to every signing key in your
  login keychain; it now changes the one key it created, and warns if it finds anything else.
- **A widget cannot reach your network by switching addresses.** The widget proxy and the
  site-icon fetches now check the address they actually connect to, so a site whose name points
  somewhere public at first and at your Mac or your network a moment later is refused. Two more
  private IPv6 ranges and one more way of spelling `..` in a connection's path are refused too.
- **The Dock widget opens only what is in your Dock.** Asking it to bring forward an app that is
  not in the Dock is now refused.
- **A Bambu printer's access code stays off the command line.** When the printer was off, the
  camera preview of an X1 or H2 could retry with the access code visible to other accounts on the
  Mac; it no longer does, whatever the printer's state.
- **Fremkit runs macOS's own tools.** The helper and the server now call system tools by their
  full path and put the system folders first, so a program dropped into a Homebrew folder can no
  longer stand in for one of them.
- **Your dashboard's files are yours alone.** Fremkit's data folder and everything in it — the
  dashboard and its backups, the disk map's caches, the Claude caches — can no longer be read by
  other accounts on the Mac; files left by earlier versions are fixed the next time it starts.
- **Restoring a backup keeps your security choices.** A restored archive no longer changes where
  secrets are kept, the privacy switches, or what installed widgets were granted; and an old admin
  tab saving the dashboard can no longer bring back a permission you withdrew.
- **Deleting a connection deletes its secret, always.** A connection whose widget had been
  uninstalled kept its password or token in the keychain after being deleted, and a new
  connection given the same name could pick it up. Both are fixed.
- **Updates are checked before they are unpacked, and the update feed must be signed.** The app
  now verifies an update's signature before extracting it, and refuses an update feed that does
  not carry Fremkit's signature.
- **Another copy of Fremkit cannot touch your saved passwords.** Each Fremkit now keeps its
  secrets in the keychain under a name of its own, so a test copy given a backup of your
  dashboard can no longer read or delete the real one's. Existing secrets move over by themselves.
- **Widgets can no longer use WebRTC.** A peer connection was a way for a widget to send its
  data off the Mac with no network permission and no consent dialog; the constructors are now
  gone before any widget code runs, and a second page of a widget runs no script at all. A
  built-in widget that needs a peer on this Mac can be given a narrow, local-only WebRTC; a
  widget from the registry never can.
- **A widget can no longer send data away by navigating its own frame.** The dashboard and the
  admin now carry a Content-Security-Policy that lets a frame load only a widget page, and that
  no other site can frame them in.
- **The Edge and the admin window refuse it too.** The helper's web views cancel any frame
  navigation that is not a widget page, whatever the page's own policy says.
- **What the dashboard tells a widget stays with that widget's page.** If a widget's frame ever
  holds a different page, that page hears nothing the first one was told.
- **A widget's icon is fetched only from an address you typed.** A default address written in
  the widget's own manifest no longer counts as yours.
- **A setting's ▶ preview stays within what you granted.** A widget can offer a preview only on
  a channel it declares as a command, an installed widget only on one you agreed to, and a
  paired device gains nothing through it.

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
