# Fremkit — brand assets

The "F on a dune" mark: an F built from horizontal bars (the ultra-wide screen), sitting on a
two-crested dune (the Fremen fremkit). Dark ground, all sand — the default icon carries no blue at
all. A blue variant is provided under `variants/`.

## Palette

| Role | Hex | Used for |
|---|---|---|
| Deep ground | `#0b0d10` | the social image's ground, the page background |
| Icon ground | `#14171c` | the body of the rounded square |
| Sand | `#d9b36a` | the front dune, the F's top bar |
| Shaded sand | `#9a7540` | the back dune, the F's accent square |
| Accent blue | `#2f6feb` | the dashboard interface, the blue icon variant |
| Light | `#eef2f8` | the F's stem and middle bar, headings |
| Secondary text | `#98a1ae` | the tagline |

## Geometry

Apple's grid: a 1024×1024 canvas with a centred 824×824 rounded square (100 of margin on each
side) and a 185.4 corner radius. The F occupies 544×376 from (240, 262), with a bar thickness of
92 and a radius of 12. The "full bleed" mark (the favicon) is the same drawing scaled by 1024/824
to remove Apple's margins, which have no business being in a browser tab.

## Layout

```
icon/
  fremkit-icon.svg              1024 vector source
  png/fremkit-icon-{16..1024}.png       plus @2x variants
  Fremkit.iconset/              Apple's naming
  Fremkit.icns                  already assembled, usable as is
menubar/
  fremkit-menubar-template.svg        the F alone — the default template
  fremkit-menubar-dune-template.svg   the variant with the dune
  fremkitTemplate.png / @2x           18 and 36 px
  fremkitDuneTemplate.png / @2x
favicon/
  fremkit-mark-color.svg / favicon.svg
  fremkit-mark-mono.svg         currentColor silhouette, no background
  favicon-{16,32,48,180,512}.png
  favicon.ico                   16 + 32 + 48
social/
  fremkit-social-1280x640.png   the GitHub preview
  fremkit-social.svg            editable version (Inter)
wallpaper/
  fremkit-wallpaper.svg         2560×720, the Edge's default background
  fremkit-wallpaper.png         what the server seeds into the background library
variants/
  fremkit-icon-blue.svg         top bar in #2f6feb
  png/fremkit-icon-blue-{16..1024}.png  plus @2x variants
tools/
  build-assets.py               regenerates everything from the sources
```

## macOS app icon

`Fremkit.icns` ships ready to use. To rebuild it from the `.iconset`:

```sh
iconutil -c icns icon/Fremkit.iconset -o icon/Fremkit.icns
```

In the bundle, `Info.plist` → `CFBundleIconFile` = `Fremkit`.

## Menu bar glyph

The default template is the **F alone**. The dune was dropped at this size: at 18 px it turns into
noise and the glyph starts reading as an "E". The variant with the dune is there if you prefer it,
at 36 px on a Retina display only.

The `Template` suffix in the file name is all AppKit needs to treat the image as a template —
tinted automatically to suit the menu bar's theme:

```swift
let image = NSImage(named: "fremkitTemplate")!
image.isTemplate = true
statusItem.button?.image = image
```

Black on transparent, never coloured: macOS is what applies the tint.

## Blue variant

The same geometry to the pixel: only the top bar becomes `#2f6feb`, with the accent square in
sand. This is the version that ties the icon to the dashboard's interface colour. Reach for it if
the all-sand icon gets lost on a warm background, or if you want the icon to carry the product
accent. It is not the bundle's default icon.

Worth keeping in mind: the default icon no longer carries the application's accent colour. What
ties the icon to the interface is now the shape of the F and the `#14171c` ground, not the colour.

## Favicon and README

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/favicon-180.png">
```

For the README, `fremkit-mark-mono.svg` uses `currentColor`: inlined, it follows GitHub's light or
dark theme on its own. In an `<img>`, GitHub does not pass the inherited colour through — use the
colour version there.

## GitHub social image

`social/fremkit-social-1280x640.png` → Settings → General → Social preview → Upload. The SVG
declares `font-family: Inter`; if the font is not available at render time, the PNG stays the
reference.

## Edge wallpaper

`wallpaper/fremkit-wallpaper.svg` is the 2560×720 background a fresh install starts with: the same
language as the social image — the deep ground, the two wave layers, the sand crest — with the
mark small and faint in the corner and **no text**, because widgets sit on top of it. The server
copies the PNG into the user's background library at start, as an ordinary file that can be picked
and deleted like any upload.

## Regenerating

```sh
python3 -m pip install cairosvg pillow
python3 tools/build-assets.py
```

The script holds all of the geometry — the dune paths, the F's grid, the palette. That is where
the drawing is changed, not in the generated SVGs.
