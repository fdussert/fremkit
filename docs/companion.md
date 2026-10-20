# Fremkit Companion

Fremkit Companion is a browser extension that sends the **video** playing in a browser tab to the
Fremplay widget on your Edge, and gives you touch controls for it there: play and pause, seek
10 seconds, volume, mute, fill the tile, bring the tab back, stop.

It has two modules, both optional: **Fremplay** (above) and **Fremdev**, which shows the errors of your
development tabs on the Edge (see [Fremdev](#fremdev-your-development-tabs)). Nothing in Fremkit
needs the extension except the Fremplay and Fremdev widgets, which show how to get it until an
extension is linked.

It is **experimental** for now, and hidden until you turn it on: in the admin, open
**Settings → About**, click the version number seven times (or focus it and press Enter seven
times), and tick **Browser companion (Fremplay)** under **Experimental features** (Fremdev has its own box there, **Fremdev (development tabs)**, and needs the companion ticked as well). Until then the
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
  widgets out as the Edge does: its view of the config carries `labs.companion` and `labs.fremdev` (so Fremdev's tiles are
  gated the same way), and nothing else of the experimental switches.
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

## Fremdev: your development tabs

Fremdev is the extension's second module (extension version 0.2.0). It watches the development tabs
of your browser and lists them in the built-in `fremdev` widget on the Edge: for each tab, its
JavaScript errors, its failed requests and whether its dev server answers, with a red, orange or
green light. Tap a row to unfold it to that tab's history and its **Copy report** buttons (see [The
history and the bug report](#the-history-and-the-bug-report)); **Show tab** brings that tab forward.
The **×** on a row marks its errors and failed requests as seen: the counters stay, dimmed, and the
light turns hollow until a new one comes in or the tab reloads (green means a page with nothing open
since its last load or hot update). It is experimental and behind its own switch, `labs.fremdev`, on top of `labs.companion`
(Fremdev runs only while both are on, `fremdevEnabled`): with either off the server reports Fremdev
as disabled (*Activez Fremdev dans les fonctions expérimentales* / *Turn Fremdev on under
Experimental features*), the widget is left out like Fremplay's, and `ready` announces
`modules.fremdev: false`. Turning a switch sends every connected install a fresh `ready`. A config
that already places a Fremdev widget starts with `labs.fremdev` on.

### Turn it on

Open the popup and turn **Fremdev** on. Chrome shows **one prompt** that covers everything it
needs: the `webRequest` permission (optional in the manifest, so it is not asked at install) and
access to the development hosts below. Nothing is asked when the extension is installed or
updated, and the extension uses no `webNavigation` permission. Turning Fremdev off keeps the
permissions, so turning it on again asks nothing; revoke them at `chrome://extensions` if you want
them back. Pages already loaded keep the hook they were given until they reload (see below).

### Which tabs are watched

- Always: `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` and `*.test`, on any port, over http or
  https.
- Your own hosts, added on the extension's options page: an exact host (`dev.example.com`) or one
  `*` in the first label (`*-dev.example.com`, `*.example.com`). Adding one asks Chrome for that
  origin only, and removing it gives that permission back, unless another pattern or grant still covers it. Nothing else is listed by default.
- Refused as a pattern: a wildcard over a common public suffix (`*.co.uk`; the list is short, and
  Chrome's own permission prompt names the hosts for any other), over numeric labels (an IP range),
  a built-in host, and anything with more than one `*`.
- **Fremkit's own ports (4242 and 4243) are never watched** on the loopback hosts, so the admin open
  in the browser is not a dev tab. Another port (a second checkout on 4301) is a real dev server and
  is watched.
- A tab counts only inside an origin Chrome granted. A host with no grant is never seen, and
  **requests to hosts that are not dev hosts are not seen** either: an API on another domain called
  from your dev page does not appear.

### What is watched, and what leaves the tab

Watched: `console.error` calls, uncaught errors, unhandled promise rejections, the dev server's
connection signals (Vite and webpack-dev-server lines such as *server connection lost*), failed
requests (network errors and HTTP 4xx/5xx) and main-frame loads that fail because the server is
down; and, timed but never counted as failures, requests that took a second or more and the
requests in flight (see [Slow requests](#slow-requests-and-requests-in-flight)). Not counted: `favicon.ico`, hot-update traffic (`/@vite/*`, `/__webpack_hmr`,
`/sockjs-node/*`, `*.hot-update.*`) and aborted requests.

What goes to Fremkit, over the extension's authenticated socket to `127.0.0.1:4242`, is per tab: the
**page's title** (or its host:port when it has none, clipped to 120 characters) and its
**host:port**, counters, and for each of the tab's **last 20 events** (errors and failed requests,
newest first, each open, seen or resolved, plus a `limited` entry when a burst was rate-limited) a
**kind and a text clipped to 300 characters**; for an error, its **origin**, the first stack frame
as `file:line:col` (the file's path when it is the page's own, `host/path` for another origin); for
a request, its **method**, the HTTP status and the URL's **path only**: request URLs never go with
their query or fragment (in an origin either), and nothing is taken from bodies, headers or cookies.
The row's performance values and a `perf` entry are numbers only (see
[Performance](#performance-and-regressions)).
An error's **full stack stays in the extension**: it is not in what the Edge receives, and leaves
the browser only in a report you asked for (below). The title and an error's own message are free
text and go as the page set or logged them, clipped, so a title or an error that quotes a token
would show it on the Edge. Error events are forwarded at most ten per second per tab (the counter
keeps counting) and the tab list at most twice a second. Nothing leaves your Mac, and nothing is
sent while Fremdev is off.

Each entry carries a number of its own (`id`), counted up within the tab for as long as the tab is
open, so the Edge can name one entry. A row also says which **dev server** served the page:
`vite`, `next`, `webpack` or none known. A small script beside the relay, in the extension's own
isolated world, reads the page's script tags once the document has loaded (and the nodes added
during the next 30 seconds): a module script ending in `/@vite/client` is Vite, a script under
`/_next/` is Next, a script whose path names `webpack-dev-server`, or that server's overlay
element, is webpack-dev-server. It reads attributes only and runs none of the page's code. The
Only scripts from the page's own origin count. The kind is kept for the tab's origin: a
client-side route change keeps it, each fresh load of the page looks again (and may find another
dev server on the same port, or a Vite client whose base cannot be used, which reads as none
known), and a navigation to another origin forgets it. **Only the kind leaves the
extension**: for Vite, the base path the client script is served under (`/app/`) is kept in the
extension to build that dev server's own URLs, and is never sent; a base with an empty or a dot
segment (`//x/`, `/../`) is refused, so those URLs can only name the tab's own origin.

**Build errors.** A third script in the same isolated world reads the dev server's error overlay
when it shows a **compile error**, and the tab gets a `build` entry, counted among its errors (the
light turns red), shown on the Edge with "Build" before its text:
- **Vite**: the `vite-error-overlay` element's open shadow root, its message, its file
  (`path:line:col`) and, when the message is empty or blank, its code frame;
- **webpack-dev-server**: the overlay's iframe, only while its heading says *Compiled with
  problems* or *Failed to compile*, and only its first `ERROR` (a warning is no failed build): the
  message, and the file, line and column of its `ERROR in ./src/index.js 2:0` header (webpack counts
  columns from 0; the entry counts them from 1);
- **Next**: inside `nextjs-portal`'s shadow root, the dialog labelled *Build Error* only: its
  message, the file its code frame names, and the line and column in that frame.

Runtime errors are the hook's to report: webpack-dev-server's *Uncaught runtime errors* overlay and
Next's runtime dialog add no entry, so an error is never counted twice, and `nextjs-portal` alone
(Next's dev indicator) is nothing. The script reads text and attributes only, through the browser's
own `textContent`, `shadowRoot` and `contentDocument`, never a property the page defined, and runs
none of the page's code. It looks again 200 ms after the overlay last changed, says only what changed,
and at most twice a second: an overlay that re-renders as you type stays one entry (the same
message for the same file, its line and column updated when an edit above it moved it), and an
overlay that shows but has nothing to read yet changes nothing. A different error resolves the one
before it; the overlay going away (`build-clear`), a reload or a hot update resolves it, and one the
history's 20 entries pushed out stops counting. What is sent is the message clipped to 300
characters, the file as the overlay names it (an absolute path under Vite, `./src/…` under webpack
and Next) and its line and column.

**Home folders read `~`.** Whatever leaves the extension (the Edge, the report, the popup) writes a
home folder `/Users/<name>/` as `~/`: in the page's title, an error's text, origin and stack frames,
a request's path, and a build's text and file. Inside a path the slash before it stays
(`/@fs/Users/<name>/a.js`, Vite's URL for a file outside its root, reads `/@fs/~/a.js`), a request
path that starts with it reads `/~/…`, and a name cut by the 300-character clip or by a line break
(`…/Users/Jane Ex`) reads `~`. This happens before anything is clipped for the wire. The extension
keeps the full values for itself.

### The history and the bug report

Tap a row's top line on the Edge and it unfolds to that tab's last 20 errors and failed requests
(and the `limited` entries that stand for errors dropped by the rate limit), newest first, scrolling
inside the row; only one row is unfolded at a time. Each entry shows its kind, text, method and
status, and for an error its origin. **Line and column numbers are those of the code the dev server
sent**: Fremdev does no source-map lookup, so a bundled or transpiled file reads as the browser
reports it. The **×** still marks the row's issues as seen (the light turns hollow); it does not
empty the history.

**Copy report** puts a Markdown bug report for that tab on the Mac's clipboard: the page, the open
issues and the history, at most 48 000 characters (the oldest entries are dropped first, then
stacks). **Copy with stack** adds each error's stack. From the Edge, the widget sends a `report`
command; the server asks the extension for the text, waits at most 5 seconds, and writes it to the
clipboard with `pbcopy`, the text going through its standard input. The extension's popup has the
same button for each tab, with a *stack* checkbox, and writes the clipboard from the popup itself.
At most 8 reports can be pending per install. The report is built in the extension and goes nowhere
else: only to the clipboard, when you press a button. It is available while Fremdev is on and
`labs.companion` and `labs.fremdev` are ticked, for a tab the extension reported, and only from the Mac itself, never
from a paired device.

The popup also has **Copy screenshot**, on the row of the tab it was opened on: the popup's
`activeTab` grant lets it capture that tab (`tabs.captureVisibleTab`, PNG) and write the image to
the clipboard itself, so it needs no permission of its own. There is no such button on the Edge: a
capture needs a grant that only a click on the extension (the popup or its shortcut) gives, and the
Edge's tap is not one.

**⌃⇧S** (Control-Shift-S; *Fremdev : copier une capture de l’onglet de développement* / *Fremdev: copy
a screenshot of the development tab*) does the same from the keyboard, without opening the popup, and
the Mac puts the image on its clipboard. The key press is the `activeTab` grant. The extension takes
the focused window's active tab, and only a dev tab it has a row for, while Fremdev is on and its
socket to Fremkit is open and greeted; otherwise the badge flashes **!** and nothing is sent. It
captures the tab as a JPEG (quality 85); a capture over 2 MiB is drawn again with its long side at
most 1920 pixels, at JPEG quality 0.85, then 0.7, then 0.5, and one that still does not fit is not
sent. It posts the JPEG to `POST /companion/dev/shot` with its pairing token, without cookies or
cache, and the badge flashes **✓** in gold when the server answered 200, **!** on anything else. The
module is announced as `fremdev.shot`.

The server takes the shot only from this Mac (the route is not on the remote listener), from
Companion's origin with that extension's own token, while `labs.companion` and `labs.fremdev` are on
and the install is connected, on and lists `fremdev.shot` (409 otherwise); a body over 2 MiB is 413,
one that does not start like a JPEG (`FF D8 FF`) is 415, and a second shot while the first is being
written is 429. The token is sent only on a socket that was greeted, so only once the socket's
challenge proved that port 4242 is Fremkit. The server writes the image to a temporary file in the
data folder (0600, never over an existing file), runs `/usr/bin/osascript` with a constant script and
the file's path as an argument, and removes the file whether that worked or not. The shortcut can be
changed at `chrome://extensions/shortcuts`; the options page shows both the Fremplay and the Fremdev
shortcut.

### Open in editor

In an unfolded row, a build entry's file, and under Vite an error thrown by a script on the page's
own origin, is a button (under a dev server Fremdev recognised): tap it and the dev server opens that file at that line in your editor
(*Envoyé à l’éditeur* / *Sent to the editor* for 2 seconds; *Impossible d’ouvrir ici* / *Can't open
here* when it could not). It shows only for an install that lists `fremdev.open`. The widget sends
an `open` command naming the tab and the entry's id; the server asks the extension (`dev.open.ask`)
only when the tab's last `dev.tabs` still lists that id, and waits at most 5 seconds for its
`dev.open.done`. The extension looks the entry up in its own copy of the tab, builds the URL from the
tab's origin and that entry, and asks the dev server's own endpoint, one per kind:

- **Vite**: `<base>__open-in-editor?file=<file>:<line>:<col>`. A build entry's file is the overlay's
  full path; an error's is its origin's path, decoded, the base stripped, `/@fs/` made absolute again
  and otherwise relative. Vite resolves a relative file against its process's working directory (in
  practice the project folder): a project run with its `root` elsewhere opens the wrong path, and
  still says *Sent to the editor*. An error from another origin opens nothing.
- **Next**: `/__nextjs_launch-editor?file=<file>&lineNumber=<n>&column=<n>&line1=<n>&column1=<n>`,
  for build entries only (Next 15.5 reads `line1` and `column1`, earlier releases the other two).
- **webpack**: `/webpack-dev-server/open-editor?fileName=<file>:<line>:<col>`, for build entries only.

The request is a `GET` without credentials, cache or redirects, and its body is never read. The
endpoint answers whether or not an editor opened (Next says 404 for a file it does not find), so
*Sent to the editor* means the dev server answered. Which editor opens is the dev server's choice:
`LAUNCH_EDITOR` for Vite and webpack, `REACT_EDITOR` (or `VISUAL`, `EDITOR`) for Next. This URL is
the only thing that carries a home folder in full, and it goes only to the tab's own dev server. An
entry that left the 20-entry history, or a tab that went to another origin since (its history starts
over), opens nothing.

### Reload

In an unfolded row, two 56 px buttons reload the tab: *Recharger* / *Reload*, and *Recharger sans
cache* / *Reload without cache* (the browser's hard reload). They show only for an install that lists
`fremdev.reload`. The widget sends a `reload` command naming the tab and `bypassCache`; the server
relays `dev.reload` to that install only when it reported the tab, and the extension calls
`tabs.reload(tabId, { bypassCache })` for a tab it has a row for. Nothing runs in the page. The reload's
own navigation resolves the row's open entries as any navigation does.

### Slow requests and requests in flight

Fremdev times a dev tab's requests with the `chrome.webRequest` permission it already holds, from
`onBeforeRequest` to `onCompleted` or `onErrorOccurred`, with Chrome's own timestamps. It times only
the requests of a tab it has a row for, to a dev host, and not the noise listed above. A `websocket`
(Vite's hot-reload socket, for instance) is never timed; a redirect counts from the first request.
Nothing in the page runs for this, and nothing is read from bodies, headers or cookies.

- A request that **succeeded** (a status under 400) in **1 second or more** adds a `slow` entry to
  the history: its method, its path (no query or fragment, a home folder written `~/`) and how long it
  took, in milliseconds up to an hour. The same method and path again, while that entry is open,
  folds into it: its count goes up, it takes the latest duration and comes back to the top. A slow
  request counts in **no tally and never changes the light**; it resolves and is marked seen like the
  others. The history keeps at most 5 slow entries, and a new one never pushes out an open or seen
  error, failed request or build entry: it takes the place of the oldest slow entry, else of the
  oldest resolved one, else it is not kept. A long poll or an EventSource that answers within 1 to
  30 seconds is a request that took that long, and shows as slow each time it does. A request that failed is a failed request, never a slow one. The Edge writes the duration
  in seconds with one decimal; the report lists them under *Requêtes lentes* / *Slow requests*.
- The row carries `inFlight`, the requests started and not finished, at most 999, sent on the same
  twice-a-second throttle as the rest (a change in it alone does not wake the socket). The widget
  shows *n en cours* / *n in flight* beside the tab's name while it is above zero. **A request still
  pending after 30 seconds stops counting** and is forgotten, so a long poll or an EventSource that
  never finishes stays neither in flight nor slow. A navigation within the same origin (a reload, a
  client-side route change) keeps the count, as the requests still pending are still timed; a
  navigation to another origin sets it to 0 and forgets the tab's timings, as the tab closing does. At most 4 096 requests are timed at once,
  all tabs together, the oldest dropped first. The timings live in the extension's memory only.

An install that times requests lists `fremdev.slow`; an older one sends neither, and its rows read
0 in flight.

### Performance and regressions

A third script in the extension's isolated world of a dev tab, `fremdev/perf.js`, reads the page's
performance timeline, which that world sees as the page does, and calls no page code:

- **load**: the navigation entry's `loadEventEnd`, in ms, once the load event has ended;
- **LCP**: the latest `largest-contentful-paint` entry, in ms;
- **CLS**: the sum of the `layout-shift` values, leaving out the shifts right after an input;
- **long tasks**: the `longtask` entries (50 ms or more) since the page started;
- **heap**: `performance.memory.usedJSHeapSize` in MB, where Chrome has it. Chrome rounds it off and
  refreshes it rarely: it is shown dimmed and never judged.

The observers are buffered, so what happened before the script ran counts. The script sends these
numbers, rounded and bounded (load and LCP up to ten minutes, CLS up to 100, long tasks up to
100 000, heap up to 64 GB), **at most once a second and only when one changed**; the worker drops an
event with a value out of its bounds. The values belong to the document Chrome says sent them (its
`documentId`, which stays in the extension): a client-side route change keeps them, a reload's new
document replaces them with its own, and a navigation to another origin forgets them. The row
carries them as `perf`, never trimmed, and the Edge writes them on one dimmed line above the unfolded
row's history (*Chargement 1,2 s · LCP 0,8 s · CLS 0,02 · 3 tâches longues · 45 Mo*), a poor value in
the danger colour. The report has a *Performance* line under its header.

**Regressions.** The extension keeps, per origin and path (never the query), the load and LCP of the
last 5 loads, in `chrome.storage.session.fremdevPerf`: at most 50 origins and paths, the least
recently used dropped, gone when the browser closes or Fremdev is turned off. The first event of a
load that carries its load time is judged against them, then added to them; every later event of
that load is judged on the poor bands alone, and the load's own sample follows its LCP as it grows
after the load (it is replaced where it is, never added twice). A load is a regression when:

- its LCP, then its load, is at least **1.5 ×** the median of the previous loads *and* at least
  **500 ms** slower (each needs at least one previous value of its own); or
- its LCP is over **4 s**, or its CLS over **0.25** (the "poor" Web Vitals bands).

A regression adds one `perf` entry to the history (*LCP 1,8 s, ×1,6 plus lent* / *LCP 1.8 s, ×1.6
slower*; *CLS 0,30, mauvais* / *CLS 0.30, poor*), counted in the **requests tally**: the light turns
**orange, never red**, and the tally's last failed request stays as it was. A later verdict of the
same load updates that entry, rather than adding another, only when it ranks as high or higher (LCP
slower, then load slower, then LCP poor, then CLS poor): a poor CLS never hides an LCP twice as
slow. The entry is marked seen and resolves like the others (a reload, a hot update), and a page
(one document) is flagged at most once, even once its entry has left the history. An entry the
20-entry history pushes out while open or seen is taken off the tally. With no failed request to
show, the folded row writes the regression beside the requests count, and the count's resolved
label reads *n signalés, résolus* / *n flagged, resolved* rather than calling it a failed request.
The report lists the regressions under *Performance*.

An install that reads performance lists `fremdev.perf`; an older one sends no values, and its rows
read none.

### The hook in the page

To see a page's errors, Fremdev registers a small script that runs in the page's own world, before
the page's scripts, on dev hosts only. It is built not to disturb the page:

- `console.error` still prints: the original is called first, and the wrapper keeps its name and
  `toString`. Errors still propagate (no `preventDefault`), and `fetch` is not wrapped.
- It never runs the page's code to describe a logged value: no getters, no `toJSON`. A `Proxy`'s
  introspection traps (`ownKeys`, `getOwnPropertyDescriptor`, `getPrototypeOf`) may run, within the
  walk budget; the text of an object is a bounded walk, so it is
  less faithful than the browser console's.
- **Stacks are read without running page code.** The hook captures V8's native `stack` getter at
  start and calls it with `Reflect.apply`, only for an error whose `name` and `message` are plain
  strings and only while the page has not set `Error.prepareStackTrace` (a page that did, such as
  one using source-map-support, gets no stack, and the origin then comes from the `error` event's
  `filename`, `lineno` and `colno` for an uncaught error; a `console.error` or an unhandled
  rejection then has no origin). A stack is kept to 10 frames of at most 300 characters and 2000
  characters in all, as `fn file:line:col`, with a query or fragment never kept.
- It speaks to the extension through a `CustomEvent` on `document` that carries a string, not a
  window message and not an attribute on `<html>`, so it cannot loop through the page's handlers or
  cause a hydration warning.
- **A page can forge events into its own row** by dispatching that event itself. That only changes
  what the Edge shows for that tab: the extension takes the tab from Chrome, not from the event.
- **Turning Fremdev off does not unhook pages that are already loaded**; the hook stays inert
  there and goes away on the next reload.

### Server side

Rows are published on `companion:dev`, a channel of its own so that Fremplay does not replan at
every update. It is **local-only and built-in-only**, like `companion`: paired devices and registry
widgets never receive it. An extension's reports are bounded and validated by a strict schema, and
an install's rows are published at most four times a second. A report the server cannot read costs
itself, never the socket (which also carries Fremplay's share): a row outside the schema is left
out and the others are kept.

A browser stays listed in the widget once it has connected since Fremkit started, even while its
socket is closed: the extension closes it whenever no dev tab is open, and the widget then says
*No development tab open* rather than *Extension offline*, which it says only while no linked
browser has connected yet. On a paired iPad the widget says *Fremdev only shows on the Mac's Edge*:
the channel never reaches a paired device.

### Reconnection

While a dev tab is open the extension keeps its socket, and pings every 20 seconds. If Fremkit is
not running, it tries again at each of those ticks (and on a dev event, at most every 15 seconds),
with no give-up, for as long as a dev tab stays open; these attempts never put a warning on the
toolbar icon. A Fremkit that answers but does not speak Fremdev
(0.5.0) or has it off is asked again on the next dev event, at most every 15 seconds, and after
three such answers in a row at most every 5 minutes; opening the popup, or a Fremkit that says yes,
goes back to the faster pace.

### Versions

The protocol number stays `2`. Fremdev is negotiated by capability: the extension sends its
`modules` in `hello` and only talks Fremdev (`dev.tabs`, `ping`) when Fremkit's `ready` says
`modules.fremdev`. Fremkit 0.5.0 with this extension keeps Fremplay, and the popup tells you that
Fremdev needs a newer Fremkit; an old extension with a newer Fremkit simply has no Fremdev.

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
- *"Update Fremkit to use Fremdev."* (popup; in French *"Mettez Fremkit à jour pour utiliser
  Fremdev."*) — the Fremkit you run predates Fremdev; Fremplay still works.
- *The Fremdev widget shows no tab* — Fremdev is off in the popup, the tab's host is not a dev host
  (add it on the options page), or Chrome has not granted its origin. Tabs already open are hooked
  when you turn Fremdev on, add their host, or reload or update the extension: no reload of the
  tab is needed. After an extension update, though, an open page keeps the previous version's hook until that
  tab reloads (the new hook stands aside so no error is counted twice), so a changed hook reaches a
  tab only after it reloads.
