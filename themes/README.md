# Themes

Two ship with Fremkit:

- `fremkit/` — the built-in theme, and the one every other is layered on. It mirrors
  `ui/src/shared/tokens.css`, so every token a theme can set is already in it.
- `edge/` — anodised graphite with cream legends, larger text and no tile cards.

Two, and not six, for the same reason the core ships eighteen widgets and not twenty-eight: what
is here is what a fresh install needs with no network at all. **`nuit`, `brume`, `terminal` and
`papier` are published on the [registry](https://github.com/fdussert/fremkit-sietch)** and
installed from *Sietch* in the admin, beside the widgets.

Your own goes in `themes/<id>/theme.json` and the repository never touches it — pulling leaves it
alone, and nothing in the app writes to it. Copy `edge/theme.json`, change the values, press ⟳ in
Screen → Theme. See [docs/themes.md](../docs/themes.md); to publish it, the registry's
CONTRIBUTING.
