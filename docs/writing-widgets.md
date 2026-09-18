# Writing a widget

A widget is a folder with a manifest and an HTML page. There is no build step, no framework and no
package to install: the page runs in a sandboxed iframe, and a small bridge object talks to the
dashboard for it.

## The folder

```
widgets/
  my-widget/
    manifest.json
    index.html
```

The folder name and the manifest's `id` must match the shape `[a-z0-9_-]+`. Drop the folder in
`widgets/`, then press the rescan button (⟳) at the top of the admin's widget library — it calls
`POST /api/widgets/rescan` and the widget appears without restarting the server. A manifest that
does not validate is reported there rather than silently ignored.

Fremkit reads widgets from two folders. `widgets/` in the checkout holds the ones that ship with
the server: this is where you develop, and they are the reason a fresh install works with no
network. `data/widgets/` holds the ones installed from the marketplace, and is written by the
admin and by nothing else — it is git-ignored, it moves with `FREMKIT_DATA_DIR`, and a widget
there can never take the id of a built-in: the installer refuses the collision, and a folder
dropped in by hand is reported as an error while the built-in keeps the id.

## manifest.json

```json
{ "id": "clock",
  "name": { "fr": "Horloge", "en": "Clock" },
  "version": "1.2.0",
  "description": { "fr": "Heure et date", "en": "Time and date" },
  "icon": "clock",
  "minSize": [8, 4],
  "defaultSize": [16, 4],
  "compact": { "width": 5 },
  "subscriptions": ["system"],
  "commands": ["volume"],
  "permissions": { "network": ["api.example.com"] },
  "settingsSchema": { }
}
```

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Matches the folder name |
| `name` | yes | Shown in the widget library and as the tile's default title |
| `version` | yes | A semver number — `1.2.0`, `1.0.0-rc.1`. The marketplace orders releases by it |
| `description` | no | One line in the widget library. Default `""` |
| `icon` | no | A [Lucide](https://lucide.dev) icon name. Default `layout-grid` |
| `minSize` | no | `[cols, rows]` in grid cells; the editor refuses anything smaller. Default `[4, 2]` |
| `defaultSize` | no | `[cols, rows]` the widget is dropped at. Defaults to `minSize`, and must be ≥ it |
| `compact` | no | `{ "width": n }`, 2 to 16 cells — see [Compact widgets](#compact-widgets) |
| `subscriptions` | no | The data channels the widget may read. Default `[]` |
| `commands` | no | The channels it may send commands to. Default `[]` |
| `permissions.network` | no | Hosts `Fremkit.fetch` may reach. Default `[]` |
| `settingsSchema` | no | The settings the admin offers — see below. Default `{}` |
| `sdk` | no | The bridge generation the widget needs (`Fremkit.sdk`). Default `1`; a widget asking for more than the server has is refused at install |
| `homepage` | no | An `https` URL, shown in the admin. Never fetched, never executed |
| `author` | no | A name, shown in the admin |
| `license` | no | An [SPDX](https://spdx.org/licenses/) identifier — `MIT`, `Apache-2.0` |

Legacy manifests may declare `sizes` instead of `minSize`; the server converts them, doubling the
coordinates for the current grid.

### Localised text

Every text a manifest puts on screen — `name`, `description`, a setting's `label`, an `enum`
option's label — is either one string, shown as given, or a `{ "fr": …, "en": … }` pair resolved
against the language in force. A missing language falls back to English, then French, then
whatever the object holds.

### Settings

A setting's `type` is one of `boolean`, `string`, `number`, `enum`, `color`, `timezone`,
`connection`, `connections`, `pick`, `apps` or `list`. Every setting takes a `label`, and may take
a `default` and a `scope`.

| Type | Stores | Extra keys |
|---|---|---|
| `boolean` | `true` / `false` | — |
| `string` | a string | — |
| `number` | a number | — |
| `enum` | one option value | `options` (required) |
| `color` | a `#rrggbb` string | — |
| `timezone` | an IANA zone name | — |
| `connection` | one connection id | `connectionType` (required) |
| `connections` | an array of connection ids | `connectionType` (required) |
| `pick` | an array of ids read live from a connection | `connection`, `source` (both required) |
| `apps` | an array of app names the Dock currently shows | — |
| `list` | an array of objects | `itemSchema` (required), `max` |

**`enum`** — an option is either a bare string (its own value and label) or
`{ "value": …, "label": … }`. The `value` lands in the user's config, so it must not move when the
language changes.

```json
"size": { "type": "enum", "label": { "fr": "Taille", "en": "Size" },
          "options": [{ "value": "small", "label": { "fr": "petite", "en": "small" } },
                      { "value": "normal", "label": { "fr": "normale", "en": "normal" } }],
          "default": "normal" }
```

**`timezone`** — a searchable text field backed by the browser's IANA zone list, red while the
typed zone is not one of them.

**`connection` / `connections`** — `connection` stores one id, `connections` an array of them;
both declare which `connectionType` the admin offers. `connections` renders a checkbox list, with
each connection's colour beside it when the type has a colour field.

```json
"calendars": { "type": "connections", "label": "Calendars", "connectionType": "ics", "default": [] }
```

**`pick`** — a multi-select whose choices are read live from a connection rather than typed.

```json
"connection": { "type": "connection", "connectionType": "homey", "label": "Connection" },
"devices": { "type": "pick", "label": { "fr": "Appareils", "en": "Devices" },
             "connection": "connection", "source": "devices", "default": [] }
```

`connection` names the sibling setting of type `connection` holding the connection id, and
`source` is a list that connection type knows how to serve
(`GET /api/connections/<id>/options?source=…`). The admin renders a checkbox list grouped by the
option's `group`, with a filter above eight choices. The widget reads an array of option **ids**,
so renaming a device in its own app does not empty the dashboard. A connection type offers sources
by implementing `options()`; a type that implements none has no `pick` setting pointed at it.

**`list`** — any number of items of one shape, added, removed and reordered in the admin.

```json
"cities": { "type": "list", "label": "Cities", "default": [], "max": 6,
            "itemSchema": { "label":    { "type": "string",   "label": "Label" },
                            "timezone": { "type": "timezone", "label": "Time zone" } } }
```

The widget reads it as an array of objects keyed by `itemSchema`. An item field may be `string`,
`boolean`, `enum`, `number` or `timezone` — never another list, and nothing that needs the admin's
own data, because a row is rendered inline. `max` caps how many items the user may add.

A `string` item field may also declare `suggest`, which gives it a drop-down of suggestions while
the user types. The only source today is `"apps"`, the applications installed on this machine, read
once per admin session from `GET /api/apps/installed` and offered by name. `suggestWhen` narrows
the suggestions to the rows where sibling fields of the same item hold given values.

```json
"buttons": { "type": "list", "label": "Buttons", "default": [],
             "itemSchema": {
               "kind":   { "type": "enum", "label": "Kind", "options": ["app", "url"] },
               "target": { "type": "string", "label": "Target",
                           "suggest": "apps", "suggestWhen": { "kind": "app" } } } }
```

Suggestions never restrict: whatever the user types is stored as typed, so a field keeps working
for an application the scan did not find.

**`scope`** — `"scope": "tile"` or `"scope": "compact"` offers the setting only in the editor of
that rendering: the widget inspector, or the navigation bar's list. Absent means both.

## The `Fremkit` bridge

The bridge is injected into every widget; nothing has to be imported.

```js
Fremkit.whenReady(() => {
  Fremkit.subscribe('system', (d) => { /* d.cpu.load … */ })
  Fremkit.sendCommand('volume', 'set', { level: 40 })
  Fremkit.fetch('https://api.example.com/x')   // host must be declared in permissions.network
})
```

### Properties

| Name | What it is |
|---|---|
| `Fremkit.sdk` | The bridge generation this Fremkit speaks, as a number |
| `Fremkit.instanceId` | This instance's id |
| `Fremkit.settings` | The settings object, manifest defaults merged in |
| `Fremkit.locale` | `'fr'` or `'en'` |
| `Fremkit.showTitle` | Whether the frame drew the title — a widget must never draw its own |
| `Fremkit.size` | `{ w, h, px: { width, height } }`: cells, and pixels |
| `Fremkit.compact` | `true` while drawn in the navigation bar |
| `Fremkit.slot` | `'left'`, `'right'` or `null` — which cluster of the bar |
| `Fremkit.accentMode` | `'none'`, `'frame'` or `'fill'` |
| `Fremkit.accentColor` | The instance's accent, or `null` |
| `Fremkit.onSurface` | The text colour that reads on the tile, or `null` |

### Methods

| Call | What it does |
|---|---|
| `whenReady(cb)` | Runs `cb` once the host has sent the init message, or immediately if it already has |
| `subscribe(channel, cb)` | Listens to a data channel. Returns an unsubscribe function; the host stops relaying a channel once its last listener is gone |
| `sendCommand(channel, name, payload)` | Sends a command. Returns a promise |
| `fetch(url, init)` | GET through the server's proxy. Only the host in `permissions.network` is reachable; `body` and `credentials` are ignored |
| `t(dict, params)` | Resolves a `{ fr, en }` table entry and interpolates `{name}` placeholders |
| `onSettings(cb)` | Fires when the admin edits the settings, without a reload. Returns an off function |
| `onLocale(cb)` | Fires when the language changes. Returns an off function |
| `onResize(cb)` | Fires with the new `size`. Returns an off function |
| `esc(value)` | Escapes a string for HTML: `& < > " '`. Everything remote that goes into `innerHTML` goes through this |
| `el(tag, class, text)` | One element, its `text` set as `textContent` — a tree built this way needs no escaping |
| `color(value, fallback)` | A `#rrggbb` colour or the fallback. Use it for anything written into a `style` attribute |

### CSS the host sets on `<html>`

| Name | What it is |
|---|---|
| `--on-surface` | The text colour computed from the luminance of the body the frame painted |
| `--accent` | The instance's accent colour, when it has one |
| `--on-accent` | The text colour that reads on that accent |
| `.on-light` / `.on-dark` | Which way round the tile is. Write light-body rules as `html.on-light …` |
| `.accent-fill` | The body *is* the accent |
| `.compact` | Drawn in the navigation bar |
| `.slot-left` / `.slot-right` | Which cluster of the bar |

## Conventions

**The frame owns the tile.** It draws the title and paints the surface; the widget draws neither.
Give the body a transparent background and let `--on-surface` carry the text colour.

**Accent with a fallback.** Write `var(--accent, #d9b36a)` and a widget follows the colour chosen
in the admin with no extra code. Under `.accent-fill` the body *is* the accent, so a bar drawn in
it would be invisible: flip those rules to `var(--on-surface)`.

**No text in the HTML.** Text written straight into the body is a placeholder in the wrong
language half the time. Keep the strings in one table and fill the page in from `whenReady`:

```js
const L = { used: { fr: '{size} utilisés', en: '{size} used' } }
el.textContent = Fremkit.t(L.used, { size: '8 GB' })
```

Re-render from `onLocale` and `onSettings` so the widget follows a change without a reload.
Numbers and dates are the widget's own business — `clock` keeps a `locale` setting for the BCP 47
tag it formats with, falling back to the app's language.

**`--h` for compact layouts.** The bar's height is not a whole number of cells, so compact widgets
set their own variable from `Fremkit.size.px.height` and size everything from it:

```js
document.documentElement.style.setProperty('--h', Fremkit.size.px.height + 'px')
```

## Channels

`system`, `processes`, `volume`, `spotify`, `mutedeck`, `clipboard`, `shortcuts`, `cleanshot`,
`network`, `battery`, `service-status`, `config`, `claude-sessions`, `claude-usage`,
`claude-account`, `dock`, plus one per connection: `azure-devops:<connectionId>`,
`bambu:<connectionId>`, `github:<connectionId>`, `homey:<connectionId>`,
and `calendar:<connectionId>` for an ICS connection.

A manifest may declare a whole family with a `:*` suffix — `"subscriptions": ["azure-devops:*"]` —
and build the exact channel from its `connection` setting at runtime.

## permissions.network

`permissions.network` matches the exact hostname only: no port, no IP normalisation. So
`api.example.com` does not cover `www.api.example.com`, and `localhost` does not cover
`127.0.0.1`. The proxy behind `Fremkit.fetch` is GET-only and ignores `body` and `credentials`.

A private, loopback, link-local or otherwise reserved address is refused outright — in the
manifest when it is read, and again at request time for a name that resolves to one. The proxy
runs on the user's Mac, so `127.0.0.1` there would mean the Fremkit API itself and
`169.254.169.254` a metadata service. The answer is relayed as `application/json` or
`text/plain`, never with the upstream's own content type, and never above 1 MB.

## Security

A widget is third-party code, and the host treats it as such.

**What the sandbox guarantees.** The widget runs in a `sandbox="allow-scripts"` iframe *and*
under a `Content-Security-Policy` served with its own files, so the two hold even if someone
opens `/widgets/<id>/index.html` directly. The document has an opaque origin: nothing it does
counts as coming from `http://127.0.0.1:4242`, and `localStorage` throws rather than working.
Scripts and styles load from the widget's own folder; images additionally from `data:` and
`blob:`. There is no `connect-src` at all — `fetch`, `XMLHttpRequest` and `WebSocket` are dead,
and every network call goes through `Fremkit.fetch`. Forms cannot submit, frames cannot be
created, `<base>` cannot be set, and dotfiles in the widget folder are not served.

**The kiosk rules.** The bridge turns a widget document into a panel rather than a page: no
context menu (a long press is one of the dashboard's own gestures, and WebKit would answer it
with "Open Frame in New Window"), no drag, no text selection, no tap highlight, no scrollbars,
no focus ring. It is one `<style data-fremkit="kiosk">` inserted before your own, so a widget
that really has something to select or copy opts back in on that element:

```css
.note, input, textarea { -webkit-user-select: text; user-select: text; }
```

**What is still yours to get right.** The sandbox does not protect the widget from its own data.
Everything a widget renders arrives from somewhere else — a volume name, a calendar title, a
pull request title, a printer field — and any of it can contain `<img src=x onerror=…>`. So:

- anything remote that goes into `innerHTML` goes through `Fremkit.esc()` first;
- better still, build the tree with `Fremkit.el()`, whose text is `textContent` and needs no
  escaping at all;
- a colour written into a `style` attribute goes through `Fremkit.color(value, fallback)`:
  `red; background: url(https://evil.example/x)` is two declarations, and escaping does not stop
  it;
- a number written into a `style` attribute is clamped to a range first.

**A long press reaches a widget as a `contextmenu` event.** The Edge's touch driver turns a press
held past its threshold into a right click, so the page never sees a held button — a timer started
on `pointerdown` is cancelled by the `pointerup` that follows milliseconds later. A widget that
wants a long press listens for `contextmenu`:

```js
document.addEventListener('contextmenu', function () {
  // The bridge has already prevented the default (no menu on the panel) and does not stop the
  // event propagating, so this still runs.
  doTheLongPressThing()
})
```

Keep a pointer timer alongside it if you like: that is what a real mouse, and the plain-Chrome
kiosk path, produce. Ignore a `pointerdown` whose `button` is not `0` there — the driver's long
press arrives as the right button and would only cancel its own hold.

**A widget must not navigate or reload itself.** Setting `location`, or calling
`location.reload()`, gives the frame a new document behind the same `contentWindow` — so the host
drops the widget's subscriptions and stops answering it, for good. Re-render from the data you
already have, or ask the host. (A rescan that recreates the frame is a different thing and is
fine.)

**A widget that declares `homey:*` can drive every settable device on that Homey** — a switch, a
dimmer, a thermostat — and one that declares `shortcuts` can press the buttons configured on its
own tile. The admin shows what each widget asks for; that is the list to read before installing
one from elsewhere.

## Compact widgets

`"compact": { "width": 4 }` says the widget also has a rendering fit for the navigation bar:
`width` grid cells wide, the bar's height tall. The admin's Screen panel then offers it in the
bar's widget list.

There the frame draws no title and no surface — the bar is the surface — `Fremkit.compact` is
`true`, and a `compact` class is set on `<html>`, so the compact layout can be pure CSS. Size
everything from `Fremkit.size.px.height`, which is the bar's height: 80 px or 40 px.

`Fremkit.slot` is the cluster the widget sits in, and the matching `slot-left` / `slot-right`
class is set on `<html>`. The right cluster is pushed against the page dots but each iframe keeps
its allotted width, so a right-hand widget aligns its own content to that edge:

```css
html.compact.slot-right .cwrap { justify-content: flex-end; text-align: right }
```

A widget cannot resize its own iframe, so a setting that needs more room is declared host-side, in
`compactWidth()` (`ui/src/shared/types.ts`). `clock` uses it for `compactDate` and
`compactCities`, which widen it to eight cells.

A bar widget may also be marked **Full widget on touch** in the admin. Touching it then opens the
same widget, at its manifest's `defaultSize`, in a popover above the bar — so a widget with a
compact rendering should still be worth looking at as a tile.

## Examples

Every widget in `widgets/` is a working example. In increasing order of complexity: `memory` (one
channel, no settings), `clock` (a `list`, localised formatting, two compact widths),
`homey-devices` (a connection, a `pick`, commands, a compact mode), `bambu-job` (a connection, an
image stream, nested state).
