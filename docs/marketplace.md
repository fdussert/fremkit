# The widget marketplace

Fremkit ships with twenty-six widgets. Everything written after that is published to a registry
instead, and installed from the admin — so a new widget does not need a new Fremkit, and a
Fremkit with no network still starts with a working dashboard.

The registry is [fdussert/fremkit-widgets](https://github.com/fdussert/fremkit-widgets): one
folder per widget, curated by pull request, packed by a workflow and published as an
`index.json` on GitHub Pages. There is exactly one, and its address is a constant in the code
rather than a setting — adding a second is a decision nobody has taken.

## Installing something

*Admin → the widget column → **Browse***.

Each card says what the widget is, who wrote it, under which licence, how big the download is,
and what it asks for. A widget that needs a connection says so — "needs a Synology connection" —
which is the one thing worth knowing before you spend a download on it. Create the connection
first if you have not: *Connections* in the top bar.

Pressing **Install** shows what the widget will be allowed to do, and nothing is downloaded
until you agree. Accepting records that grant in your config, beside the version and the
registry it came from.

Installed widgets appear in the **Installed** tab like the built-in ones, marked `installed vX`,
and are placed on a page the same way.

## Updates

An update is offered when the registry publishes a version newer than yours; the Browse tab
carries a count and the card carries a chip.

- An update whose permissions are **the same or narrower** installs straight away.
- One that asks for **anything new** — one more channel, one more command, one more host — asks
  again, and shows you the difference rather than the whole list a second time.

That rule is enforced by the server, not by the dialog. The consent record is what a widget is
allowed to do; the manifest on disk is only what it *asks* for, and everything downstream is
handed the intersection. A channel the manifest declares and the record does not is refused
exactly like one that was never declared — so an update that quietly widened its own manifest
would gain nothing by it.

## Removing one

**Remove** on the card, or in the Browse tab. Fremkit refuses while the widget is still on a page
or in the navigation bar, and names the places: removing it under your layout would leave holes
you never asked for. Take it off the pages first.

Removing a widget deletes its folder and its consent record. Its settings on a page go with the
tile you removed.

## Where it all lives

| | |
|---|---|
| Built-in widgets | `widgets/` in the checkout — updated by `git pull`, never by the admin |
| Installed widgets | `data/widgets/<id>/` — git-ignored, and moved by `FREMKIT_DATA_DIR` |
| What was granted | `marketplace.installed` in `data/fremkit.json` |

A widget installed from the registry can never take the id of a built-in: the installer refuses
the collision, and a folder dropped into `data/widgets` by hand is reported as an error while the
built-in keeps the id.

## What the installer checks

The registry runs these rules at pull-request time, so an author hears about a mistake early.
Fremkit runs them again on the way in, because a registry can be wrong, be forked, or one day be
whoever owns a DNS record. Neither trusts the other.

- The index is fetched over **https only**, from the registry's own host, with a timeout and a
  2 MB ceiling. A redirect is refused rather than followed.
- Every URL the index names must be **https and on that same host**. A registry publishes files;
  it does not get to name other servers.
- The download stops at the size the index declared, and its **sha256 is verified before a single
  zip entry is read**.
- The package must be a plain folder: no dotfile, no symlink, no nested archive, no absolute or
  climbing path, at most 200 files, 5 MB packed, 20 MB unpacked.
- The manifest must validate, its `id` must be the one you asked for, and its `sdk` must be one
  this Fremkit speaks. A widget asking for a newer SDK says "needs a newer Fremkit" rather than
  installing and half-working.
- `permissions.network` may not name a private, loopback or link-local host — the same rule a
  built-in lives under, so a widget cannot use the proxy to read your own machine.

The folder is built somewhere else and moved into place, with the previous version kept until
the move succeeds, so a failure halfway through leaves the widget that was working exactly as it
was.

Every message you see is Fremkit's own sentence. Never the registry's body, never the URL, never
an exception: an installer that quotes what a remote server said is a remote server writing into
your admin.

## When the registry is unreachable

The Browse tab keeps the last list it read and says the registry could not be reached. An empty
list would read as "every widget was withdrawn", which is a different and much more alarming
thing. The refresh button (⟳) goes back out on demand; otherwise the index is re-read once a day.

## Publishing a widget

Write it against [writing-widgets.md](writing-widgets.md), then open a pull request on the
registry — its [CONTRIBUTING](https://github.com/fdussert/fremkit-widgets/blob/main/CONTRIBUTING.md)
is the whole procedure. `version` is semver and must go up; a version that is published stays
published at those bytes.
