# Security

Fremkit is a dashboard for one person's own Mac. That shapes everything below: what it defends
against, what it deliberately does not, and what you are trusting when you run it.

## The shape of it

The server listens on `127.0.0.1:4242` and nowhere else, and answers only a caller that shows
its **local access secret**. That leaves three attackers worth defending against, and the code is
written around them; the secret is described first because every one of them meets it.

### The local access secret

The helper makes a new secret — 32 random bytes — for every server it starts, and hands it over
in an environment variable the server removes as soon as it has read it. A server started by hand
(`pnpm start`, `pnpm dev`) makes its own. Once it listens, the server writes it to
`~/Library/Application Support/Fremkit/access-<port>.token` (under `FREMKIT_SUPPORT_DIR` when that
is set), readable by your account only (mode `0600`), replacing the file in one rename, and
removes the file when it exits. It is never logged, never returned by the API and never quoted in
an error.

**The server proves itself first.** Whatever answers on the port is not necessarily Fremkit:
another account on the Mac could bind 4242 while the server is down — at login, or while the
helper waits to restart it — and wait for the secret. So before the helper sends the secret or
shows a page from the port, it asks `/auth/proof` with a random nonce and no credential, and only
a listener that answers with the right HMAC of that nonce under the secret is treated as the
server. Anything else is shown in the **F** menu as *port 4242 is held by another program*; the
Edge and the admin window load nothing from it, and the helper starts its own server once the
port is free. Because the secret changes with every server and its file goes with the server,
scripts that read the file find nothing to send while no server runs, and a secret picked up
from a server that has since died opens nothing.

Every request must carry it, in one of two ways:

- **`Authorization: Bearer <secret>`**, for programs: the helper, the Claude Code hook scripts,
  `curl`. The scripts hand it to `curl` through a file descriptor, never on the command line,
  where any account on the Mac could read it with `ps`.
- **A session cookie**, `HttpOnly` and `SameSite=Strict`, for pages. A page gets it by following
  a one-time link, `/auth?code=…`: the code is minted by someone who already holds the secret
  (*Open the admin in the browser* in the **F** menu, `pnpm open`, the helper itself for the Edge
  and the admin window), works once, and expires after a minute. Following it opens a *session*:
  the cookie holds a random session id the server keeps in memory, **never the secret**. A
  session ends after a day unused, after a week at most, when the page signs out
  (`DELETE /api/auth/session`), and for every page at once when the server stops. Browsers send a
  host's cookies to every port on that host, so a program listening on another loopback port can
  see the cookie; what it sees cannot mint a code, cannot be presented as a bearer, and dies with
  the session. Opening `127.0.0.1:4242` without either shows a page saying how to get in.

The comparison takes the same time wherever two values differ. A request without the secret is
told **401**.

Three routes answer without it, and only to reads:

- `/auth`, which is where the cookie is obtained, and which takes a one-time code instead.
- `/fremkit.js` and `/widgets/<id>/…`, the widgets' own files. A widget runs in a sandboxed frame
  with an opaque origin, and a browser treats every request such a frame makes as cross-site, so
  a `SameSite` cookie never goes with them (Chrome drops it; Safari's engine happens to send it,
  which is not something to build on). These files are the bytes the repository and the registry
  publish, carry no data of yours, and come with the widget CSP whatever opens them; everything a
  widget *does* goes through the host page, which holds the cookie. The cost is that a page can
  tell which widgets are installed by asking for them.

The exemption is decided by the route the server matched, not by the text of the path, so a
path that only *looks* like a widget file is not let through.

**What the secret does not protect against.** Anything running as you can read the token file,
just as it can read your keychain, your config and your clipboard without Fremkit's help: the
secret keeps out other accounts on the Mac and anything that can reach the port without being
able to read your files, not malware in your own account. A browser holding the cookie is signed
in until its session ends (see above) or the server restarts; a page in that browser is still held off by
the Host and Origin checks below, which stay in place, not by the secret. The Host and Origin
checks still run first: a request from a rebinding page is told 421, and a write from another
site 403, whatever it carries.

### A web page in your browser

