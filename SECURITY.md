# Security

Fremkit is a dashboard for one person's own Mac. That shapes everything below: what it defends
against, what it deliberately does not, and what you are trusting when you run it.

## The shape of it

The server listens on `127.0.0.1:4242` and nowhere else. It has **no authentication**, by design:
anything that can open a socket to it is already running as you on your Mac, and a process
running as you can read your keychain whatever Fremkit does. Adding a password would protect
nothing and would be one more secret to keep.

That leaves three attackers worth defending against, and the code is written around them.

### A web page in your browser

Any page you visit can try to talk to `127.0.0.1:4242`. It cannot read most answers — the browser
enforces that — but it can *send*, and it can embed. So:

- Every request whose `Host` header is not one of the loopback names we answer to is refused with
  a **421**. That is what kills DNS rebinding, where a page gets `evil.example` to resolve to
  `127.0.0.1` and then talks to us as itself.
- Every request that is not a read requires an `Origin` we serve. A request with no `Origin` at
  all passes: that is `curl`, the Claude Code hook scripts and the native helper, none of which
  is a browser doing cross-site work.
- The reads that *cause* something — fetching a favicon, proxying for a widget, asking a device
  for its options, downloading a backup — additionally refuse a request whose `Sec-Fetch-Site`
  says `cross-site`, which is the only signal a cross-site `<img>` or `<script>` gives.
- Every answer carries `X-Content-Type-Options: nosniff`, and the ones that hand back bytes from
  elsewhere also carry `Content-Security-Policy: default-src 'none'; sandbox`, so a browser
  talked into treating one as a document gets an inert one.

### A third-party widget

A widget is a folder of HTML and JavaScript. It is **untrusted code**, and it runs in a
`sandbox="allow-scripts"` iframe *and* under a CSP served with its own files, so the two hold even
if someone opens `/widgets/<id>/index.html` directly. The document has an opaque origin: nothing
it does counts as coming from `http://127.0.0.1:4242`.

What a widget **cannot** do:

- Reach the network directly. There is no `connect-src` at all: `fetch`, `XMLHttpRequest` and
  `WebSocket` are dead inside a widget. Every call goes through `Fremkit.fetch`, the host, and the
  proxy, which only allows the hosts the manifest declares — never a private, loopback,
  link-local or reserved address, in any spelling.
- Read a channel its manifest does not declare, or send a command on one. `config`, which carries
  the whole dashboard, cannot be declared at all.
- Act on something that is not its own. A command that does something on your behalf — pressing a
  shortcut button, probing a service — names only *its own instance*, and the host stamps that
  identity itself; the target is then read from your saved settings. A widget cannot press
  another widget's buttons, and cannot name an application or a URL of its own.
- Keep talking after navigating itself. If a widget replaces its own document, the host drops its
  subscriptions and stops answering it.
- Store anything. `localStorage` throws in an opaque origin.

What a widget **can** do, and what that means for you: a widget that declares `homey:*` can drive
every settable device on your Homey, and one that declares `shortcuts` can press the buttons you
configured on *its own* tile. The admin shows what each widget asks for — under the widget in the
library, and in full in its inspector — so read that before installing one from elsewhere.

### Remote data rendered by a widget

Calendar titles, volume names, printer fields, pull request titles: none of it is yours, all of it
reaches a screen. The bridge provides `Fremkit.esc()`, `Fremkit.el()` and `Fremkit.color()`, and
the widgets here use them. See the Security section of
[docs/writing-widgets.md](docs/writing-widgets.md).

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

- **Its TCC grants are real.** Input Monitoring and Accessibility let it read the touch panel and
  post synthetic mouse events. Those are powerful permissions, granted to that bundle, and they
  cover the helper only — not the Node server it spawns, which is an ordinary child process.
- **It is signed with a self-signed identity** created by
  `scripts/create-signing-identity.sh` ("Fremkit Helper Dev"), because macOS ties TCC grants to
  the signature: without a stable one you would re-approve the permissions after every build.
  That identity is trusted for code signing **in your login keychain only** — nothing is added to
  the system trust store — and its private key is imported non-extractable and usable by
  `codesign` alone. It is not notarised, and it is not a substitute for a Developer ID.
- **The kiosk cannot be navigated away from**: a main-frame navigation off the dashboard's origin
  is cancelled, and WebKit's context menu is removed, because the Edge has no keyboard and no
  window chrome to get back with.
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
  clipboard without going through Fremkit at all.
- **The Claude usage endpoint is undocumented.** `api.anthropic.com/api/oauth/usage` is not a
  published API and may change or disappear.
- **DNS rebinding has a race no application can win.** The proxy resolves a host and judges the
  address, then `fetch` resolves it again; a name that changes between the two is not caught.
  What is caught is a widget simply *asking* for a private address.

## Reporting something

Please **do not open a public issue** for a vulnerability. Use GitHub's private vulnerability
reporting on this repository — the **Security** tab, then **Report a vulnerability** — which
opens a private thread with the maintainer.

Useful in a report: what an attacker has to control (a web page you visit, a widget you
installed, a device on your network), what they get, and the shortest way to reproduce it. There
is no bounty; this is one person's side project, and it will be read and answered.
