#!/usr/bin/env python3
"""Fremkit — production de tous les livrables de marque."""
import os, shutil, struct
import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS = os.environ.get("FREMKIT_FONTS", "fonts")
for sub in ("icon/png", "icon/Fremkit.iconset", "menubar", "favicon", "social", "variants/png", "wallpaper"):
    os.makedirs(f"{ROOT}/{sub}", exist_ok=True)

# ------------------------------------------------------------------ palette
BG_DEEP = "#0b0d10"
BG      = "#14171c"
BLUE    = "#2f6feb"
SAND    = "#d9b36a"
SAND_BK = "#9a7540"
LIGHT   = "#eef2f8"
MUTED   = "#8b93a1"

SQ_X = SQ_Y = 100
SQ_W = 824
SQ_R = 185.4

DUNE_FRONT = ("M 100 906 C 268 902 410 882 500 848 C 566 823 600 782 660 770 "
              "C 690 776 730 800 760 830 C 812 878 872 890 924 888 "
              "L 924 1024 L 100 1024 Z")
DUNE_BACK  = ("M 100 878 C 190 872 250 840 320 826 C 380 814 440 822 510 842 "
              "C 600 868 700 886 780 892 C 840 896 890 898 924 898 "
              "L 924 1024 L 100 1024 Z")

# ------------------------------------------------------------------ le "F"
FX, FY, FS, FR = 240, 262, 92, 12
FW, FH = 544, 376
F_BLUE_W, F_MID_W, F_MID_DY = 430, 372, 148


def f_bars(color_top=SAND, color_acc=SAND_BK, color_body=LIGHT):
    return "\n".join([
        f'<rect x="{FX}" y="{FY}" width="{F_BLUE_W}" height="{FS}" rx="{FR}" fill="{color_top}"/>',
        f'<rect x="{FX+F_BLUE_W-FR}" y="{FY}" width="{FW-F_BLUE_W+FR}" height="{FS}" rx="{FR}" fill="{color_acc}"/>',
        f'<rect x="{FX}" y="{FY+F_MID_DY}" width="{F_MID_W}" height="{FS}" rx="{FR}" fill="{color_body}"/>',
        f'<rect x="{FX}" y="{FY}" width="{FS}" height="{FH}" rx="{FR}" fill="{color_body}"/>',
    ])


def svg1024(body, defs=""):
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" '
            f'viewBox="0 0 1024 1024">\n<defs>{defs}</defs>\n{body}\n</svg>\n')


CLIP = (f'<clipPath id="sq"><rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" '
        f'rx="{SQ_R}" ry="{SQ_R}"/></clipPath>')


# ============================================== 1. icone d'app macOS
def app_icon():
    body = "\n".join([
        f'<rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}" fill="{BG}"/>',
        '<g clip-path="url(#sq)">',
        f'<path d="{DUNE_BACK}" fill="{SAND_BK}"/>',
        f'<path d="{DUNE_FRONT}" fill="{SAND}"/>',
        '</g>',
        f_bars(),
    ])
    return svg1024(body, CLIP)


# ============================================== 1 bis. variante bleue (accent produit)
def app_icon_blue():
    body = "\n".join([
        f'<rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}" fill="{BG}"/>',
        '<g clip-path="url(#sq)">',
        f'<path d="{DUNE_BACK}" fill="{SAND_BK}"/>',
        f'<path d="{DUNE_FRONT}" fill="{SAND}"/>',
        '</g>',
        f_bars(color_top=BLUE, color_acc=SAND),
    ])
    return svg1024(body, CLIP)


# ============================================== 2. marque pleine page (favicon)
# meme dessin, sans les marges Apple : on dilate le contenu de 1024/824
def mark_color(radius=232):
    k = 1024 / SQ_W
    inner = "\n".join([
        f'<rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}" fill="{BG}"/>',
        '<g clip-path="url(#sq)">',
        f'<path d="{DUNE_BACK}" fill="{SAND_BK}"/>',
        f'<path d="{DUNE_FRONT}" fill="{SAND}"/>',
        '</g>',
        f_bars(),
    ])
    body = (f'<g transform="translate(512,512) scale({k:.6f}) translate(-512,-512)">{inner}</g>')
    return svg1024(body, CLIP)


# dune autonome : silhouette fermee sur sa propre ligne de sol, sans cadre
DUNE_SOLO = ("M 180 822 C 320 818 430 794 522 758 C 584 734 604 708 648 700 "
             "C 684 694 716 716 748 742 C 800 784 846 810 884 822 Z")