Any page you visit can try to talk to `127.0.0.1:4242`. It cannot read most answers — the browser
enforces that — but it can *send*, and it can embed. So:

- Every request whose `Host` header is not one of the loopback names we answer to is refused with
  a **421**. That is what kills DNS rebinding, where a page gets `evil.example` to resolve to
  `127.0.0.1` and then talks to us as itself.
- Every request that is not a read requires an `Origin` we serve. A request with no `Origin` at
  all passes this check: that is `curl`, the Claude Code hook scripts and the native helper, none
  of which is a browser doing cross-site work — and each of which still has to show the secret.
- The cookie is `SameSite=Strict`, so a page on another site that sends a request to us — a form,
  an `<img>`, a `fetch` with `no-cors` — sends it without the cookie and is refused before any
  route runs. These checks were the whole defence before the secret existed; they stay, so a
  mistake in one is not the end of the other.
- The reads that *cause* something — fetching a favicon, proxying for a widget, asking a device
  for its options, downloading a backup — additionally refuse a request whose `Sec-Fetch-Site`
  says `cross-site`, which is the only signal a cross-site `<img>` or `<script>` gives.
- Every answer carries `X-Content-Type-Options: nosniff`, and the ones that hand back bytes from
  elsewhere also carry `Content-Security-Policy: default-src 'none'; sandbox`, so a browser
  talked into treating one as a document gets an inert one.
- The dashboard and the admin carry their own CSP: only scripts from this server, no plugins, no
  `<base>`, frames only from `/widgets/`, and `frame-ancestors 'none'` — no other page can frame
  them. It is written for the origin the page came from: 4242, a second checkout's port, or a
  paired device's `https://<mac>:4243` (`hostCsp` in `server/src/http/headers.ts`; under
  `pnpm dev`, Vite sends the same one from `ui/vite.config.ts`).

### A third-party widget

A widget is a folder of HTML and JavaScript. It is **untrusted code**, and it runs in a
`sandbox="allow-scripts"` iframe *and* under a CSP served with its own files, so the two hold even
if someone opens `/widgets/<id>/index.html` directly. The document has an opaque origin: nothing
it does counts as coming from `http://127.0.0.1:4242`. Its CSP also names who may frame it
(`frame-ancestors`): the dashboard and the admin on this server's loopback origins, or, through the
remote listener, the paired device's own `https://<mac>:4243`. Another web page gets no widget
document to frame, so none whose bridge attributes it could read (Fremplay's lists this Mac's
addresses) or that would take a `fremkit:connect` from it.

What a widget **cannot** do:

