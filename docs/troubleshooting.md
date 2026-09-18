# Troubleshooting

Most problems are one of three things: a macOS privacy grant that was never given, a grant that
was silently dropped when the helper was rebuilt, or another app holding the touch panel.

The helper's menu tells you which: it shows state lines such as "Server: running", "Touch: active"
and "Notifications: active" above the toggles, and *Log…* opens the supervised server's output at
`~/Library/Logs/Fremkit/server.log`.

## Quick table

| Symptom | Cause | Fix |
|---|---|---|
| "Touch: permission missing" | Input Monitoring not granted to *this build* of the helper | Add "Fremkit Helper" under Privacy & Security → Input Monitoring, then relaunch it |
| "Touch: taken by another driver" | Touchscreen Gestures, another driver or a `--probe` run holds the panel | Quit it, and unload its launchd agent so it does not come back |
| "Fence: permission missing" | Accessibility not granted | Add "Fremkit Helper" under Privacy & Security → Accessibility, then relaunch it |
| Permissions reset after every rebuild | Ad-hoc signature: a new code identity each build | Run `scripts/create-signing-identity.sh`, rebuild, grant once more |
| Printer unreachable (`EHOSTUNREACH`) while `ping` and `curl` work | Local Network not granted to the app that runs the server | Allow it under Privacy & Security → Local Network |
| "Server: external" | Something already answers port 4242, so the helper steps aside | Expected under `pnpm dev`; otherwise stop the stray server, or turn *Manage the server* off |

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

Grants only take effect on the **next launch** of the helper: after ticking a box, quit it from
the menu bar and open it again.

## Touch does not work

1. **Input Monitoring.** The driver reads the panel's raw HID reports and cannot open it without
   the grant. The menu says "Touch: permission missing".
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

- **Fremkit Helper**, when the helper manages the server (the normal case);
- **your terminal** (Terminal, iTerm, Ghostty…), when you run `pnpm dev` yourself.

Without the grant, every connection to a LAN device fails as `EHOSTUNREACH`. This is the usual
cause of a Bambu printer or a Homey that looks perfectly reachable.

**Neither `ping` nor `curl` is a witness.** Both are Apple's own binaries and both are exempt from
the filter — on the same address, from the same shell, `curl` answers 200 while Node gets
`EHOSTUNREACH`. So the test that means something is: `ping` or `curl` reaches the device but
**Node** — the server, or a script — does not. That is the grant missing on the app that runs
Node: Fremkit Helper for the live server, your terminal for anything you run yourself.

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

## Holding the page dots does not open the admin

The long press asks the helper to open its admin window over the `fremkit://admin` URL scheme,
which LaunchServices only knows about once a helper bundle declaring it has been installed.
A helper built before the scheme existed simply ignores the request. Reinstall it:

```sh
pnpm helper:build && pnpm helper:install
```

Then quit the helper from the menu bar **F** and open it again from `~/Applications`. In an
ordinary browser the same press opens `/admin` in a new tab and needs no helper at all.

## The menu says "Server: external"

Something already answers port 4242, so the helper steps aside rather than starting a second one.
That is exactly right under `pnpm dev`. Otherwise stop the stray server, or turn *Manage the
server* off in the menu and run it yourself.

## Red banner in the admin, nothing saves

`data/fremkit.json` is valid JSON that the server cannot interpret, so it runs on defaults and
refuses to save over your file rather than overwriting it. Repair or remove the file — a good copy
may be in `data/fremkit.json.bak`, written when a v1 file was migrated — then restart the server.

## Two admin tabs disagree

Saving is last-writer-wins on the whole configuration: every change is a `PUT /api/config` of the
entire document, grouped over 300 ms. Two tabs open at once will overwrite each other. Close one,
and reload the other.

## Deleting a connection is refused

`DELETE /api/connections/<id>` answers 409 and names the widgets that still point at the
connection. Remove them, or change their `connection` setting first.
