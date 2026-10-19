# Fremkit Companion

Fremkit Companion is a browser extension that sends the **video** playing in a browser tab to the
Fremplay widget on your Edge, and gives you touch controls for it there: play and pause, seek
10 seconds, volume, mute, fill the tile, bring the tab back, stop.

It is optional. Nothing in Fremkit needs it except the Fremplay widget, which shows how to get it
until an extension is linked.

It is **experimental** for now, and hidden until you turn it on: in the admin, open
**Settings → About**, click the version number seven times (or focus it and press Enter seven
times), and tick **Browser companion (Fremplay)** under **Experimental features**. Until then the
admin leaves Fremplay out of the widget library and the bar's list and hides the pairing request in
**Settings → Devices**, and the Edge shows no pairing prompt, so no code can be typed. A
browser already linked stays listed in **Settings → Devices** whatever the switch says, so it can
always be renamed or removed.

**Off is Fremplay off.** While the switch (`labs.companion` in the config) is off:

- the Edge draws no Fremplay widget, in a page or in the bar, and a page that held nothing else
  drops out of the navigation. The config keeps them, so ticking the switch again brings them back
  where they were;
- the admin's canvas still shows them, greyed and labelled *Fonction désactivée* / *Feature turned
  off*, so they can be deleted as usual;
- the server refuses a share (`tab.refused` with reason `disabled`), and ends the one running when
  the switch goes off. It tells every connected extension in its `ready` (`modules: { fremplay:
  false }`, sent again when the switch turns), so the popup says *Fremplay est désactivé dans
  Fremkit (fonctions expérimentales).* / *Fremplay is turned off in Fremkit (experimental
  features).* with **Send** greyed, and the shortcut flashes `!` and leaves that message for the
  popup;