- Reach the network directly. `connect-src 'none'`: `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, `sendBeacon` and `WebTransport` are dead inside a widget. Every call goes through
  `Fremkit.fetch`, the host, and the proxy, which only allows the hosts the manifest declares —
  never a private, loopback, link-local or reserved address, in any spelling.
- Use WebRTC. No CSP directive covers it (Chrome and WebKit ignore `webrtc 'block'`), and a peer
  connection would reach any STUN or TURN server, or any candidate address, with the widget's
  data in it. So the bridge, which the server places ahead of everything the widget wrote, makes
  `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCSessionDescription` and
  `RTCIceCandidate` undefined, non-writable and non-configurable before any widget code runs; a
  child frame that could hold a fresh copy is refused by `frame-src 'none'`. The one exception
  is a **built-in** widget on a list in the server (`server/src/widgets/webrtc.ts`, Fremplay alone today):
  it gets a wrapped `RTCPeerConnection` with no ICE server, ever, that drops every candidate not
  on loopback or on one of this Mac's own addresses. A widget from the registry never gets
  WebRTC — not from its manifest, not through the consent dialog.
- Navigate its frame anywhere but another widget document. A sandboxed frame may navigate
  itself, and `location = 'https://…?d=<data>'` would send the data in the request. The
  dashboard and the admin carry a CSP whose `frame-src` is `<their own origin>/widgets/`, and the
  helper's kiosk and admin windows cancel any frame navigation outside `/widgets/` themselves.
  Only a widget's `index.html` runs script there: its other HTML, SVG or XML files are served
  with `script-src 'none'`.
- Read a channel its manifest does not declare, or send a command on one. `config`, which carries
  the whole dashboard, cannot be declared at all.
- Act on something that is not its own. A command that does something on your behalf — pressing a
  shortcut button, probing a service — names only *its own instance*, and the host stamps that
  identity itself; the target is then read from your saved settings. A widget cannot press
  another widget's buttons, and cannot name an application or a URL of its own.
- Keep talking after navigating itself. The host answers a widget over a `MessagePort` handed to
  the document that said hello, and only once that document has repeated a nonce on it; a port
  does not survive a navigation, so nothing the host sends afterwards reaches the next document.
  A second hello from the same frame, or a reload of it, and the host drops its subscriptions and
  stops answering.
- Press ▶ on a channel it was not granted. A settings `preview` must name one of the widget's
  `commands`; the grant drops a preview its commands no longer cover, and the admin sends one
  only on a channel the widget may command.
- Have an image of its choosing fetched. `Fremkit.image` fetches an address only when it is in
  the instance's own settings — what you typed, not a default the manifest wrote.
- Store anything. `localStorage` throws in an opaque origin.

What a widget **can** do, and what that means for you: a widget that declares `homey:*` can drive
every settable device on your Homey, and one that declares `shortcuts` can press the buttons you
configured on *its own* tile. The admin shows what each widget asks for — under the widget in the
library, and in full in its inspector — so read that before installing one from elsewhere.

### An installed widget

A widget from the [registry](https://github.com/fdussert/fremkit-sietch) is the same untrusted
code as any other, in the same sandbox, under the same CSP. Two things are different.

It is held to **what you accepted**, not to what it asks for. Installing it records the three
permission lists as they were shown to you; the manifest on disk is only the ask, and everything
downstream — the channels the host relays, the hosts the proxy fetches — is handed the
intersection of the two. A channel the manifest declares and your record does not is refused
exactly like one that was never declared. That is what makes "an update whose permissions grew
asks again" a property of the server rather than a promise the dialog makes: an update that
quietly widened its own manifest would gain nothing by it. An installed widget with no record at
all — a folder dropped into `data/widgets` by hand — gets nothing.

And it is checked on the way in. The index is fetched over https from one host, every URL it
names must be on that host, a redirect is refused, and the package's sha256 is verified **before
a single zip entry is read**. Then the package rules run again on this side — no dotfile, no
symlink, no climbing path, no nested archive, size ceilings, a manifest that validates, an `sdk`
this build speaks, an `id` that is the one you asked for and is not a built-in's, and no private
host in `permissions.network`. The registry applies the same rules at pull-request time; neither
side trusts the other. The whole chain is described in
[docs/marketplace.md](docs/marketplace.md#what-the-installer-checks).

What none of that protects you from is a widget that does exactly what it said and is simply
malicious about it. The registry is curated by pull request and the review reads what a widget
does with the permissions it asks for — but the thing to read before pressing Install is the
list in the dialog.

A widget may also **declare a connection** — a service it needs credentials for, described in
its own manifest rather than coded into Fremkit. What that widget can reach is narrower than it
sounds, and deliberately so. It never holds the credential: it asks the server for a *path*, and
the server checks the method and that path against the exact list of requests you were shown
before installing, adds the credential, and returns the answer. Anything not on the list is a
403. The credential goes to the address **you** typed and to nothing else — a redirect is an
error rather than a hop, and the address cannot be changed without the key being asked for
again. A path that a service might route differently from the matcher (`..`, `%2f`, an empty
segment) is refused before it is matched. The widget may set a body and two headers,
`Content-Type` and `Accept`; `Authorization`, `Cookie` and `Host` are refused, because each is a
way of reaching past the proxy. Plain HTTP is honoured only for an address on your own network,
where there is no certificate to be had.

The thing this does *not* protect you from is the same as above: a widget doing exactly what it
declared, on data you agreed it could reach. The list in the dialog is the thing to read.

### Remote data rendered by a widget

Calendar titles, volume names, printer fields, pull request titles: none of it is yours, all of it
reaches a screen. The bridge provides `Fremkit.esc()`, `Fremkit.el()` and `Fremkit.color()`, and
the widgets here use them. See the Security section of
[docs/writing-widgets.md](docs/writing-widgets.md).

### A paired device

Off by default: until you switch it on in the admin, nothing listens beyond `127.0.0.1`. Turned
on, a second listener answers on port 4243, **TLS only**, with a self-signed key the iPad app pins
(the hash of its public key travels in the pairing QR code, and the app shows four words from it
to compare when you pair without the camera). A device holds a random token that the Mac stores as
a hash; revoking the device, or resetting the certificate, ends it at once, open WebSocket
included. The listener drops any peer outside the private ranges — RFC 1918 and link-local IPv4,
unique-local and link-local IPv6, and the Mac itself — before the TLS handshake, so a host on a
public IPv4 or IPv6 address gets nothing, and neither does Tailscale (100.64/10 and
fd7a:115c:a1e0::/48 are refused by name). A VPN that uses the same private ranges as a home network
(WireGuard or OpenVPN on 10/8 or 172.16/12, ZeroTier) cannot be told apart from it and is let in;
it still needs a live code or a device token. Pairing needs a single-use code, valid five minutes;
`/api/pair` answers 404 unless a code is live, and wrong guesses are limited per peer (5 a minute;
a peer is an IPv4 address, a link-local IPv6 address, or the /64 of any other IPv6 address, since
one host controls every address of its /64) under a total ceiling of 60 a minute per code. A
guesser shares its allowance with the other IPv6 peers of its /64, so it can hold pairing at 429
over such an address; the iPad then tries the Mac's other addresses, the QR code's IPv4 one
included, and pairs there. A guesser using several addresses together (IPv4 aliases, link-local
addresses, ULA prefixes) can spend the total and hold pairing for everyone for as long as it keeps
guessing; a new code resets the total, but a guesser watching for it spends the new one as fast.
The code itself stays out of reach either way: at most 300 guesses against 32^8 values.

That lock-out reaches the typed code only. With every code the Mac also draws a 256-bit random
secret, bound to it (same five minutes, single use, gone with a new code, a pairing, the switch
turned off or a certificate reset), and puts it in the QR code's link, and only there: it is in the
answer to `POST /api/devices/code` (no-store) and in no other route, status, log or error. The iPad
sends it instead of the code. `/api/pair` compares it in constant time *before* looking at the
guess counters, so the right secret pairs while codes are at 429; a wrong one takes the wrong-code
path, refused while the peer is limited and counted otherwise, with the same answer. Pairing by hand
(the Bonjour list, the typed code and the four words) still uses the code, and still can be held.

On that path the iPad trusts whatever key answers for the Mac it picked, and the four words are
only 32 bits of that key's hash: a machine on the network can find a key with the same words
offline, announce itself under the Mac's name, and pass on what the person types. So the typed
code never leaves the iPad as itself. The app sends a proof of it bound to the key it is talking
to (PBKDF2-HMAC-SHA256 of the code, salted with that key's hash, 600,000 rounds; `codeProof.ts`,
`CodeProof.swift`), and the Mac takes only the proof made for its own key, compared in constant
time like the code was. A relayed proof was made for the impostor's key and is a wrong code here,
and reading the code back out of it takes about 2^60 hashes, far beyond its five minutes. The
Mac derives its proof once, when it issues the code. The words help the person pick the right Mac;
they are no longer what stops a relay.

The remote listener is an **allow-list**, decided by the socket a request arrived on rather than
by a header: the dashboard's page and its code, the routes a dashboard reads, `/ws`, the widget
proxy, and the device's own `GET /api/devices/me` and `POST /api/devices/me/brightness`. Everything
else, the admin and every route that writes the configuration or reads a secret, answers 404. A
paired socket may subscribe to and command only what the widgets of its own screen declare — on a
per-connection channel (`calendar:<id>`, `github:<id>`), only the connections those widgets are
bound to, with the same refusal as a channel that does not exist — and a
device acts only on the instances of its own screen: the widget proxy (and so a widget's stored
credential) and the commands that resolve an instance refuse any instance shown elsewhere, and a
device with no screen acts on none. The device app asks for the Mac's private (RFC 1918) IPv4
addresses the listener answers on, on Wi-Fi or Ethernet only (`en*`: never a VPN's `utun*`, which
may be a company network on 10/8, nor a virtual machine's bridge), eight at most
(`GET /api/devices/me?addresses=1`), so it can
follow the Mac when one goes away; the dashboard page's own request and the `device` channel do not
ask and are not told. That is not a boundary against the page, which is our own code and could ask
too; widgets cannot reach the route at all (`connect-src 'none'`, an opaque origin). The iPad keeps
only private IPv4 addresses from that list and reaches them under the same pin as any other, so a
stored address presenting another key is not the Mac. The configuration it reads, over HTTP and on the WebSocket,
is its own screen's — the theme, the language, that screen and the widgets on it — never your
connections, the marketplace records, the privacy switches or any other screen. The theme in force
reaches it without the time of the next switch, which is a sunrise or sunset at your coordinates. The widget
catalogue lists only the widgets on its screen, without the scan's errors, and the installed
applications and their icons go only to a screen that shows a widget allowed to read them. A
device has the Mac fetch a site's icon only for a link or image address its own screen's settings
hold, and none without a screen. By design, the dashboard's page and code, `/fremkit.js` and every
widget's files under `/widgets/<id>/` (manifest included) answer before pairing, to any peer the
listener accepts: an iPad needs them to show the pairing page and its widgets, and they tell a
peer on the network which widgets are installed, nothing about how they are set up. In the iPad app, a frame inside the dashboard may load only
the Mac's `/widgets/…`, the same rule as the Edge's kiosk. See
[docs/devices.md](docs/devices.md).

### A browser extension

The [Fremkit Companion](docs/companion.md) extension is the one thing that talks to the server
without the local access secret, because an extension cannot be handed it: the secret is a file in
your account, and an extension has no way to read your files. It is let in by a different door, and
the door is narrow.

**Its credential.** An extension is linked by the code you type into it: it asks, the server shows
a four-character code on the Edge and in the admin (never to the extension), and you type that code
into the extension's popup. Typing it is the approval; there is no Allow. The code itself never
travels. `K = PBKDF2-HMAC-SHA256(code, "fremkit-companion-pair-code-v1:" + request id + "|" +
saltE, 600,000 rounds)` (the iPad code proof's function and cost under its own salt;
`server/src/companion/pairProof.ts`), which the server derives when the request is made. `saltE` is
32 random bytes the extension sends with its request: the request id is the server's to choose, so
without the extension's own salt a program holding the port could hand out one fixed id, build the
table of K for every code once, and answer any proof in time. The
extension proves first: it sends a fresh nonce and `HMAC-SHA256(K, "fremkit-companion-pair-client-v1|"
+ request id | nonce)`. The server checks it in constant time; a wrong one counts, and the third
refuses the request. A right one gets the server's proof back in the same answer, its own nonce and
`HMAC-SHA256(K, "fremkit-companion-pair-server-v1|" + request id | both nonces)`, with the token.
The extension keeps the token only if that proof checks against the typed code **and** came back
within two seconds of sending its own; otherwise it drops the token and says the server on the port
is not Fremkit. Why both rules: a program that made a request itself (see below) only ever learns
whether a guess was right, three guesses per request. A program holding the port in Fremkit's place
does receive the extension's proof and could search the code offline from it, but about 2^20
four-character codes at 600,000 PBKDF2 rounds each is ~6·10^11 HMAC-SHA256 computations, minutes on
a large GPU and hours on a CPU, and its answer had to be back in two seconds. The real server
answers at once, K being ready. The exchange is a `POST` (Chrome sends no `Origin` on an extension's
`GET` to `127.0.0.1`). The token is 32 random bytes; only its `sha256` is stored, compared in
constant time. A code lasts two minutes, and one request waits at a time: while it waits, a
request from another install is answered 409 and does not take its place; only the same install
can replace its own. Five requests a minute are accepted in total, three per install, and an
install whose request was refused is turned away for a minute. Refuse sends the code it showed,
and the server answers 409 when it is not the waiting request's, so a refusal never lands on a
request swapped in after you read the code. The name shown is one of a closed list of browser
names (Chrome, Microsoft Edge, Brave, Arc, Opera, Vivaldi, Chromium).
Removing the extension in **Settings → Devices** closes its socket and its token stops working.

**The routes that skip the secret**, decided by the route the server matched, like the widgets'
files:

- `POST /api/companion/pair`, `POST /api/companion/pair/:requestId` (where a request stands) and
  `POST /api/companion/pair/:requestId/confirm` (the code's proof), which each check
  for Companion's own `Origin` (`chrome-extension://lnckeodobpbbmfbdlpnegjpchgkehdlk`, the ID its
  manifest `key` fixes, or one a developer lists in `FREMKIT_COMPANION_EXTENSION_IDS`) before doing
  anything.
