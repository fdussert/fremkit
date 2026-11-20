# Fremkit Companion

Fremkit Companion is a browser extension that sends the **video** playing in a browser tab to the
Fremplay widget on your Edge, and gives you touch controls for it there: play and pause, seek
10 seconds, volume, mute, fill the tile, bring the tab back, stop.

It has two modules, both optional: **Fremplay** (above) and **Fremdev**, which shows the errors of your
development tabs on the Edge (see [Fremdev](#fremdev-your-development-tabs)). Nothing in Fremkit
needs the extension except the Fremplay and Fremdev widgets, which show how to get it until an
extension is linked.

Fremplay and pairing are always on. Fremdev is **experimental** for now, behind its own experimental
switch, **Fremdev**: in the admin, open **Settings → About**, click the version number seven times (or
focus it and press Enter seven times), and tick **Fremdev (development tabs)** under **Experimental
features**. Until then the admin leaves Fremdev out of the widget library and the bar's list, and a
Fremdev widget already placed stays on the admin's canvas, greyed and labelled *Fonction désactivée* /
*Feature turned off*, but is not drawn on the Edge.

## What you need

- A Chromium browser: Chrome, Edge, Brave or Arc. Firefox and Safari are not supported.
- Fremkit running, and a screen with the Fremplay widget on a page.

## Install

Install **Fremkit Companion** from the [Chrome Web Store](https://chromewebstore.google.com/detail/fremkit-companion/lnckeodobpbbmfbdlpnegjpchgkehdlk): **Add to Chrome**, then pin the
Fremkit icon to the toolbar if you like. Edge, Brave and Arc install it from the same page. The
admin links to it too, under **Settings → Devices**.

### From the source, to work on it

The extension lives in `companion/` in this repository. To run your own copy, load it unpacked
(turn the store version off or remove it first: both have the same ID):

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Press **Load unpacked** and choose the `companion/` folder.
3. Pin the Fremkit icon to the toolbar if you like.

The extension's ID is fixed by the `key` in its manifest: `lnckeodobpbbmfbdlpnegjpchgkehdlk`, the
store listing's own, so a link made with the unpacked copy keeps working with the store version
and the other way round. The server answers that extension only:
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

### Publishing a new version

Bump `version` in `companion/manifest.json`, then `bash scripts/package-companion.sh` writes
`dist/fremkit-companion-<version>.zip`: the folder as it is, without the manifest's `key`, which
the store refuses (it keeps the listing's ID, the same one). Upload it from the listing's
**Package** tab in the Chrome Web Store developer dashboard and submit it for review.

## Link it to Fremkit

1. Click the Fremkit icon and press **Connecter à Fremkit** (*Connect to Fremkit*).
2. A four-character code appears on the Edge, and in the admin under **Settings → Devices**. The
   popup does not show it: it asks *Tapez le code affiché sur l'Edge* (*Type the code shown on the
   Edge*). Fremkit takes the request only while one of those two can show it: the dashboard open
   on the Edge (or in a browser on this Mac), or **Settings → Devices** open in the admin.
   Otherwise it refuses it, and the popup says *Nobody would see the code*; the extension's first
   store release, 0.1.0, knew no such answer and says *Another pairing request is already waiting
   on the Edge* instead (0.1.1 and later say it right).
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
**Remove every tablet** and **Reset the certificate** leave them linked.
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
  gets no WebRTC and no `companion` channel.
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
since its last load or hot update). It is experimental and behind its own experimental switch, Fremdev (`labs.fremdev`,
`fremdevEnabled`): with it off the server reports Fremdev as disabled (*Activez Fremdev dans les
fonctions expérimentales* / *Turn Fremdev on under Experimental features*), the widget is left out
of the library and not drawn on the Edge, and `ready` announces `modules.fremdev: false`. Turning
the switch sends every connected install a fresh `ready`. The switch starts off, a config that
already places a Fremdev widget included; it is on only once ticked. A paired tablet's view of the
config carries `labs.fremdev` and nothing else of the experimental switches, so it leaves Fremdev's
tiles out the same way.

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
  origin only, and removing it gives that permission back, unless another pattern or grant still
  covers it. Nothing else is listed by default.
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
connection and hot update signals (Vite, webpack-dev-server and Next lines such as *server
connection lost*, *hot updated* or *[Fast Refresh] done*), failed requests (network errors and HTTP
4xx/5xx) and main-frame loads that fail because the server is down; and, timed but never counted as
failures, requests that took a second or more and the requests in flight (see [Slow
requests](#slow-requests-and-requests-in-flight)). Not counted: `favicon.ico`, hot-update traffic
(`/@vite/*`, `/__webpack_hmr`, `/sockjs-node/*`, `*.hot-update.*`) and aborted requests.

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
element, is webpack-dev-server. A webpack page's bundle (`main.js`) seldom names its dev server, so
past those 30 seconds the script keeps watching the body's own children, for as long as the page
is open, for that overlay: a page loaded with a clean build is known as webpack the moment an edit
breaks the build, and its build entry can then be opened in the editor. It reads attributes only
and runs none of the page's code.
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
  (`path:line:col`), its code frame (the message itself when that is empty or blank) and its stack.
  An error thrown on a hot update (a Vue file broken while the page is open) has no file in the
  overlay (`unknown file:3:15`) and no frame of its own: the file is then the message's line that is
  an absolute path, the frame the message's lines from its first `N |` one, and the line and column
  those of that frame's caret (the file's own, which open in editor uses), else the path line's,
  else the overlay's, else the message's `(3:15)`. *A known Vite limitation:* for a Vue file,
  @vitejs/plugin-vue counts the `3:15` from the start of the `<script>` block, not of the file. On a
  hot update the caret corrects it; on a page loaded with the build already broken the overlay
  names the real file at that `3:15`, draws its own frame from it (so the frame starts at the wrong
  lines), and nothing on the page says the real line: the entry keeps Vite's position, and a
  `<script>` that is not at the top of the file opens a few lines too high;
- **webpack-dev-server**: the overlay's iframe, only while its heading says *Compiled with
  problems* or *Failed to compile*, and only its first `ERROR` (a warning is no failed build): the
  message, the code frame it ends with (from its first `N |` line), and the file, line and column of
  its `ERROR in ./src/index.js 2:0` header (webpack counts columns from 0; the entry counts them
  from 1);
- **Next**: inside `nextjs-portal`'s shadow root, the dialog labelled *Build Error* only: its
  message, the file its code frame names, the line and column in that frame, the frame itself (SWC's
  `,-[` … `` `---- `` block) and what follows it (*Caused by*, the import trace) as its stack.

The entry's text is the overlay's message without the code frame some compilers repeat in it (from
its first `N |` line after the first line on, and any `^` caret line) and without the file when the message names it
again: Vite's `[vue/compiler-sfc] Unexpected token (3:15)` keeps its prefix and loses the path and
the `12 |` that followed it. The **code frame and the stack stay in the extension** like an error's
stack: never in what the Edge receives nor in the session copy, only in a report copied with its
stack. They are kept to 20 lines of frame and 30 of stack, 300 characters a line and 6000 in all
(the frame first).

Runtime errors are the hook's to report: webpack-dev-server's *Uncaught runtime errors* overlay and
Next's runtime dialog add no entry, so an error is never counted twice, and `nextjs-portal` alone
(Next's dev indicator) is nothing. The other way round, a compile error the dev server's own client repeats
through `console.error` is no runtime error: webpack-dev-server's `[webpack-dev-server] ERROR in
./src/index.js 4:15 …` and Next's `./app/page.js` / `Error:   x …` become the build entry (the same
one as the overlay's, which takes it over with its frame, and which resolves the same way), so a
build error is still caught with the overlay turned off; the client's status lines (`Errors while
compiling. Reload prevented.`, any other `[webpack-dev-server]` or `[HMR]` line it logs as an
error) are no entry at all. Vite's client logs nothing of a compile error. Each rule applies only
to its own dev server's tabs (webpack-dev-server's on a webpack tab, Next's on a Next tab, both
until the kind is known, neither on Vite), Next's only in SWC's shape (`Error:   x …` then a `,-[`
line), and webpack-dev-server's lines never use up the page's error budget; with several errors in
one compile, the first stands for them all, and the next failed compile's first error updates or
replaces it. Turbopack's console lines are not read. A console-born entry resolves with the overlay
going, a hot update or a reload: with webpack's `hot: false` and `liveReload: false` and no overlay,
nothing resolves it until the page reloads. The script reads text and attributes only, through the browser's
own `textContent`, `shadowRoot` and `contentDocument`, never a property the page defined, and runs
none of the page's code. It looks again 200 ms after the overlay last changed, says only what changed,
and at most twice a second: an overlay that re-renders as you type stays one entry (the same
message for the same file, its line and column updated when an edit above it moved it), and an
overlay that shows but has nothing to read yet changes nothing. A different error resolves the one
before it; the overlay going away (`build-clear`), a reload or a hot update resolves it, and one the
history's 20 entries pushed out stops counting. What is sent is the message clipped to 300
characters, the file as the overlay names it (an absolute path under Vite, `./src/…` under webpack
and Next) and its line and column. A line and column the overlay gives without a file are kept on
their own (the report then says `at 3:15`).

**Home folders read `~`.** Whatever leaves the extension (the Edge, the report, the popup) writes a
home folder `/Users/<name>/` as `~/`: in the page's title, an error's text, origin and stack frames,
a request's path, and a build's text and file. Inside a path the slash before it stays
(`/@fs/Users/<name>/a.js`, Vite's URL for a file outside its root, reads `/@fs/~/a.js`), a request
path that starts with it reads `/~/…`, and a name cut by the 300-character clip or by a line break
(`…/Users/Jane Ex`) reads `~`. A percent-encoded one in a URL goes the same way
(`%2FUsers%2F<name>%2F` reads `%2F~%2F`). This happens before anything is clipped for the wire. The
extension keeps the full values for itself.

### The history and the bug report

Tap a row's top line on the Edge and it unfolds to that tab's last 20 errors and failed requests
(and the `limited` entries that stand for errors dropped by the rate limit), newest first, scrolling
inside the row; only one row is unfolded at a time. A full history makes room for a new entry with
its oldest slow request, else its oldest resolved entry, and only then its oldest entry. Each entry
shows its kind, text, method and status, and for an error its origin. **Line and column numbers are
those of the code the dev server sent**: Fremdev does no source-map lookup, so a bundled or
transpiled file reads as the browser reports it. The **×** still marks the row's issues as seen (the
light turns hollow); it does not empty the history.

**Copy report** puts a Markdown bug report for that tab on the Mac's clipboard: the page, the open
issues and the history, in sections (Build, Errors, Failed requests, Performance, Slow requests),
Build and Errors each counting only its own entries (`Errors (3 open, 4 total)`), at most 48 000
characters (the oldest entries are dropped first, then stacks). **Copy with stack** adds each
error's stack, and under each build entry the overlay's code frame then its stack, home folders as
`~`. Either goes in a fenced code block nested in the entry's list item, so a Markdown renderer (a
GitHub issue) keeps the frame's alignment and shows `> 2 |` or `<script setup>` as code; the fence
is longer than any run of backticks inside:

````
### Build (1 open, 1 total)
- 10:21:05 [vue/compiler-sfc] Unexpected token (3:18)
  at ~/app/src/App.vue:3:18
  ```
  2  |  const title = 'Scratch Vite'
  3  |  const broken = 1 +* 2
     |                  ^
  4  |  const other = 3
  at constructor (~/app/node_modules/@babel/parser/lib/index.js:369:19)
  at Parser.raise (~/app/node_modules/@babel/parser/lib/index.js:6622:19)
  ```
````

From the Edge, the widget sends a `report` command; the server asks the extension for the text,
waits at most 5 seconds, and writes it to the clipboard with `pbcopy`, the text going through its
standard input. The extension's popup has the same button for each tab, with a *stack* checkbox,
and writes the clipboard from the popup itself.
At most 8 reports can be pending per install. The report is built in the extension and goes nowhere
else: only to the clipboard, when you press a button. It is available while Fremdev is on in the extension and
`labs.fremdev` is ticked, for a tab the extension reported, and only from the
Mac itself, never from a paired device.

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
Companion's origin with that extension's own token, while `labs.fremdev` is on
and the install is connected, on and lists `fremdev.shot` (409 otherwise); a body over 2 MiB is 413,
one that does not start like a JPEG (`FF D8 FF`) is 415, and a second shot while the first is being
written is 429. The token is sent only on a socket that was greeted, so only once the socket's
challenge proved that port 4242 is Fremkit. The server writes the image to a temporary file in the
data folder (0600, never over an existing file), runs `/usr/bin/osascript` with a constant script and
the file's path as an argument, and removes the file whether that worked or not. The shortcut can be
changed at `chrome://extensions/shortcuts`; the options page shows both the Fremplay and the Fremdev
shortcut.

**Seeing the shot.** Once a shot is on the clipboard, by either way, the tab shows it as macOS does: a
white flash over the page, then a small thumbnail of the shot in the bottom-right corner for 3
seconds. With *Reduce motion* on (`prefers-reduced-motion`), there is no flash and the thumbnail just
appears and disappears. The thumbnail is made in the extension, with its long side at 320 pixels at
most, as a JPEG of at most 40 000 characters (a smaller size or quality when needed, none when even
160 pixels do not fit), so the page never receives the shot itself. It is drawn by a script the
extension runs in the tab's isolated world, never the page's: one element above everything, its
content in a closed shadow root, painted on a canvas rather than loaded from a URL, so a page's CSS
cannot hide it and a strict Content-Security-Policy does not block it; it takes no click and is
removed when it has faded. A shot taken while a thumbnail still shows takes it out of the tab first,
so the thumbnail is never in the next image. It needs no permission: the key press or the popup's click is the grant,
and a dev tab is in Fremdev's own. A tab that refuses the script (a `chrome://` page, an error page)
keeps the badge's **✓** as the only sign.

On the Edge, the Fremdev widget shows the same thumbnail on that tab's row for 3 seconds, with
*Copiée* / *Copied*. The extension sends it on its socket as `dev.shot` (the tab, the thumbnail or
none, and the sound option), after the server's 200 for ⌃⇧S and after the clipboard write for the
popup's button; it announces `fremdev.shotview`, and sends `dev.shot` only to a Fremkit whose `ready`
says `modules.shotView`. Fremkit takes it only from an install that listed `fremdev.shotview`, with
Fremdev enabled and on, for a tab it reported, and drops a malformed one without closing the socket.
The thumbnail rides on the row of the `companion:dev` snapshot and is cleared after 3 seconds; rows
are never trimmed for it, and when the install's rows and the thumbnail would weigh more than 60 000
bytes the thumbnail is left out and the row says *Copiée* alone. Like the rest of `companion:dev`, it
never reaches a paired device.

**The capture sound** is an option of the extension, off by default: *Jouer le son de capture* / *Play
the screenshot sound* on its options page. When it is ticked, `dev.shot` says so and Fremkit plays
macOS's own screenshot sound on the Mac (`/usr/bin/afplay` with the system's `Screen Capture.aif`,
both fixed: the extension only says whether to play), at most once per second per browser. A demo
(`FREMKIT_DEMO=1`) plays nothing.

### Open in editor

In an unfolded row, a build entry's file, and under Vite an error thrown by a script on the page's
own origin, is a button (under a dev server Fremdev recognised): tap it and the dev server opens
that file at that line in your editor (*Envoyé à l’éditeur* / *Sent to the editor* for 2 seconds;
*Impossible d’ouvrir ici* / *Can't open here* when it could not). It shows only for an install that
lists `fremdev.open`. The widget sends an `open` command naming the tab and the entry's id; the
server asks the extension (`dev.open.ask`) only when the tab's last `dev.tabs` still lists that id,
and waits at most 5 seconds for its `dev.open.done`; the extension's request gives up after 5
seconds too. The extension looks the entry up in its own copy of the tab, builds the URL from the
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
  30 seconds is a request that took that long, and shows as slow each time it does. A request that
  failed is a failed request, never a slow one. The Edge writes the duration in seconds with one
  decimal; the report lists them under *Requêtes lentes* / *Slow requests*.
- The row carries `inFlight`, the requests started and not finished, at most 999, sent on the same
  twice-a-second throttle as the rest (a change in it alone does not wake the socket). The widget
  shows *n en cours* / *n in flight* beside the tab's name while it is above zero. **A request still
  pending after 30 seconds stops counting** and is forgotten, so a long poll or an EventSource that
  never finishes stays neither in flight nor slow. A navigation within the same origin (a reload, a
  client-side route change) keeps the count, as the requests still pending are still timed; a
  navigation to another origin sets it to 0 and forgets the tab's timings, as the tab closing does.
  At most 4 096 requests are timed at once, all tabs together, the oldest dropped first. The timings
  live in the extension's memory only.

An install that times requests lists `fremdev.slow`; an older one sends neither, and its rows read
0 in flight.

### Performance and regressions

A fourth script in the extension's isolated world of a dev tab, `fremdev/perf.js`, reads the page's
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

### Dev servers

The Fremdev widget has a second segment, **Servers**, beside **Tabs**: the TCP servers listening on
this Mac that look like dev servers, one row each, sorted by port. It needs no extension: it is
Fremkit's own server reading the Mac, behind the same experimental switch (`labs.fremdev`), and with
the switch off it runs nothing and the commands are refused.

**What is listed.** Every 5 seconds while the widget is on screen (and 1 second after any action),
Fremkit asks `lsof` for the listening sockets of your account and `ps` for the processes behind
them. Other accounts' servers are never listed, nor are Fremkit's own processes and the helper. A
row shows a light (green: it answers; grey: Fremkit restarted it and it is starting; red: Fremkit
restarted it and it exited other than with code 0 (a signal included), is not listening 30 seconds
after it started, or printed a port-in-use message; one that exits with code 0 simply leaves the
list), its port or ports, the project, the tool, how long it has been up, its CPU and memory, and
the light of the Fremdev tab open on that port, if any.

- *Which listeners are dev servers.* A node, bun, deno, Python, Ruby, PHP, Java or .NET program, a
  Go or Rust binary built under the folder it runs from, or any command that runs a tool Fremkit
  knows (Vite, Next, webpack, Storybook, Astro, Nuxt, Remix, Rails, Django, Flask, uvicorn, `python
  -m http.server`…). The tool column names it, else the program. Other listeners (AirPlay, a
  database, an app) are hidden, unless the widget's setting **Show every listening program** is on:
  they then appear with **Open** and **Kill** only. A program run from inside an application bundle
  (`.app`, `.sdPlugin`, `.bundle`, `.plugin`), or whose working folder is under `~/Library`, never
  counts as a dev server, runtimes included (Stream Deck's plugins, an editor's helpers). The one
  exception is the `Python.app` inside a `Python.framework`'s `Resources` folder, through which
  Homebrew's, python.org's and the Command Line Tools' `python3` all run. Nor do a build tool's
  daemons, which listen on loopback ports of their own between builds: Gradle's (its main class, or
  any program working under `~/.gradle`) and the Kotlin compiler's. A server Gradle starts
  (`bootRun`) is its own `java` and is listed as usual.
- *The project* is the `name` in the `package.json` of the process's folder (read when it is at most
  64 KB), else the folder's name. Under `~/Documents`, `~/Desktop`, `~/Downloads` and iCloud Drive
  the file is not read and the folder's name is used, so that polling never makes macOS ask for
  Fremkit Helper's access to them. The folder is shown with the home folder as `~`.
- *Docker.* A port published by Docker Desktop is one row, `Docker → <container name>` (the name
  comes from one `docker ps` while such a row exists), with no action: it says who holds the port,
  and stopping the container is for Docker's own tools (or a registry widget).
- *The command line* of a dev row is shown with the value of any option or `KEY=value` argument
  whose name contains `token`, `secret`, `key`, `password`, `pass`, `auth` or `cred` replaced by
  `•••`, and the password of a URL hidden; the line of any other program is its name only. The
  environment, and the command as a list of arguments, are never published.

Tap a row to unfold it: its command and folder, the buttons **Open**, **Finder**, **Restart** and
**Kill** (56 px), and, for a server Fremkit restarted, its last 20 lines of output with the colours
stripped.

**Open** opens `http://localhost:<first port>/` in your default browser; **Finder** shows the folder
selected in its parent (dev rows only).

**Kill** stops what you typed, not just the process listening. A `pnpm dev` is several processes
(pnpm, then node running Vite), so Fremkit walks up from the listener while its parent is a package
manager or a runner (npm, npx, pnpm, pnpx, yarn, bunx, `bun x`, `bun run <script name>`, turbo, nx,
concurrently, an `sh -c` they run, and node, deno or bun running one of those tools as their
script). It stops at anything else: your shell, a terminal, tmux, an editor, an agent, launchd, so a
server started by an editor task or an agent never takes its parent with it. That *launch root* gets
a polite stop (SIGTERM) and, three seconds later, a forced one (SIGKILL) to whatever is still alive.
The signal goes to the root's process group when that group is its own job (a different group from
its parent's, from Fremkit's and from Fremkit's ancestors', holding nothing protected); otherwise to
the root and its descendants, one pid at a time. Your terminal shows the job ended.

Kill and Restart are refused, by the server and not only by the widget, for:

- anything not in the current list, or a pid that has another start time than the row (a recycled
  pid);
- Fremkit itself, its children (except the servers Fremkit started itself), **and everything above
  it** (a runner that also started Fremkit, such as `concurrently` or `tsx watch` in a development
  setup, is never signalled: the launch root is narrowed down toward the server until it no longer
  contains Fremkit, so such a runner's other branches keep running);
- the helper, and other accounts' processes;
- macOS's own programs: an executable under `/System/`, `/usr/` (except `/usr/local/`, which is
  yours), `/bin/`, `/sbin/` or `/Library/Apple/`, as `ps` shows it. These rows get Open only. The
  rule is the path, not a code signature: an Apple-made app installed elsewhere (in `/Applications`)
  is not recognised, and only the two-touch confirmation stands between a finger and it.
- browsers and their helpers, by their application bundle (Google Chrome, Chromium, Microsoft Edge,
  Brave, Arc, Vivaldi, Opera, Firefox, Safari, and their Beta, Canary or Nightly channels): a browser
  with a debugging port listens, and stopping it would close every tab. These rows get Open only;
- Docker's port holders (no action at all).

A non-dev row (with the setting on) can be killed, with the same checks, but not restarted nor shown
in the Finder. **Kill** and **Restart** take **two touches**: the button turns into *Confirm?* for 3
seconds, and does nothing if it is not touched again.

**Restart** stops a server as above and starts the same command again, from the same folder, with
the same environment. `ps` joins arguments with spaces and cannot be replayed, so Fremkit reads them
exactly, at the moment you press the button, with `fremkit-scan procargs <pid>` (the helper's
scanner, using the system's process-arguments query): the program's path, the full argument list,
its environment, and the launch root's own folder. The command is not run through a shell. It waits
up to 5 seconds for the ports to be free, then starts it. Because the scanner belongs to the helper,
**without it the Restart button is not shown** (Fremkit run without the helper). A restart is
refused, before anything is stopped, when:

- the process's command line or environment cannot be read (macOS hides the environment of some
  system binaries; a value that is not text; another account's process, which the scanner refuses),
  or the scanner is unavailable: *Fremkit cannot restart this server*. Replaying a changed
  environment would be worse than not restarting;
- the launch root's folder cannot be read: *Folder unknown*;
- the process changed or exited while it was read: *This server is gone*.

After the old server is stopped, a restart can still fail, with the port still in use (*The port is
still in use*) or the new process not starting (*Could not restart it*): the server then stays
stopped. A restart takes a few seconds, and the row says *Restarting…* meanwhile.

*The server then belongs to Fremkit.* It runs as Fremkit's child (Fremkit itself runs under the
helper), in its own process group, with a **Fremkit** badge on its row. Its output (stdout and
stderr) is written to `<data folder>/servers/server-<time>-<id>.log` (folder 0700, file 0600), and
the last 20 lines (300 characters each, with anything that looks like a secret hidden) are shown in
its unfolded row. A log past 1 MB is cut back to its last 512 KB; a few lines written during the cut
can be lost. The server outlives a restart of Fremkit, which remembers it in `servers/managed.json`
(pid, start time, log path, ports: no command, no environment). The log of a server that is gone is
deleted after 24 hours. The row turns red when the server exits other than with code 0 (a signal
included), is not listening 30 seconds after it started, or its output says that its port is taken
(`EADDRINUSE`, *address already in use*, *port 3000 is in use*); in the port case the row of the
program holding that port lights up too. Kill on a Fremkit-started server stops it. Once its process
is gone, its red row offers **Dismiss** alone, which removes it: no Open, Finder or Restart, since
there is no process, port or folder left to act on.

*A stop always wins over a restart.* If you press Kill while a restart is waiting for the port, the
restart is cancelled, and if it had already started the new server, that one is stopped. A second
Restart on the same root while the first is going is refused (*Not now: try again in a moment*).

**Known limits**

- A tool that quits when its standard input closes (esbuild's watch mode, some `--watch` modes)
  exits right after a restart, because Fremkit starts the server with no terminal and standard input
  on `/dev/null`; its row turns red. Start those from your terminal.
- The restarted server's output is no longer in your terminal, only in the row and in its log file;
  and `Ctrl-C` in the terminal that first ran it no longer stops it (use Kill).
- The restarted server descends from Fremkit Helper, so macOS may ask **once** whether Fremkit
  Helper may access a protected folder (Documents, Desktop, Downloads, an external volume) or the
  local network, when the server touches one. Allow it under *System Settings → Privacy & Security*;
  Fremkit does not work around it.
- A server whose launch root is a runner that also runs Fremkit is stopped from its own branch only.
- A server started through an unusual runner form (a shell wrapper of your own) is stopped one level
  below the whole command: the safe direction. A Restart then replays that child, not the runner.
- Not for paired devices (an iPad or an Android tablet never gets the list, nor can it send a
  command) nor for registry widgets.
- Processes of other accounts, UDP sockets and containers' internals are out of scope.

### The hook in the page

To see a page's errors, Fremdev registers a small script that runs in the page's own world, before
the page's scripts, on dev hosts only. It is built not to disturb the page:

- `console.error` still prints: the original is called first, and the wrapper keeps its name and
  `toString`. Errors still propagate (no `preventDefault`), and `fetch` is not wrapped.
- It never runs the page's code to describe a logged value: no getters, no `toJSON`. A `Proxy`'s
  introspection traps (`ownKeys`, `getOwnPropertyDescriptor`, `getPrototypeOf`) may run, within the
  walk budget; the text of an object is a bounded walk, so it is
  less faithful than the browser console's.
- `console.log`, `info` and `debug` are read only for a dev server's signal: a prefix of the first
  argument, or of the first two joined when both are primitive strings (Vite logs
  `console.debug("[vite]", "hot updated: /src/App.vue")`). Nothing else of the call is looked at.
- **Stacks are read without running page code.** The hook captures V8's native `stack` getter at
  start and calls it with `Reflect.apply`, only for an error whose `name` and `message` are plain
  strings and only while the page has not set `Error.prepareStackTrace` (a page that did, such as
  one using source-map-support, gets no stack, and the origin then comes from the `error` event's
  `filename`, `lineno` and `colno` for an uncaught error; a `console.error` or an unhandled
  rejection then has no origin). A stack is kept to 30 frames of at most 300 characters and 6000
  characters in all (V8 itself records 10 frames unless the page raises `Error.stackTraceLimit`),
  as `fn file:line:col`, with a query or fragment never kept.
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
`modules.fremdev`, and sends `dev.shot` only when it also says `modules.shotView`. Fremkit 0.5.0 with this extension keeps Fremplay, and the popup tells you that
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