def mark_mono():
    """Silhouette monochrome autonome, sans fond ni cadre — currentColor."""
    inner = "\n".join([
        f'<path d="{DUNE_SOLO}"/>',
        f'<rect x="{FX}" y="{FY}" width="{FW}" height="{FS}" rx="{FR}"/>',
        f'<rect x="{FX}" y="{FY+F_MID_DY}" width="{F_MID_W}" height="{FS}" rx="{FR}"/>',
        f'<rect x="{FX}" y="{FY}" width="{FS}" height="{FH}" rx="{FR}"/>',
    ])
    return svg1024(f'<g fill="currentColor">{inner}</g>')


# ============================================== 3. glyphe barre de menus (template)
def menubar_glyph(with_dune=False, fill="#000000"):
    """18 pt. Par defaut le F seul : a 18 px la dune devient du bruit."""
    s, r = 5.4, 1.3
    if with_dune:
        x0, y0, W, H = 6.4, 4.2, 23.2, 18.6
        dune = ("M 6.0 31.8 C 11 31.4 15 29.6 18.6 27.8 "
                "C 21.4 26.4 23.6 27.2 25.8 28.8 C 27.8 30.2 29 31.2 30.4 31.8 Z")
    else:
        x0, y0, W, H = 5.6, 5.4, 24.8, 25.2
        dune = None
    mid_w = W * 0.66
    parts = [
        f'<rect x="{x0}" y="{y0}" width="{W}" height="{s}" rx="{r}"/>',
        f'<rect x="{x0}" y="{y0+s+3.8:.2f}" width="{mid_w:.2f}" height="{s}" rx="{r}"/>',
        f'<rect x="{x0}" y="{y0}" width="{s}" height="{H}" rx="{r}"/>',
    ]
    if dune:
        parts.append(f'<path d="{dune}"/>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" '
            f'viewBox="0 0 36 36" fill="{fill}">\n' + "\n".join(parts) + '\n</svg>\n')


# ============================================== ecriture des SVG sources
files = {
    f"{ROOT}/icon/fremkit-icon.svg": app_icon(),
    f"{ROOT}/favicon/fremkit-mark-color.svg": mark_color(),
    f"{ROOT}/favicon/fremkit-mark-mono.svg": mark_mono(),
    f"{ROOT}/menubar/fremkit-menubar-template.svg": menubar_glyph(),
    f"{ROOT}/menubar/fremkit-menubar-dune-template.svg": menubar_glyph(with_dune=True),
    f"{ROOT}/variants/fremkit-icon-blue.svg": app_icon_blue(),
}
for p, s in files.items():
    open(p, "w").write(s)

# ============================================== PNG de l'icone
ICON_SVG = f"{ROOT}/icon/fremkit-icon.svg"
SIZES = [16, 32, 64, 128, 256, 512, 1024]
for s in SIZES:
    cairosvg.svg2png(url=ICON_SVG, write_to=f"{ROOT}/icon/png/fremkit-icon-{s}.png",
                     output_width=s, output_height=s)
    cairosvg.svg2png(url=ICON_SVG, write_to=f"{ROOT}/icon/png/fremkit-icon-{s}@2x.png",
                     output_width=s * 2, output_height=s * 2)

# variante bleue
ALT_SVG = f"{ROOT}/variants/fremkit-icon-blue.svg"
for s in SIZES:
    cairosvg.svg2png(url=ALT_SVG, write_to=f"{ROOT}/variants/png/fremkit-icon-blue-{s}.png",
                     output_width=s, output_height=s)
    cairosvg.svg2png(url=ALT_SVG, write_to=f"{ROOT}/variants/png/fremkit-icon-blue-{s}@2x.png",
                     output_width=s * 2, output_height=s * 2)

# .iconset (nomenclature Apple, pret pour `iconutil -c icns`)
ICONSET = [("16x16", 16, 32), ("32x32", 32, 64), ("128x128", 128, 256),
           ("256x256", 256, 512), ("512x512", 512, 1024)]
for name, one, two in ICONSET:
    shutil.copy(f"{ROOT}/icon/png/fremkit-icon-{one}.png",
                f"{ROOT}/icon/Fremkit.iconset/icon_{name}.png")
    shutil.copy(f"{ROOT}/icon/png/fremkit-icon-{two}.png",
                f"{ROOT}/icon/Fremkit.iconset/icon_{name}@2x.png")