- `GET /companion/ws`, the socket. The extension opens it with a `challenge` naming its record
  and a fresh nonce; the server answers with an HMAC of that nonce keyed by the token's stored
  `sha256`, which the extension checks before it sends its token in `hello`. The token must
  belong to that same record, whose origin *and* install id match what the socket presents, and
  the whole exchange must finish within five seconds; anything else is closed.

Refusing a request stays behind the secret and is local-only. None of these routes
exists on the remote listener (4243). The `companion` channel the dashboard watches is built-in
only, and paired iPads are refused it entirely. The admin's health channel (`config:health`) lists
the companion's provider with its last error code, as it does every provider; that channel is
local-only (no widget may declare `config:*`, and a paired device hears the literal `config` alone)
and holds no code, token or tab data.

**What a web page can do.** Not pair: it has no extension `Origin`, which a page cannot forge, and
the pairing still needs the code from the Edge. It cannot open the socket without a token, and it
cannot read one; its upgrade is answered 403 before any socket exists, so it cannot take a socket's
place either. It can tell that Fremkit runs from that answer, which says no more than the HTTP
server on port 4242 already does, and is accepted as such. At most four sockets per extension
origin, and thirty-two in all, may be short of their hello at once (one more is closed with 1013),
and a share's metadata refreshes reach the dashboard at most four times a second. A local process
can forge the extension's `Origin` and keep those slots taken, renewing silent sockets every five
seconds, so your extension's connections are turned away while it does; a process running as you has
worse options anyway.

