# The widget marketplace

Fremkit ships with eighteen widgets. Everything else is published to a registry instead, and
installed from the admin — so a new widget does not need a new Fremkit, and a Fremkit with no
network still starts with a working dashboard.

The registry is [fdussert/fremkit-sietch](https://github.com/fdussert/fremkit-sietch): one
folder per widget, curated by pull request, packed by a workflow and published as an
`index.json` on GitHub Pages. There is exactly one, and its address is a constant in the code
rather than a setting — adding a second is a decision nobody has taken.

## What moved, and why

Eight widgets that used to ship — `bambu-job`, `homey-devices`, `homey-flows`, `mutedeck`,
`cleanshot`, `ado-pipelines`, `github-actions`, `github-inbox` — are published on the registry
now, beside the two Synology ones that always were. The rule they were sorted by: **the core
ships what works on any Mac with no account, no hardware and no third-party application.** A
Bambu widget on a Mac with no printer is a tile that will never say anything; a clock is not.

What did **not** move is the code that talks to those things. A provider holds an address and a
token and puts them in the keychain; a widget is HTML in a sandbox that can only read the
channels its manifest declares and the user consented to. That line is the security line, not a
packaging decision, so every provider and every connection type stayed in the core. Creating a
Homey connection in the admin therefore lists the Homey widgets, with an Install beside the ones
this machine does not have.

**An existing dashboard keeps its tiles.** A tile whose widget is no longer installed says "not
installed" rather than showing a raw id, its inspector offers the install, and the Sietch panel
counts them all — "3 widgets placed on your screens are not installed" — behind one consent
dialog rather than three.

## Installing something

*Admin → **Sietch** in the top bar.* Three views: **Available** is everything the registry
publishes, **Installed** is what this machine has, **Updates** is what is waiting. The entry
carries a count when something is.

Each card says what the widget is, who wrote it, under which licence, how big the download is,
and what it asks for. A widget that needs a connection says so — "needs a Synology connection" —
which is the one thing worth knowing before you spend a download on it. Create the connection
first if you have not: *Connections* in the top bar.

Pressing **Install** shows what the widget will be allowed to do, and nothing is downloaded
until you agree. Accepting records that grant in your config, beside the version and the
registry it came from. A widget that asks for nothing at all — a clock, a timer — has nothing
to show, so it installs without a dialog.

What you accept is what is checked. The card is drawn from the registry's index, which is text
the registry writes; the permissions that end up granted are read from the manifest *inside* the
package, which is the thing whose hash was verified. If the two disagree, the install is refused
and the dialog opens again on the package's real ask — so a registry cannot advertise one
permission and ship three.

Installed widgets appear in the **Installed** tab like the built-in ones, marked `installed vX`,
and are placed on a page the same way. If one is asking for something it has not been granted —
an update landed and you have not accepted it — its card says so, with the ungranted entries
struck through: the widget is not broken, it is waiting for you.

## Updates

An update is offered when the registry publishes a version newer than yours. The Sietch entry
carries the count, and the widget's card in the left column carries a `↑ version` chip that
opens the panel on the Updates view.

- An update whose permissions are **the same or narrower** installs straight away.
- One that asks for **anything new** — one more channel, one more command, one more host — asks
  again, and shows you the difference rather than the whole list a second time.

That rule is enforced by the server, not by the dialog. The consent record is what a widget is
allowed to do; the manifest on disk is only what it *asks* for, and everything downstream is
handed the intersection. A channel the manifest declares and the record does not is refused
exactly like one that was never declared — so an update that quietly widened its own manifest
would gain nothing by it.

**Update all** does the lot in one request, behind one dialog. The dialog names every waiting
widget and what each one is newly asking for — the ones asking for nothing say so, rather than
being left out and leaving you to guess which of the five it was about. What it grants is what
it listed: the server checks each package against its own entry and refuses the ones it was not
given, so a widget that turns out to want more than was shown is skipped and says so in its row
rather than being updated anyway.

One failure does not stop the others. A run of five where the second package does not match its
hash still updates the other four, and each row says what happened to it.

## Removing one

**Remove** on the card, in the Installed view. Fremkit refuses while the widget is still on a page
or in the navigation bar, and names the places: removing it under your layout would leave holes
you never asked for. Take it off the pages first.

Removing a widget deletes its folder and its consent record. Its settings on a page go with the
tile you removed.

## Where it all lives

| | |
|---|---|
| Built-in widgets | `widgets/` in the checkout — updated by `git pull`, never by the admin |
| Installed widgets | `data/widgets/<id>/` — git-ignored, and moved by `FREMKIT_DATA_DIR` |
| Built-in themes | `themes/` in the checkout: `fremkit` and `edge` |
| Installed themes | `data/themes/<id>/` — the same rules, the same folder's worth of protection |
| What was granted | `marketplace.installed` in `data/fremkit.json`, each record saying its `kind` |

Neither a widget nor a theme installed from the registry can take the id of a built-in: the
installer refuses the collision, and a folder dropped in by hand is reported as an error while
the built-in keeps the id. A record written before themes could be installed has no `kind` and is
read as a widget, which is the only thing it could have been.

## Themes

A theme goes through all of this and is the safest thing in it. It is one JSON file of colour
tokens: no code, nothing served, nothing subscribed to, no network host. So:

- **No consent dialog**, because there would be nothing on it. The record is written with an
  empty grant, which says that plainly — a missing one would read as "not recorded yet".
- **A much tighter package**: `theme.json`, at most a `README.md`, 64 KB, and nothing else at
  all. The allow-list is by name rather than by rule, which is the whole reason a theme is cheap
  to trust.
- **Every token validated**, by the same `TokensSchema` a theme on your own disk meets — one
  expression per token. That is what stands in for the dialog: these values end up in a `style`
  attribute on `<html>` and inside every widget frame, so the check is the protection.
- **Removing the one in use is refused**, naming it, rather than repainting the screen in
  something nobody chose.

Install them from *Sietch* → **Themes**; they land in `data/themes/` and show up in Screen →
Theme at once. See [themes.md](themes.md).

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

The panel keeps the last list it read and says the registry could not be reached. An empty
list would read as "every widget was withdrawn", which is a different and much more alarming
thing. The refresh button (⟳) goes back out on demand; otherwise the index is re-read once a day.

## Publishing a widget

Write it against [writing-widgets.md](writing-widgets.md), then open a pull request on the
registry — its [CONTRIBUTING](https://github.com/fdussert/fremkit-sietch/blob/main/CONTRIBUTING.md)
is the whole procedure. `version` is semver and must go up; a version that is published stays
published at those bytes.
