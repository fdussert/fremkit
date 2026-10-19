# Sharing a layout

A page, a screen or a whole setup can be written to a `.fremkit-layout.json` and loaded on another
Mac. This page says what goes in the file, what never does, and how a file from somebody else is
read. The code is `server/src/share/` (building and reading the file) and
`ui/src/admin/share*.ts`, `ShareExportDialog.vue`, `ShareImportDialog.vue` (the admin's side).

## Exporting

| From | Exports |
|---|---|
| A page's right-click menu → **Export page…** | that page, with the grid it was made for |
| A screen's right-click menu → **Export screen…** | its pages, its bar, its look (bar height, opacity, auto-cycle, background) |
| **Settings → Share**, or a screen's menu → **Export the whole setup…** | every screen |

The dialog is the server's report on the exact file it would write: the widgets with their
version and where they come from (built in, on the Sietch, or only on this Mac — the last kind
cannot be installed by whoever loads the file), the theme, the embedded images, and everything
left out, with the reason. **See the file** shows it, image bytes aside.

**Download** saves it through the browser — in the helper's admin window, through its save panel,
exactly like the backup. **Copy** puts the same text on the clipboard, for when a download is not
possible.

### What goes in

- Each tile's place and size, and each bar entry's side and popover.
- Each widget's look: title, surface and accent colours, accent mode, opacity, background image.
- Each widget's settings, by the type its manifest gives them:
  - **kept**: booleans, numbers, colours, an enum value from the manifest's options, a time zone,
    a list made only of those;
  - **asked**: free text — a `string`, an enum with no options, the Dock's `apps`, a list with a
    text field. Unticked by default; the preview shows the value beside the checkbox;
  - **never**: `connection`, `connections` and `pick` settings (they point at your accounts and
    devices), and any key the manifest does not declare.
- The screen's grid and look. A device screen keeps its viewport and orientation, so it can be
  loaded as a screen for a device paired later.
- The theme's id, and the night theme's when you have one — not the schedule.
- The background images, embedded: up to 4 MB each and 12 MB in all, so a whole file stays under
  the 25 MB a GitHub attachment may weigh. A bigger one is listed as left out. The wallpaper every
  install ships is named, not copied. Images are renamed `image-1.png`, … : the name you uploaded
  them under may say more than the picture.

### What never goes in

Connections, their fields and secrets; host names and addresses; e-mail addresses; device names;
the privacy switches; the marketplace's consent records; paired devices; brightness settings (the
day/night schedule carries your coordinates). Instance ids are replaced by `w1`, `w2`, … for the
same reason as image names.

The last net is the diagnostics' own `redact()` (`server/src/diagnostics/redact.ts`), fed with
this Mac's connection secrets and hosts, the names of connections, devices and device screens,
the Mac's names, the home folder and the account. Every page name, screen name, tile title and
setting value goes through it: a setting it changes is left out, a title is dropped, a page or
screen name becomes `Page 2`, `Screen 2`. The finished file is walked once more and refused if
anything still trips it.

## Importing

Drop a file anywhere on the editor, or use **Import a layout…** (Settings → Share, or a
screen's menu). The server reads it first — it is somebody else's file, so nothing in it is taken
at its word:

- the schema is checked (a file from a newer Fremkit says so rather than being half-read), and
  every value is bounded;
- settings are checked again against **this** Mac's manifests, with the same rules as an export,
  and any value naming one of your connection ids is dropped — a file cannot attach a widget to
  one of your accounts;
- tiles that would overlap, leave their grid, or appear twice on one screen are dropped;
- images must really be PNG, JPEG or WebP, and within the same size limits.

The dialog then lists the widgets: those this Mac has, those it can install from the Sietch (each
**Install…** opens the usual consent dialog — never silently), and those it cannot (only on the
author's Mac, or unknown). A widget that is not installed is left out of the import. Settings that
need a connection ask which of yours to use, or let you choose later in the widget's settings.
The file's theme is offered when it is not the one in use: switched to if this Mac has it,
installable when the Sietch does.

**Where** decides what happens:

| File | Add (the default) | Replace |
|---|---|---|
| a page | a new page at the end of the screen being edited | the page being edited |
| a screen | a new screen | the pages, bar and look of the screen being edited |
| a setup | its screens beside yours | all your screens |

A replaced screen keeps its id, its grid and its brightness, so the Edge and a paired device go on
showing it; a setup's screens take the place of yours kind by kind (Edge for Edge, device for
device). Pages made for another grid are re-arranged to fit, as **Copy to screen** does. The
images go into your background library, and the whole import is one edit: **⌘Z** takes it back.

While iPad screens are an experimental feature that is off (see [devices.md](devices.md#turn-it-on)),
a screen or setup file's iPad screens are skipped, with the widgets only they show: the dialog says
so before the import and the message after it. A file with nothing but iPad screens imports
nothing. Edge screens import as above, a page file is unaffected, and **Replace** leaves the iPad
screens already on this Mac as they are.

## The file

```json
{
  "format": "fremkit-layout",
  "version": 1,
  "fremkit": "0.4.1",
  "scope": "page",
  "theme": { "day": "edge" },
  "widgets": {
    "w1": { "widgetId": "clock", "showTitle": true, "settings": { "seconds": true } }
  },
  "catalog": { "clock": { "version": "1.2.1", "source": "builtin" } },
  "screens": [{
    "name": "Xeneon Edge", "kind": "edge",
    "display": { "cols": 64, "rows": 16, "cell": 40, "autoCycleSeconds": 0 },
    "nav": [],
    "pages": [{ "name": "Home", "items": [{ "widget": "w1", "x": 0, "y": 0, "w": 16, "h": 4 }] }]
  }],
  "images": {}
}
```

`scope` is `page` (one screen, one page, no bar), `screen` (one screen) or `setup`. `source` is
`builtin`, `sietch` or `local`. An image is `{ "data": "<base64>" }` or `{ "shipped": true }`. The
schema is `server/src/share/format.ts`; `version` goes up when a file written by a newer Fremkit
could not be read correctly by this one.