**What another extension can do.** Not pair, nor open the socket: it has its own
`chrome-extension://` origin, which is not Companion's, and every companion route and the socket's
upgrade answer it 403. (A browser sets an extension's `Origin`; the extension cannot pick
Companion's.) The Edge prompt and **Settings → Devices** also show the first six characters of the
asking or linked extension's ID, so a developer's second copy is told from Companion at a glance.
That is all the short ID does: a local program sending Companion's `Origin` (see below) shows the
same six characters, so the ID never tells Companion from such a program.

**What a linked extension can do**, and it is little: send metadata about the video being shared (a
title, a host, a position), and a WebRTC offer, to the Edge. It cannot read your dashboard, your
config or your connections, call any other API, or send a command to a widget other than driving its
own share. Its offer may only name this Mac — host candidates on loopback, a `.local` name or one of
the Mac's own addresses — so the kiosk is never sent to another machine on the network (an offer
naming anything else is not relayed: that widget gets no picture while the share goes on for the
others, and the popup says the Edge refused the video connection), and
the video does not leave your Mac; it never goes through the server either. The picture is cropped
to the page's main video element; a page can make that element cover the whole tab, frames from
other sites included, but the picture only goes to your own dashboard. The extension asks for
another site's frames only when you allow that site, after its popup has named it, and gives the
grant back unless the share starts with a video in that site's frame. It drives the video from its
isolated world (only YouTube's volume goes through the page's own), keeps its token in storage
limited to its own pages and worker (`TRUSTED_CONTEXTS`, available on every browser it installs on,
Chrome 116 and later), where code it injects into a page cannot read it, and listens only to its own
pages.