# .icns assemble directement (pas d'iconutil hors macOS)
ICNS_TYPES = [(b"icp4", 16), (b"icp5", 32), (b"ic11", 32), (b"ic12", 64),
              (b"ic07", 128), (b"ic13", 256), (b"ic08", 256), (b"ic14", 512),
              (b"ic09", 512), (b"ic10", 1024)]
chunks = b""
for tag, px in ICNS_TYPES:
    data = open(f"{ROOT}/icon/png/fremkit-icon-{px}.png", "rb").read()
    chunks += tag + struct.pack(">I", len(data) + 8) + data
open(f"{ROOT}/icon/Fremkit.icns", "wb").write(b"icns" + struct.pack(">I", len(chunks) + 8) + chunks)

# ============================================== glyphe barre de menus PNG
for src, stem in ((f"{ROOT}/menubar/fremkit-menubar-template.svg", "fremkitTemplate"),
                  (f"{ROOT}/menubar/fremkit-menubar-dune-template.svg", "fremkitDuneTemplate")):
    cairosvg.svg2png(url=src, write_to=f"{ROOT}/menubar/{stem}.png", output_width=18, output_height=18)
    cairosvg.svg2png(url=src, write_to=f"{ROOT}/menubar/{stem}@2x.png", output_width=36, output_height=36)

# ============================================== favicons PNG
MK = f"{ROOT}/favicon/fremkit-mark-color.svg"
for s in (16, 32, 48, 180, 512):
    cairosvg.svg2png(url=MK, write_to=f"{ROOT}/favicon/favicon-{s}.png",
                     output_width=s, output_height=s)
