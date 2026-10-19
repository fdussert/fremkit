# Troubleshooting

Most problems are one of three things: a macOS privacy grant that was never given, a grant that
was silently dropped when the helper was rebuilt, or another app holding the touch panel.

"The helper" below is **Fremkit** for the app and **Fremkit Helper** for a source install: the
same program, built two ways (see [Where the data lives](#where-the-data-lives)).

The helper's menu tells you which: it shows state lines such as "Server: running", "Touch: active"
and "Notifications: active" above the toggles, and *Log…* opens the supervised server's output at
`~/Library/Logs/Fremkit/server.log`.

## Reporting a bug

Use **Copy diagnostics**, then paste the result into the
[bug form](https://github.com/fdussert/fremkit/issues/new?template=bug.yml). It is in two places:

- the editor, **Settings → About → Diagnostics**: *Prepare diagnostics* shows the whole report
  before *Copy diagnostics* puts it on the clipboard;
- the helper's menu bar **F**: *Copy diagnostics* copies the same report with the helper's own
  part added (touch driver, Input Monitoring and Accessibility, the kiosk display, DDC). When the
  server does not answer, it copies the helper's part alone and says so.

The report holds the Fremkit, Node and macOS versions, the install kind, how many screens, pages
and widgets the dashboard has, each widget in use with its version and whether it is built in or
from the Sietch, the connection *types* and their state, each provider's last error code, the
theme, the number of paired devices and the last 200 lines of the server log.

It never holds a widget's settings or a connection's name, address or credentials. Before it
leaves the server, every line goes through one redaction pass: connection secrets and the access
secret (wherever they appear), bearer tokens and `key=value` credentials, long random strings,
e-mail addresses, IP addresses other than loopback, `.local`/`.lan`/`.home` host names and every
host a connection is configured with, the names you gave connections and devices, the Mac's
names, your account name, and your home folder (shown as `~`). Read it anyway before you post:
the issue is public.

## Quick table

| Symptom | Cause | Fix |
|---|---|---|
| "Touch: Input Monitoring missing — open Settings…" | Input Monitoring not granted to *this build* of the helper, or [never asked](#input-monitoring-was-never-asked) | Click the line: it opens Privacy & Security → Input Monitoring with the helper listed. Turn "Fremkit" (the app) or "Fremkit Helper" (a source install) on. Touch starts within seconds, or the line asks for a relaunch |
| "Touch: allowed — quit and reopen Fremkit…" | Input Monitoring is granted, but macOS applies it only to a relaunched process | Click the line: Fremkit quits (stopping its server as usual) and opens again |
| "Touch: taken by another driver" | Touchscreen Gestures, another driver or a `--probe` run holds the panel | Quit it, and unload its launchd agent so it does not come back |
| "Fence: Accessibility missing — open Settings…" (or the same on the Touch or Notifications line) | Accessibility not granted | Click the line: it opens Privacy & Security → Accessibility, with the helper listed. Turn "Fremkit" (the app) or "Fremkit Helper" (a source install) on; the line clears within seconds |
| "Fremkit can't be opened" / "is damaged and can't be opened" | The download was altered or is not the published one | Download the DMG again from the release page; see [Gatekeeper](#gatekeeper) |
| Input Monitoring and Accessibility asked again after moving to the app | The app's Developer ID signature is a new code identity | Expected once; see [The app asks for permissions again](#the-app-asks-for-permissions-again) |
| Permissions reset after every rebuild | Ad-hoc signature: a new code identity each build | Run `scripts/create-signing-identity.sh`, rebuild, grant once more |
| The helper is ticked in Privacy & Security and still has no permission | One stale grant per past ad-hoc identity, which macOS keeps in its cache and matches before the new one | `tccutil reset ListenEvent dev.fremkit.helper && tccutil reset Accessibility dev.fremkit.helper`, relaunch the helper, and accept the two prompts. Removing and re-adding the app in the list does not clear those entries |
| A widget says "Loading…" or an error on the Edge | Its widget, its connection or its data source is failing | Open the editor: the tile wears a red or orange dot, its inspector says why and offers the fix, and the top bar's count lists every widget that needs attention. A widget whose page has not been shown since Fremkit started has nothing to report yet |
| Printer unreachable (`EHOSTUNREACH`) while `ping` and `curl` work | Local Network not granted to the app that runs the server | Allow it under Privacy & Security → Local Network |
| "Server: external" | Something already answers port 4242, so the helper steps aside | Expected under `pnpm dev`; otherwise stop the stray server, or turn *Manage the server* off |
| Brightness: "not adjustable on this display (DDC)" | The display does not answer DDC/CI on this cable or this Mac | See [Brightness says not adjustable](#brightness-says-not-adjustable) |
| The iPad app does not list the Mac | The router or access point does not relay Bonjour (mDNS) between Ethernet and Wi-Fi, or between bands or VLANs; or the Mac is on both Wi-Fi and Ethernet | Scan the QR code instead (it carries the address), or put both on the same Wi-Fi — [details](#the-ipad-app-does-not-find-the-mac) |
| The disk map says folders could not be read | macOS privacy protection (TCC) refuses the scan some folders | Give Fremkit (or Fremkit Helper, from a source install) **Full Disk Access**, then scan again — [details](#the-disk-map-says-folders-could-not-be-read) |
| The disk map is slow and shows no files, "du (no helper)" | The server runs without the helper, or the helper predates the disk map | Rebuild and reinstall the helper — [details](#the-disk-map-uses-du) |

## Gatekeeper

The app and its DMG are signed with the project's Developer ID and notarized by Apple, with the
ticket stapled to both: macOS opens them without a warning and without a network check. A
warning that it "can't be opened because Apple cannot check it for malicious software", or that
it "is damaged", means the file is not the one that was published — a truncated download, or a
copy from somewhere else. Delete it and download the DMG again from the
[release page](https://github.com/fdussert/fremkit/releases/latest).

To see what macOS thinks of a copy:

```sh
spctl -a -t exec -vv /Applications/Fremkit.app      # "accepted", "source=Notarized Developer ID"
codesign --verify --strict --verbose=2 /Applications/Fremkit.app
```

Never work around it with `xattr -d com.apple.quarantine` or by turning Gatekeeper off: the
check is what tells a genuine copy from a modified one.

## The app asks for permissions again

macOS ties Input Monitoring and Accessibility to the code signature. The app is signed with a
Developer ID, the developer helper with the local "Fremkit Helper Dev" certificate: to macOS they
are two different programs that happen to share the bundle id `dev.fremkit.helper`. The first
launch of the app — and the first launch of a signed release after a self-signed build — asks
for both permissions again. Updates keep the same signature, so it happens once.

If the old entry is still ticked and the app still has no permission, the stale grant of the
other signature is matched first. Clear both and accept the prompts once more:

```sh
tccutil reset ListenEvent dev.fremkit.helper
tccutil reset Accessibility dev.fremkit.helper
```

Then open Fremkit again. The same applies to Local Network, which is asked the next time the
server reaches a device on your LAN.

## Input Monitoring was never asked

macOS shows one privacy prompt at a time. Fremkit asks for Input Monitoring first and for
Accessibility only once that is answered (or after a minute without an answer), so both prompts
should appear on a first launch, one after the other. If only Accessibility was asked, and
Fremkit is not listed under Privacy & Security → Input Monitoring at all:

1. Click **"Touch: Input Monitoring missing — open Settings…"** in the menu bar menu. Fremkit
   asks for the permission once more, which puts it in the list, and opens that pane. Turn
   Fremkit on.
2. If it is still not listed, add it by hand: **+** under the Input Monitoring list, pick
   `Fremkit.app` in Applications (or `~/Applications/Fremkit Helper.app` for a source install), and turn it on.
3. Touch starts by itself within a few seconds. If the line says **"Touch: allowed — quit and
   reopen Fremkit…"** instead, click it: macOS applies the grant only to a relaunched process.

The Accessibility lines ("… Accessibility missing — open Settings…") open the Accessibility pane
the same way.

## Where the data lives

| | The app | A source install |
|---|---|---|
| Dashboard, connections, backgrounds, installed widgets and themes | `~/Library/Application Support/Fremkit` | the checkout's `data/` |
| Helper settings (`helper.json`) | `~/Library/Application Support/Fremkit` | the same |
| Server log | `~/Library/Logs/Fremkit/server.log` | the same |
| Connection secrets | the login keychain, service `fremkit:<hash of the data folder>` | the same |

The app never writes inside itself: its bundle is replaced by every update and its signature
has to stay intact. What decides which server runs is `repoPath` in `helper.json`: present, the
helper runs the checkout's server, exactly as a source install always has; absent, the app runs
the server it carries.

## Moving from a checkout to the app

Nothing moves on its own: a source install keeps working untouched beside a downloaded app, and
the two must not run at the same time (they would fight over the touch panel and port 4242). To
switch:

1. Quit **Fremkit Helper** from its menu bar **F**, and turn its *Launch at login* off first if it
   was on.
2. Copy the dashboard over, if you want to keep it — the app starts empty otherwise:

   ```sh
   mkdir -p ~/Library/Application\ Support/Fremkit
   rsync -a <checkout>/data/ ~/Library/Application\ Support/Fremkit/
   ```

   Secrets are in the keychain, keyed by connection id, so the copied connections find them.
3. Remove the `"repoPath"` line from `~/Library/Application Support/Fremkit/helper.json`.
4. Move `~/Applications/Fremkit Helper.app` to the Trash.
5. Install and open **Fremkit**, grant the permissions again (see above), and turn *Launch at
   login* back on from its menu.
6. In `~/.claude/settings.json`, point the Claude Code hook and status line at the app (see
   [claude-code.md](claude-code.md)).

Going back is the same in reverse: quit Fremkit, run `pnpm run setup` in the checkout (it writes
`repoPath` again and installs the developer helper).

## Removing everything

Quit Fremkit from its menu, turn *Launch at login* off first if it is on, then:

```sh
rm -rf /Applications/Fremkit.app            # or: brew uninstall --zap --cask fremkit
rm -rf ~/Library/Application\ Support/Fremkit ~/Library/Logs/Fremkit
rm -rf ~/Library/Caches/dev.fremkit.helper ~/Library/HTTPStorages/dev.fremkit.helper
rm -rf ~/Library/WebKit/dev.fremkit.helper
defaults delete dev.fremkit.helper
tccutil reset All dev.fremkit.helper
```

The connection secrets stay in the login keychain until you delete them: open Keychain Access
and search for `fremkit`, or `security delete-generic-password -s 'fremkit:<…>'` once per secret
(the full service name is in Keychain Access). If you
added the Claude Code hook, remove its lines from `~/.claude/settings.json`.

## The helper's icon is missing from the menu bar

The helper shows an **F**. If it is not there:

- A menu bar manager (Bartender, Ice, Hidden Bar and the like) may have hidden it. Look in its
  overflow, and move Fremkit to the always-visible section.
- The menu bar may simply be full — macOS drops the rightmost items on a narrow display. Quit a
  few status items and look again.
- The helper may not be running at all. Open it from `~/Applications`; there is no `KeepAlive`, so
  a crash leaves nothing behind.

## Permissions reset every time I rebuild the helper

macOS ties Input Monitoring and Accessibility grants to the code signature. The helper is signed
ad hoc unless a stable code-signing identity exists — and an ad-hoc signature is a *different*
identity on every build, so every rebuild drops the grants you just gave.

`scripts/create-signing-identity.sh` creates a local self-signed "Fremkit Helper Dev" certificate
in your login keychain (`openssl` + `security import` + `security add-trusted-cert -p codeSign`).
It asks for your login password, is idempotent, and is picked up automatically by
`scripts/build-helper.sh`. Another name goes in `FREMKIT_SIGN_IDENTITY`.

Grant the permissions once after that and they survive every rebuild.

Touch picks up an Input Monitoring grant on its own within a few seconds. When macOS applies it
only to a relaunched process, the menu says "Touch: allowed — quit and reopen Fremkit…": click it.

## Touch does not work

1. **Input Monitoring.** The driver reads the panel's raw HID reports and cannot open it without
   the grant. The menu says "Touch: Input Monitoring missing — open Settings…"; clicking it opens
   the right pane.
2. **Another driver has the panel.** Touchscreen Gestures seizes the touch controller
   exclusively; the helper replaces it, it does not coexist with it. Quitting the app is not
   enough while its launchd agent relaunches it:

   ```sh
   launchctl bootout "gui/$UID" ~/Library/LaunchAgents/<its agent>.plist
   ```

   A `--probe` run of the helper does the same thing, so quit the probe too.
3. **Accessibility.** The driver reads the panel itself, but the synthetic mouse and scroll events
   it produces are posted through Accessibility. Without it, touches are read and go nowhere.

`--probe` is the diagnostic: no window, no menu, no synthetic events, just the raw reports and the
decoded gestures on stdout. Quit the helper first, and grant Input Monitoring to your *terminal*
rather than to the bundle.

```sh
"$HOME/Applications/Fremkit Helper.app/Contents/MacOS/FremkitHelper" --probe
```

`x` runs 0 → 16383 left to right and `y` 0 → 9599 top to bottom.

## A LAN device answers `ping` but not Fremkit

macOS 15 and later gate LAN access per application, and the server has no identity of its own: it
runs inside whatever launched it. So the app to allow under System Settings → Privacy & Security →
**Local Network** is:

- **Fremkit** (the app) or **Fremkit Helper** (a source install), when the helper manages the
  server (the normal case);
- **your terminal** (Terminal, iTerm, Ghostty…), when you run `pnpm dev` yourself.

Without the grant, every connection to a LAN device fails as `EHOSTUNREACH`. This is the usual
cause of a Bambu printer or a Homey that looks perfectly reachable.

**Neither `ping` nor `curl` is a witness.** Both are Apple's own binaries and both are exempt from
the filter — on the same address, from the same shell, `curl` answers 200 while Node gets
`EHOSTUNREACH`. So the test that means something is: `ping` or `curl` reaches the device but
**Node** — the server, or a script — does not. That is the grant missing on the app that runs
Node: Fremkit or Fremkit Helper for the live server, your terminal for anything you run yourself.

**After a reinstall the helper may vanish from the Local Network list.** The grant is tied to the
installed bundle, and deleting it drops the grant silently. Reinstall with
`scripts/install-helper.sh`, which replaces the bundle in place, then trigger a LAN connection so
macOS asks again.

## The chamber camera says it is unavailable

- **P1 and A1** serve JPEG frames on port 6000 and need nothing extra.
- **X1 and H2** publish an RTSPS stream on port 322 instead. That needs **ffmpeg** on the machine
  running Fremkit (`brew install ffmpeg`); the tile says so when it is missing.
- The stream also has to be switched on from the printer, under Settings → Camera → **LAN Mode
  Liveview**. With it off the port answers and then refuses the session, and the tile shows its
  placeholder.

See [connections.md](connections.md#the-chamber-camera).

## The disk map says folders could not be read

macOS protects some folders from every application that has not been given access, and the
scanner that measures them runs on behalf of the app that started the server: **Fremkit Helper**
under the helper, your terminal under `pnpm dev`. What it meets there:

- **Refused without a question** — the data of Mail, Messages, Safari, Photos, HomeKit, cookies,
  Spotlight and several system services under `~/Library`, and the containers of other
  applications (`~/Library/Containers`, `~/Library/Group Containers`). On a Mac used every day
  that is commonly several hundred folders, most of them other apps' containers.
- **Asked once, per folder** — Desktop, Documents and Downloads, iCloud Drive, and a removable or
  network volume: macOS shows a "would like to access files in…" dialog the first time the scan
  reaches it, and remembers the answer. A folder you said no to stays unreadable until you change
  it under Privacy & Security → Files and Folders.

While such a dialog waits for an answer the scan cannot open that folder, and the tile says so:
*macOS is asking whether Fremkit may open "Documents" — answer the window on the Mac*. The dialog
can be hidden behind the dashboard on the Edge, so look for it on the other screens too; on the
Edge, the tile's **Show the request** button sends the dashboard behind the other windows for 45
seconds so the dialog can be seen and touched, and it comes back on its own. If nobody
answers within 30 seconds the scan goes on without that folder, which then counts as unreadable;
answer the dialog (or grant access in System Settings) and press ↻ to measure it.

The widget never counts such a folder as small or empty: it is drawn hatched with a lock, listed
as *unreadable*, and the tile says how many could not be read. Its size is simply unknown.

To scan everything, give the app **Full Disk Access**: the widget's **Full Disk Access** button
opens System Settings at Privacy & Security → Full Disk Access; turn on *Fremkit* (the app, from
`/Applications`) or *Fremkit Helper* (a source install, from `~/Applications`), adding it with +
if it is not listed, then press ↻. Full Disk Access also removes the
per-folder dialogs. It is a broad grant — the helper and the server it runs can then read every
file of the account — so it is your call, and the disk map works without it, minus those folders.

Two things that are not permissions: a folder kept only in iCloud (or another File Provider) is
not downloaded to be measured, it counts what it takes on this Mac; and a volume mounted inside
the scanned folder is not entered, exactly like `du -x`.

## The disk map uses du

Under the helper the server runs `fremkit-scan`, which the helper bundles and names in
`FREMKIT_SCANNER`. When the variable is unset, not absolute or not an executable file — `pnpm dev`,
a second checkout, a helper built before the disk map — the server falls back to
`/usr/bin/du -k -x -d 5`: the same rings, but slower, folders only (no single files), and folders
deeper than five levels are rescanned when you drill into them. Rebuild and reinstall the helper
(`pnpm helper:build && pnpm helper:install`) to get the native scanner back.

## The calendar widget is empty or stale

- The address must be `https`, at every redirect hop, and must be the **ICS** link — not Outlook's
  HTML one.
- Fremkit re-downloads every five minutes and caps the file at 5 MB. A calendar larger than that
  is refused; publish a narrower one.
- A download that fails keeps the last events on screen and retries. The connection's **Test**
  button gives the real reason — the widget deliberately does not, because the error text can
  quote the address, which is the credential.
- Only the next fortnight is expanded, so a calendar whose next event is further out really is
  empty.

## The admin's file picker does nothing

An older helper build without a `WKUIDelegate`: a web view ignores `<input type="file">` without
one. Rebuild and reinstall the helper.

## The first tap on the dashboard is lost

The click is spent activating an inactive app. Fixed in the kiosk window
(`acceptsFirstMouse`) — rebuild and reinstall the helper.

## Holding the page buttons does not open the admin

The long press asks the helper to open its admin window over the `fremkit://admin` URL scheme,
which LaunchServices only knows about once a helper bundle declaring it has been installed.
A helper built before the scheme existed simply ignores the request. Reinstall it:

```sh
pnpm helper:build && pnpm helper:install
```

Then quit the helper from the menu bar **F** and open it again from `~/Applications`. In an
ordinary browser the same press opens `/admin` in a new tab and needs no helper at all.

## The browser says "Open Fremkit from the F menu"

The server answers only callers holding its access secret, and this browser does not have it:
the address was typed or bookmarked, or the helper was relaunched since (each launch makes a new
secret). Use *Open the admin in the browser* in the menu bar **F** menu, or `pnpm open` in a
checkout; either hands the browser a one-time link that signs it in. "This link has expired or
was already used" means the link was more than a minute old or had been opened once already: ask
for a new one the same way.

A script getting **401** is missing the `Authorization: Bearer` header, or read the token file of
another port: see [contributing](contributing.md#signing-in-the-access-secret).

## The menu says "port 4242 is held by another program"

Something answers on the port and could not prove it holds Fremkit's access secret, so the helper
sends it nothing and shows nothing from it: neither the Edge nor the admin window load. It is
another program that took the port — possibly while Fremkit was restarting — or a Fremkit server
from an older checkout. Find it with `lsof -nP -iTCP:4242 -sTCP:LISTEN` and stop it; the helper
starts its own server within seconds of the port coming free. If the program belongs to another
account on this Mac and you did not start it, treat that as hostile.

## The menu says "Server: external"

Something already answers port 4242, so the helper steps aside rather than starting a second one.
That is exactly right under `pnpm dev`. Otherwise stop the stray server, or turn *Manage the
server* off in the menu and run it yourself.

## Red banner in the admin, nothing saves

`data/fremkit.json` is valid JSON that the server cannot interpret, so it runs on defaults and
refuses to save over your file rather than overwriting it. Repair or remove the file — a good copy
may be in `data/fremkit.json.bak`, the file as it was before the last save, or among the saved
versions in `data/history/` (one `<time>-<id>.json` per version, `index.json` says what changed in
each) — then restart the server. Once it reads its file again, **Settings → History & backup** restores any
of those versions from the admin.

`data/fremkit.v3.json` is something else: the dashboard as it was the first time a version with
screens started and converted it, kept once and never overwritten. It is the file to use to go
back to an older version of Fremkit: stop the server, put it back as `data/fremkit.json`, and
start the older version. Anything changed since that upgrade is not in it.

## Two admin tabs disagree

Saving is last-writer-wins on the whole configuration: every change is a `PUT /api/config` of the
entire document, grouped over 300 ms. Two tabs open at once will overwrite each other. Close one,
and reload the other.

## Deleting a connection is refused

`DELETE /api/connections/<id>` answers 409 and names the widgets that still point at the
connection. Remove them, or change their `connection` setting first.

## The iPad app does not find the Mac

Pairing is described in [devices.md](devices.md). The app lists Macs by Bonjour
(`_fremkit._tcp`), and there is no field for typing an address, so a Mac that is not listed has a
network reason:

- The router or access point does not relay Bonjour (mDNS) between Ethernet and Wi-Fi, between
  bands, or between VLANs (a guest network does this on purpose). Scan the **QR code** in the
  admin instead: it carries the address and the key, and needs no Bonjour. Or put the Mac and the
  iPad on the same Wi-Fi.
- The Mac is on both Wi-Fi and Ethernet, so its name answers on an interface the iPad cannot
  reach. Same remedies, or switch Wi-Fi off on the Mac.
- **Local Network** was refused on the iPad: Settings → Privacy & Security → Local Network →
  Fremkit. Without it the app sees nothing, and neither does its web view.
- The macOS firewall asked whether Fremkit may accept incoming connections and was answered no:
  System Settings → Network → Firewall → Options.
- Pairing is switched off (admin, *Settings → Devices*), or port 4243 is held by another
  application: the admin says so.

An iPad that shows "This iPad is no longer allowed" was removed in the admin: **Pair again** leads
to the welcome screen. One that shows "This Mac's key has changed" met a different key than the
one it pinned, which is what **Reset the certificate** does: **Pair again** as well (if you did
not reset it, check the network, another machine may hold the Mac's old address). One that cannot
reach its Mac finds it again by itself when the Mac wakes or changes address.

## Brightness says not adjustable

Fremkit sets the brightness of the display the kiosk is on with DDC/CI, the monitor control
protocol carried by the display cable, the way MonitorControl and m1ddc do. The helper's **F**
menu, the `brightness` widget and *Settings → your screen → Brightness* all say why when it cannot:

- **"not adjustable on this display (DDC)"** — the display did not answer. In order of likelihood:
  - DDC/CI is switched off in the monitor's own menu. Turn it on.
  - The cable or port does not carry it: the built-in HDMI port of some Macs (M1 and the
    M2 Pro/Max Mac mini and MacBook Pro among them) does not pass DDC. Use USB-C / DisplayPort.
  - A dock or adapter in between drops it. Try the display on a direct cable.
  - The Mac is an Intel Mac: Fremkit's DDC path is the Apple silicon one.
- **"display not identified for sure"** — the helper found the display but could not tell which
  DDC line is its own (two identical monitors, and macOS did not say which port each is on).
  Nothing is changed rather than risking the wrong monitor. Reconnecting the displays usually
  clears it; say so in an issue if it does not.
- **"no display"** — the kiosk's display is not connected.
- **"Fremkit Helper is not running"** (widget, admin) — brightness needs the helper; a browser
  alone cannot reach the display.
- **"the iPad is not showing this screen right now"** — a device screen's brightness is set by
  the Fremkit app on the iPad bound to it, which reports its level every few seconds. Open the app
  and show that screen; the settings are kept meanwhile and apply as soon as it reports.

*Follow the Mac* needs a built-in display to follow: a Mac mini or Mac Studio has none, and a
MacBook with its lid closed has none in use. The admin says so under the option.

The level may take a moment to settle: monitors drop commands that arrive too close together, so
the helper sends at most ten a second, the last one winning, and reads each one back.