**What a local program can do.** A process running as you can read the access secret and anything
else; it is out of scope, as under *Known limits*. One running as another account, or anything that
reaches the port without reading your files, cannot pair without the code that is on the Edge.
It can, however, post a pairing request: an `Origin` header is only a header to a program that is
not a browser, and the per-install limits count an install id it picks. It cannot pair with that
request without the code: it must prove the code first, and gets nothing but "wrong" for each of
its three guesses, about one chance in 350,000, after which the request is refused. And it cannot
keep asking: after five requests refused for wrong codes within a day, pairing locks (423) until
you press **Unlock pairing** in **Settings → Devices** (`POST /api/companion/unlock`, behind the
secret, local-only, on no allow-list). The lock is a flag in `companion-lock.json` next to
`devices.json` as well as in memory, so restarting Fremkit does not clear it; a file that cannot be
read counts as locked. Fifteen guesses in all is about one chance in 70,000. While
`labs.companion` is off and no extension is linked, pairing requests are refused outright (409),
since the Edge would show nobody the request; this keeps guessing from going unseen and is not a
security boundary, as nothing else relies on the switch. A program that keeps a request of its own waiting can
hold pairing up (you then see a request you did not start, and the Edge counts the other browsers
turned away since you last answered one, a count only your answer clears, or two minutes with no
request waiting at all: refuse it), but it cannot swap its request in under the code you type: the
code belongs to the request it was shown for. Nor can it learn a linked extension's token by
holding port 4242 in Fremkit's place: it cannot answer the challenge, so the token is never sent,
and without the token it never sees an offer to answer, which is what keeps the video from it. The
extension also drops the answer's candidates that are not loopback or a `.local` name, as defence in
depth only: WebRTC learns the receiver's address from its incoming checks whatever the answer lists.
Such a program can make the extension show itself removed (an unproven refusal), but the token stays
until you pair again. Nor can it pair the extension with itself by holding port 4242 when you press
Connect (Fremkit stopped or restarting): the extension takes a token only once the server has proved,
within two seconds, that it knows the code you typed, and that code is on the Edge. With the helper, the Edge shows only a
page from a server that passed `/auth/proof` (`AccessProof.swift`): one that cannot is *foreign*,
and the kiosk never loads its page, so a program holding the port cannot put a code there, and the
code you type from the Edge binds the pairing to the real Fremkit. Without the helper (Fremkit run
from a terminal, the Edge showing a browser window) nothing makes that check: the page on the Edge
is whatever answers on the port, so an impostor there can show its own code, and you would type it.
Pair a browser-only setup only while you know Fremkit itself holds the port. The popup's removed
state also warns not to reconnect unless you removed the browser in Fremkit yourself. The
turned-away count is a hint, not a proof: such a program can also raise it on your own request with
install ids it makes up.