shutil.copy(f"{ROOT}/favicon/fremkit-mark-color.svg", f"{ROOT}/favicon/favicon.svg")
# favicon.ico multi-resolution
ico = Image.open(f"{ROOT}/favicon/favicon-512.png").convert("RGBA")
ico.save(f"{ROOT}/favicon/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

# ============================================== image sociale 1280x640
SW, SH = 1280, 640
ICON_PX, ICON_TOP = 196, 122
NAME_TOP, TAG_TOP = 352, 464

SOC_BACK = ("M 0 588 C 160 584 250 560 360 550 C 450 542 540 554 640 572 "
            "C 760 594 900 606 1280 608 L 1280 640 L 0 640 Z")
SOC_FRONT = ("M 0 606 C 200 602 360 588 470 566 C 560 548 616 522 690 514 "
             "C 734 509 772 522 812 540 C 910 584 1080 604 1280 606 L 1280 640 L 0 640 Z")
SOC_CREST = ("M 0 606 C 200 602 360 588 470 566 C 560 548 616 522 690 514 "
             "C 734 509 772 522 812 540 C 910 584 1080 604 1280 606")

bg_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{SW}" height="{SH}" viewBox="0 0 {SW} {SH}">
  <rect width="{SW}" height="{SH}" fill="{BG_DEEP}"/>
  <path d="{SOC_BACK}" fill="#131820"/>
  <path d="{SOC_FRONT}" fill="#1a2028"/>
  <path d="{SOC_CREST}" fill="none" stroke="{SAND}" stroke-opacity="0.30"
        stroke-width="3" stroke-linecap="round"/>
</svg>'''
open("/tmp/_social_bg.svg", "w").write(bg_svg)
cairosvg.svg2png(url="/tmp/_social_bg.svg", write_to="/tmp/_social_bg.png",
                 output_width=SW, output_height=SH)
social = Image.open("/tmp/_social_bg.png").convert("RGB")
sd = ImageDraw.Draw(social)

cairosvg.svg2png(url=f"{ROOT}/icon/fremkit-icon.svg", write_to="/tmp/_social_mark.png",
                 output_width=ICON_PX, output_height=ICON_PX)
mk = Image.open("/tmp/_social_mark.png").convert("RGBA")
social.paste(mk, ((SW - ICON_PX) // 2, ICON_TOP), mk)

f_name = ImageFont.truetype(f"{FONTS}/Inter-700.ttf", 84)
f_tag  = ImageFont.truetype(f"{FONTS}/Inter-400.ttf", 28)


def centered(draw, y, text, font, fill):
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    draw.text(((SW - (r - l)) // 2 - l, y - t), text, font=font, fill=fill)


centered(sd, NAME_TOP, "Fremkit", f_name, LIGHT)
centered(sd, TAG_TOP, "Widget dashboard for the Corsair Xeneon Edge", f_tag, "#98a1ae")

social.save(f"{ROOT}/social/fremkit-social-1280x640.png")

# version SVG editable de l'image sociale
k_soc = ICON_PX / 1024
social_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{SW}" height="{SH}" viewBox="0 0 {SW} {SH}">
  <rect width="{SW}" height="{SH}" fill="{BG_DEEP}"/>
  <path d="{SOC_BACK}" fill="#131820"/>
  <path d="{SOC_FRONT}" fill="#1a2028"/>
  <path d="{SOC_CREST}" fill="none" stroke="{SAND}" stroke-opacity="0.30" stroke-width="3" stroke-linecap="round"/>
  <g transform="translate({(SW-ICON_PX)//2},{ICON_TOP}) scale({k_soc:.6f})">
    <rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}" fill="{BG}"/>
    <clipPath id="sq2"><rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}"/></clipPath>
    <g clip-path="url(#sq2)">
      <path d="{DUNE_BACK}" fill="{SAND_BK}"/>
      <path d="{DUNE_FRONT}" fill="{SAND}"/>
    </g>
    {f_bars()}
  </g>
  <text x="640" y="418" text-anchor="middle" font-family="Inter, -apple-system, Helvetica, Arial, sans-serif"
        font-size="84" font-weight="700" fill="{LIGHT}">Fremkit</text>
  <text x="640" y="486" text-anchor="middle" font-family="Inter, -apple-system, Helvetica, Arial, sans-serif"
        font-size="28" font-weight="400" fill="#98a1ae">Widget dashboard for the Corsair Xeneon Edge</text>
</svg>
'''
open(f"{ROOT}/social/fremkit-social.svg", "w").write(social_svg)

# ============================================== fond d'ecran 2560x720
# Le fond de l'Edge : la meme langue graphique que l'image sociale, sans aucun texte — il passe
# derriere des widgets. Les vagues sont celles de l'image sociale, x2 en largeur et decalees vers
# le bas de 80 px (640 -> 720), et la marque est posee petite et discrete dans le coin.
WPW, WPH = 2560, 720
WP_MARK_PX, WP_MARK_X, WP_MARK_Y = 140, 2364, 486
WP_MARK_OPACITY = 0.10

WP_BACK = ("M 0 668 C 320 664 500 640 720 630 C 900 622 1080 634 1280 652 "
           "C 1520 674 1800 686 2560 688 L 2560 720 L 0 720 Z")
WP_FRONT = ("M 0 686 C 400 682 720 668 940 646 C 1120 628 1232 602 1380 594 "
            "C 1468 589 1544 602 1624 620 C 1820 664 2160 684 2560 686 L 2560 720 L 0 720 Z")
WP_CREST = ("M 0 686 C 400 682 720 668 940 646 C 1120 628 1232 602 1380 594 "
            "C 1468 589 1544 602 1624 620 C 1820 664 2160 684 2560 686")

k_wp = WP_MARK_PX / 1024
wallpaper_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{WPW}" height="{WPH}" viewBox="0 0 {WPW} {WPH}">
  <rect width="{WPW}" height="{WPH}" fill="{BG_DEEP}"/>
  <path d="{WP_BACK}" fill="#131820"/>
  <path d="{WP_FRONT}" fill="#1a2028"/>
  <path d="{WP_CREST}" fill="none" stroke="{SAND}" stroke-opacity="0.30" stroke-width="3" stroke-linecap="round"/>
  <g transform="translate({WP_MARK_X},{WP_MARK_Y}) scale({k_wp:.6f})" opacity="{WP_MARK_OPACITY}">
    <rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}" fill="{BG}"/>
    <clipPath id="sqwp"><rect x="{SQ_X}" y="{SQ_Y}" width="{SQ_W}" height="{SQ_W}" rx="{SQ_R}" ry="{SQ_R}"/></clipPath>
    <g clip-path="url(#sqwp)">
      <path d="{DUNE_BACK}" fill="{SAND_BK}"/>
      <path d="{DUNE_FRONT}" fill="{SAND}"/>
    </g>
    {f_bars()}
  </g>
</svg>
'''
open(f"{ROOT}/wallpaper/fremkit-wallpaper.svg", "w").write(wallpaper_svg)
cairosvg.svg2png(url=f"{ROOT}/wallpaper/fremkit-wallpaper.svg",
                 write_to=f"{ROOT}/wallpaper/fremkit-wallpaper.png",
                 output_width=WPW, output_height=WPH)

print("build ok")
