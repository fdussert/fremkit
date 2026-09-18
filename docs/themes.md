# Themes

A theme is the palette, the fonts and the text size of everything Fremkit draws: the dashboard,
the navigation bar, the editor, and the widgets themselves. It is a folder with one JSON file, the
same shape a widget install takes, so yours lives beside the built-in ones and never collides with
them when you pull.

```
themes/
  fremkit/theme.json    the built-in theme: graphite and sand
  edge/theme.json       anodised graphite, cream legends, larger text, no tile cards
  nuit/theme.json       midnight blue, cool accent
  brume/theme.json      soft slate and sage, larger text
  terminal/theme.json   green phosphor, monospace throughout
  papier/theme.json     light: dark ink on warm paper
  mine/theme.json       yours
```

Pick one in the editor: **Screen** → **Theme**. The dashboard repaints at once, the editor with
it, so what you see while arranging tiles is what the screen shows. ⟳ next to the list rereads the
folder, exactly like the widget library's.

## theme.json

```json
{
  "id": "mine",
  "name": { "fr": "Le mien", "en": "Mine" },
  "version": "1.0.0",
  "description": { "fr": "Bleu nuit", "en": "Midnight blue" },
  "tokens": {
    "bg": "#0a1020",
    "surface": "#111a2e",
    "accent": "#5fa8ff",
    "text-scale": 1.2
  }
}
```

| Field | Required | What it is |
|---|---|---|
| `id` | yes | Matches the folder name, `[a-z0-9_-]+` |
| `name` | yes | Shown in the theme list; one string, or a `{ fr, en }` pair |
| `version` | yes | Semver, `1.0.0` |
| `description` | no | One line under the list |
| `tokens` | no | The values this theme changes; everything else keeps the built-in theme's |

A theme only has to name what it changes: the values it leaves out come from `fremkit`, so a
five-line theme that moves the accent and the background is a complete theme.

## The tokens

Colours are `#rgb`, `#rrggbb` or `#rrggbbaa`. Lengths are `px`, `rem` or `em`. A shadow is
offsets, a blur, a spread and a colour — `rgb()`, `rgba()`, `hsl()`, `hsla()` and nothing else,
since these values end up in a `style` attribute inside every widget frame. A value that could
close its declaration and start another one is refused when the folder is read, and the theme is
listed with the reason instead of being painted.

| Token | Paints |
|---|---|
| `bg` | The page behind the tiles |
| `surface`, `surface-2`, `surface-3` | Tiles, and the two shades above them (fields, keys) |
| `border`, `border-strong` | Separators, and the ones that need to be seen |
| `tile-surface`, `tile-outline` | The card a tile is drawn on. Either may be transparent (`#00000000`): `edge` keeps a surface and drops the outline |
| `text`, `text-muted`, `text-dim` | Body text, secondary text, and the faintest labels |
| `accent`, `accent-hover`, `accent-2` | The accent, its hover, and a quieter second one |
| `on-accent` | Text drawn on the accent |
| `ok`, `warn`, `danger` | The three states |
| `font`, `font-mono` | The two family stacks |
| `fs-xs`, `fs-sm`, `fs-md`, `fs-lg` | The editor's and the navigation bar's type scale |
| `radius-sm`, `radius-md` | Corner radii |
| `shadow`, `ring` | The tile shadow, and the focus ring. `none`, or one or more shadows |
| `text-scale` | How much bigger widgets draw their own text (0.8 to 2) |

### Why `text-scale` rather than a font size

A widget sizes its text from the tile it is given — a clock fills its height, a list counts how
many rows fit — so a theme cannot hand it a size without breaking that arithmetic. It hands it a
multiplier instead: every size a widget computes is multiplied by `var(--text-scale, 1)`, so a
tile that fits at 1 still fits at 1.2, with larger text.

Past roughly 1.3, long labels start to be clipped on small tiles. That is a property of the tile,
not a bug: give the widget another row, or lower the scale.

## What a widget sees

The tokens are custom properties on the widget's own `<html>`, so a widget reads them the way the
dashboard does:

```css
.value { color: var(--text, #e6e8eb); font-size: calc(28px * var(--text-scale, 1)); }
.label { color: var(--text-muted, #8b93a0); font-family: var(--font, -apple-system, system-ui, sans-serif); }
```

Always with the fallback: it is what the widget paints when no theme is applied, and what keeps it
working on its own. A widget that reads none of them keeps its own colours — a theme never forces
anything on it.

Two properties still belong to the tile rather than to the theme, and are painted after it:
`--accent`, when the tile carries an accent colour of its own, and `--on-surface`, the text colour
the host computed for the body it painted. A colour chosen in the editor therefore wins over the
theme, which is what the person setting up that tile expects.

## Tiles without a card

A tile is a card: `tile-surface` painted inside `tile-outline`. A theme that sets both to
`#00000000` draws neither, and its widgets sit straight on the page, separated by the grid gaps
alone. Either one alone works as well — `edge` paints a surface and no outline.

It stays a per-tile decision too: **Background** → **Opacity** in the editor fades one tile,
border included, whatever the theme says, and a background colour set there gives a card back to
a single tile on an otherwise flat screen.

## What a theme does not reach yet

Three kinds of colour in the widgets stay where they are:

- the amber `#f0a020` nine widgets paint their own warnings and rings with, next to the theme
  accent it predates;
- two shades in `claude-sessions` (`#0f1216`, `#3a2f14`);
- brand colours, which should not follow a theme at all.

They read well on a dark theme and are the rough edges of a light one. Moving the first two groups
onto `--accent` and `--bg` is a one-line change per widget, and a visible one under the built-in
theme, so it is left as a decision rather than made here.

The volume widget's knob is a third case, on purpose: its gradients are the material the knob is
made of, not a palette.

## What a theme carries for the registry

`version` is semver, so one release can be told from the next. `author`, `homepage` and `license`
are optional and the dashboard paints none of them — they travel with a theme published beside
the widgets, so it keeps its credit and its terms. `homepage` is https, as the registry index
asks of it:

```json
{
  "id": "nuit",
  "name": { "fr": "Nuit", "en": "Night" },
  "version": "1.0.0",
  "author": "Someone",
  "homepage": "https://example.com/nuit",
  "license": "MIT",
  "tokens": { }
}
```

## Keeping your own theme

`themes/mine/theme.json` is a file the repository does not know about: pulling never touches it,
and nothing in the app writes to it. Copy `themes/edge/theme.json`, change the values, press ⟳.