## What Fremkit reads on your Mac

Transcripts, the clipboard, Dock badges, a keychain item — the full list, with who reads what and
when, is in the [README](README.md#what-fremkit-reads-on-your-mac). Two things worth repeating
here:

- Reading the **Claude Code OAuth token** from the keychain is **off by default** and turned on
  explicitly in /admin → Screen → Privacy. It is presented to `api.anthropic.com` and nowhere
  else, and is never stored or logged.
- Connection secrets live in the **macOS keychain** (or `data/secrets.json` if you chose the file
  backend). They are never returned by the API, never logged, never quoted in an error, and never
  included in a backup. A stored secret also cannot follow a changed destination: change the host
  of a connection and you are asked for the secret again.

## The native helper

The helper (`native/`) is a small AppKit app that owns the kiosk window, the HID touch driver and
the Dock badges, and supervises the server process.

- **Its TCC grants are real, and they reach its children.** Input Monitoring and Accessibility
  let it read the touch panel and post synthetic mouse events. macOS attributes the Node server
  and the programs it runs (such as `fremkit-scan`) to the helper as their responsible app, so a
  file-access grant made to "Fremkit Helper" — Files and Folders, or Full Disk Access — is also
  the server's.
- **Full Disk Access is optional.** The disk map and the Messages 2FA provider can benefit from
  it: without it, protected folders are shown as unreadable and Messages lookup fails. With it,
  the helper, the server and every provider can read every file of the account. Grant it only if
  you want those features, and leave the separate Messages 2FA privacy setting off unless you
  want a built-in widget to read recent incoming messages after an explicit copy request.
- **It is signed with a self-signed identity** created by
  `scripts/create-signing-identity.sh` ("Fremkit Helper Dev"), because macOS ties TCC grants to
  the signature: without a stable one you would re-approve the permissions after every build.
  That identity is trusted for code signing **in your login keychain only** — nothing is added to
  the system trust store — and its private key is imported non-extractable and usable by
  `codesign` alone. It is not notarised, and it is not a substitute for a Developer ID.
- **The kiosk cannot be navigated away from**: a main-frame navigation off the dashboard's origin
  is cancelled, and WebKit's context menu is removed, because the Edge has no keyboard and no
  window chrome to get back with. In the kiosk and in the admin window, a **frame** may only
  load a widget document (`<origin>/widgets/…`); anything else is cancelled before the request
  leaves.
- **macOS Local Network** permission belongs to the *responsible app* — "Fremkit Helper" under the
  helper, your terminal otherwise. Deleting the helper's bundle drops the grant, which is why the
  install script replaces its contents in place.

## Known limits

These are real and not fixed. They are here so you can decide whether they matter to you.

- **Bambu Lab LAN mode has no certificate to verify.** The printer serves a self-signed
  certificate on both the MQTT port and the camera port, so Fremkit connects without verifying
  it: the traffic is encrypted but the peer is not authenticated. Anything on the same network
  that can answer for the printer's address can receive the LAN access code. See
  [docs/connections.md](docs/connections.md#what-the-tls-does-and-does-not-prove).
- **A same-user process is out of scope.** It can read your keychain, your config and your
  clipboard without going through Fremkit at all — and the access secret's token file, which is
  readable by your account by design so the scripts can use it. If macOS grants Full Disk Access
  and you enable the separate Messages 2FA privacy setting, it can also ask Fremkit's local
  command to copy a recent incoming verification code; that setting is off by default.
- **The widgets' own files are served without the secret** (see above), so a page you visit can
  find out which widgets are installed, though not how they are set up or what they show.
- **The registry is trusted to be curated, not to be safe.** An installed widget can do
  everything you granted it, and a permission list that looks reasonable can still be used
  badly — there is no sandbox that tells "shows my calendar" from "sends my calendar somewhere".
  The index carries no signature: the trust is in GitHub Pages serving what the workflow built,
  and in the hash and the https host, which stop the bytes changing on the way rather than
  proving who wrote them.
- **A Synology on the LAN has no certificate to verify either.** `allowSelfSigned` exists for
  exactly that, off by default and per connection; turned on, the traffic is encrypted but the
  peer is not authenticated. See [docs/connections.md](docs/connections.md#synology).
- **The Claude usage endpoint is undocumented.** `api.anthropic.com/api/oauth/usage` is not a
  published API and may change or disappear.
- **WebKit preconnects whatever the CSP says.** A widget's `<link rel="preconnect"
  href="https://<anything>.example">` makes WebKit — the kiosk, the admin window, Safari —
  resolve that name and open a TCP connection to it; no request is sent, but the name itself
  reaches a DNS server the widget's author may run. Chrome honours the CSP and does not. No
  header or CSP directive turns it off for a document; `scripts/check-widget-sandbox.ts`
  watches it.
- **DNS rebinding is closed for the widget proxy and the favicons, not for declared
  connections.** A widget's `GET` through the proxy and every favicon fetch connect through a
  lookup that judges the very address the socket is opened on, so a name that answers a public
  address to the check and `127.0.0.1` to the connection is refused. A declared connection
  reaches the host *you* typed, LAN included, on purpose, and is not judged that way.

## Reporting something

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository — the **Security** tab, then **Report a vulnerability** — which
opens a private thread with the maintainer.

Useful in a report: what an attacker has to control (a web page you visit, a widget you
installed, a device on your network), what they get, and the shortest way to reproduce it. There
is no bounty; this is one person's side project, and it will be read and answered.