- a pairing request is turned down (*Activez le compagnon dans les fonctions expérimentales de
  Fremkit.* / *Turn the companion on in Fremkit's experimental features.*), a browser already
  linked included, since the Edge would show nobody the request.

That is a product switch, not a security boundary: the server does not rely on it for security. The
companion routes, the socket's challenge and the refusal of the `companion` channel to paired
devices guard the same way whether it is on or off, and a browser linked before you turned it off
stays linked, its socket connected, until you remove it.

## What you need

- A Chromium browser: Chrome, Edge, Brave or Arc. Firefox and Safari are not supported.
- Fremkit running, and a screen with the Fremplay widget on a page.

## Install

The extension lives in `companion/` in this repository. Until it is published on the Chrome Web
Store, load it unpacked:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Press **Load unpacked** and choose the `companion/` folder.
3. Pin the Fremkit icon to the toolbar if you like.

The extension's ID is fixed by the `key` in its manifest: `lnckeodobpbbmfbdlpnegjpchgkehdlk`. That
is the ID the store listing will have (publication is pending), so a link made with the unpacked
copy keeps working when you switch to the store version. The server answers that extension only:
any other extension is refused (403) before it can ask to pair, and the Edge and **Settings →
Devices** show the first characters of the asking or linked extension's ID (*extension lnckeo…*).
That short ID only tells extensions apart (Companion from a developer's copy). It cannot tell
Companion from a program on this Mac that sends Companion's ID in its requests: to anything that is
not a browser the `Origin` is just a header, so such a request shows *extension lnckeo…* too.

If you work on the extension with a different `key` (so a different ID), list your ID in
`FREMKIT_COMPANION_EXTENSION_IDS` in the server's environment: comma-separated IDs, each 32 letters
from `a` to `p`; anything else in the list is ignored, with a warning in the log. The listed IDs are
let in on top of Companion's.

The extension speaks to `127.0.0.1:4242` only, and its manifest asks for that origin alone
(`host_permissions`), not every port on the Mac. To pair it with a development server on another
port (`FREMKIT_PORT=4301`, say), edit your local copy: `PORT` in `companion/worker.js` and the port
in `host_permissions` in `companion/manifest.json`, then reload the extension.

## Link it to Fremkit

1. Click the Fremkit icon and press **Connecter à Fremkit** (*Connect to Fremkit*).
2. A four-character code appears on the Edge, and in the admin under **Settings → Devices**. The
   popup does not show it: it asks *Tapez le code affiché sur l'Edge* (*Type the code shown on the
   Edge*).
3. Type the code in the popup and press **Valider** (*Confirm*). That is the approval: there is no
   Allow button. **Refuse** on the Edge (or in the admin) drops the request.

The code is valid for two minutes, and Fremkit takes at most five pairing requests a minute, from
all extensions together, and three from any one install. One request waits at a time: pressing
*Connect* again in the same browser replaces your own, but another extension asking meanwhile is
told *Another pairing request is already waiting on the Edge*. A refused request makes that browser
wait a minute before asking again. The extension's name on the Edge is the browser's (Chrome,
Microsoft Edge, Brave, Arc, Opera, Vivaldi or Chromium), never a text of its choosing.

A wrong code is refused (*Code incorrect*); three tries and the request is refused (connect again
for a new code). After five requests refused that way within a day, pairing is locked: new
requests are told *Pairing locked after too many wrong codes. Unlock it in Settings → Devices.*
until you press **Unlock pairing** in **Settings → Devices**. The lock survives a restart of
Fremkit. If the wrong codes were not yours, something on this Mac has been guessing. Any program on this Mac can post a pairing request, and Fremkit cannot tell it
from yours: a request you did not start is one to refuse, not one to type a code into. Refuse
carries the code it showed, and Fremkit turns it down (*The request changed: check the code*) if the
request waiting is no longer that one.

The code never travels: the extension proves it knows it, Fremkit proves it back with the
credential, and the extension keeps the credential only if that proof checks and came within two
seconds; otherwise the popup says *The server on this port is not your Fremkit*. See [SECURITY.md](../SECURITY.md#a-browser-extension)
for the exchange and what that credential is.

Each time it connects, the extension first has the server prove that it holds this extension's
record, and sends its credential only then: another program listening on the port in Fremkit's
place cannot learn it, and the popup says *The server on this port is not your Fremkit*. Pairing is
bound to the real Fremkit by the code: with the helper, the Edge only ever shows a page from a server
that passed the helper's access proof, so a program holding port 4242 when you press **Connect**
(Fremkit was not running, or was restarting) cannot put a code there, cannot prove it knows the one
you type, and gets no credential. Without the helper (Fremkit run from a terminal, the dashboard in
a plain browser window) there is no such check: whatever answers on the port also serves the page
on the Edge, and could show a code of its own. So:

- Type a code only from the Edge, never from anywhere else, and only for a request you started.
- On a setup without the helper, pair only while you know Fremkit itself is running.
- If the popup says the extension was removed and you did not remove it in **Settings → Devices**,
  do not reconnect: another program may be answering instead of Fremkit. Quit it, or restart the
  Mac, and the extension finds Fremkit again on its own.

Linked extensions are listed in **Settings → Devices**, where you can rename or remove them.
**Remove every iPad** and **Reset the certificate** leave them linked.
Removing one closes its connection at once, and the extension goes back to showing the **Connect**
button; link it again the same way.

## Send a video to the Edge

Play a video, then either click the Fremkit icon and press **Envoyer sur l'Edge** (*Send to the
Edge*), or press **⌃⇧F** (Control-Shift-F). Press it again to stop. The shortcut can be changed at
`chrome://extensions/shortcuts`, or from the extension's options page.

- **The picture is cropped to the page's main video**: the largest video element visible in the
  tab, playing or not, without its sound; one that has something to play comes before an empty
  placeholder, whatever their sizes. The page decides where that video sits, so a page that
  makes it cover the whole tab sends the whole tab's picture, frames from other sites included.
  Whatever it shows, the picture only goes to your own dashboard on this Mac.
- **The sound stays in the browser.** The Edge shows the picture; volume and mute act on the
  Mac's output by default, or on the video in your browser when the widget's **Volume buttons**
  setting says **Video** (and whenever the Mac's volume cannot be read).
- The Edge **switches to the page holding the Fremplay widget**. If the Edge's screen has no
  Fremplay widget, the popup tells you so and nothing is sent. A dashboard that stayed loaded is
  moved once per share; one that has just loaded (the kiosk after a restart of Fremkit) turns to
  that page once when a share shows within its first 15 seconds (the browser takes a few seconds
  to bring its share back), and leaves you where you go next.
- **On the Mac's Edge only.** A Fremplay widget on a paired iPad's screen shows *Fremplay ne
  s'affiche que sur l'Edge du Mac.* / *Fremplay only shows on the Mac's Edge.* and nothing else:
  the picture goes peer to peer between addresses of this Mac, and the iPad's copy of the widget
  gets no WebRTC and no `companion` channel. With the switch off, the iPad leaves its Fremplay
  widgets out as the Edge does: its view of the config carries `labs.companion`, and nothing
  else of the experimental switches.
- The browser can be in the background, on another tab or another desktop. Quitting it, or
  closing the tab, ends the share.
- The video travels directly between the browser and the Edge over WebRTC, between addresses of
  this Mac only: loopback, or the Mac's own (the Fremplay widget dials nothing else, and the
  server refuses to relay any other). It does not go through the Fremkit server and it does not
  leave your machine.
  A share with no sign of life for ten seconds (the tab moved on to a page without a video) is
  cleared.

### Players from another site

Some videos play in a frame from another site (Dailymotion embeds, for instance). The first time you
share one, the popup names **that site** (*Fremplay needs access to … to find the video*), and
pressing the button lets the browser ask you to allow it. The extension cannot look inside the frame
before you do, so check the name: unless the share starts and that site's frame holds a video, the
extension gives the permission back as the attempt ends. A grant is per site, and you can revoke it
at any time in `chrome://extensions`. The extension asks for no access to every site at install.

## Limits

- Chromium browsers only.
- Video only, never audio: the picture of the page's main video, which a page can make as large
  as the whole tab.
- Video protected by DRM (some streaming services) is not promised to work: the browser may hand
  over a black picture.
- If the server restarts during a share the video keeps playing, and the controls come back when
  the extension reconnects.

## Troubleshooting

- *"Install Fremkit Companion in Chrome, then tap Connect"* — no extension is linked. Link one
  as above.
- *"Browser closed or extension inactive"* — the linked extension is not connected. Open the
  browser; if it is open, click the icon, which wakes the extension.
- *"The video is not coming through: stop the share and start it again"*
- *"The server on this port is not your Fremkit"* (in the extension's popup) — something else
  answered on Fremkit's port and could not prove it is your Fremkit, so the extension kept its
  credential to itself. Quit whatever else uses port 4242 and start Fremkit; the extension
  keeps trying on its own.
- *"The Edge refused the video connection"* (in the extension's popup) — the browser offered an
  address that is not one of this Mac's (a network interface that changed during the share, for
  instance), and Fremkit relays nothing else. That widget gets no picture and says *The Edge
  refused this video connection* until the next share, without asking again; the share goes on for
  any other widget watching it, and the toolbar icon flashes **!**. Send the video again.
- *"Fremplay and Fremkit speak different versions: update Fremkit"*
