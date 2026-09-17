# Fremkit — assets de marque

Icône « F posé sur la dune » : un F construit en barres horizontales (l'écran ultra-large),
posé sur une dune à deux crêtes (le fremkit des Fremen). Fond sombre, tout en sable —
l'icône par défaut ne contient aucun bleu. Une variante bleue est fournie dans `variants/`.

## Palette

| Rôle | Hex | Usage |
|---|---|---|
| Fond profond | `#0b0d10` | fond de l'image sociale, fond de page |
| Fond icône | `#14171c` | corps du carré arrondi |
| Sable | `#d9b36a` | dune avant, barre haute du F |
| Sable ombré | `#9a7540` | dune arrière, carré d'accent du F |
| Bleu accent | `#2f6feb` | interface du dashboard, variante bleue de l'icône |
| Clair | `#eef2f8` | hampe et barre médiane du F, titres |
| Texte secondaire | `#98a1ae` | baseline |

## Géométrie

Grille Apple : canevas 1024×1024, carré arrondi 824×824 centré (marge 100 de chaque côté),
rayon de coin 185,4. Le F occupe 544×376 à partir de (240, 262), épaisseur de barre 92,
rayon 12. La marque « pleine page » (favicon) est le même dessin dilaté de 1024/824 pour
supprimer les marges Apple, qui n'ont pas lieu d'être dans un onglet.

## Arborescence

```
icon/
  fremkit-icon.svg              source vectorielle 1024
  png/fremkit-icon-{16..1024}.png       + variantes @2x
  Fremkit.iconset/              nomenclature Apple
  Fremkit.icns                  déjà assemblé, utilisable tel quel
menubar/
  fremkit-menubar-template.svg        F seul — le template par défaut
  fremkit-menubar-dune-template.svg   variante avec la dune
  fremkitTemplate.png / @2x           18 et 36 px
  fremkitDuneTemplate.png / @2x
favicon/
  fremkit-mark-color.svg / favicon.svg
  fremkit-mark-mono.svg         silhouette currentColor, sans fond
  favicon-{16,32,48,180,512}.png
  favicon.ico                   16 + 32 + 48
social/
  fremkit-social-1280x640.png   aperçu GitHub
  fremkit-social.svg            version éditable (police Inter)
variants/
  fremkit-icon-blue.svg         barre haute en #2f6feb
  png/fremkit-icon-blue-{16..1024}.png  + variantes @2x
tools/
  build-assets.py               régénère tout depuis les sources
```

## Icône d'app macOS

`Fremkit.icns` est fourni prêt à l'emploi. Pour le régénérer depuis le `.iconset` :

```sh
iconutil -c icns icon/Fremkit.iconset -o icon/Fremkit.icns
```

Dans le bundle, `Info.plist` → `CFBundleIconFile` = `Fremkit`.

## Glyphe de barre de menus

Le template par défaut est le **F seul**. La dune a été retirée à cette taille : à 18 px
elle devient du bruit et le glyphe tend à se lire « E ». La variante avec dune est
fournie si tu la préfères en 36 px sur un écran Retina uniquement.

Le suffixe `Template` dans le nom de fichier suffit à ce qu'AppKit traite l'image comme
un template (teinte automatique selon le thème de la barre) :

```swift
let image = NSImage(named: "fremkitTemplate")!
image.isTemplate = true
statusItem.button?.image = image
```

Noir sur transparent, jamais de couleur : c'est macOS qui applique la teinte.

## Variante bleue

Même géométrie au pixel près : seule la barre haute passe en `#2f6feb`, avec le carré
d'accent en sable. C'est la version qui relie l'icône à la couleur d'interface du
dashboard. À sortir si l'icône tout sable se perd sur un fond chaud, ou si tu veux que
l'icône porte l'accent produit. Ce n'est pas l'icône par défaut du bundle.

Conséquence à garder en tête : l'icône par défaut ne porte plus la couleur d'accent de
l'application. Le lien entre l'icône et l'interface passe désormais par la forme du F et
le fond `#14171c`, pas par la couleur.

## Favicon et README

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/favicon-180.png">
```

Pour le README, `fremkit-mark-mono.svg` utilise `currentColor` : il suit automatiquement
le thème clair ou sombre de GitHub s'il est inliné. En `<img>`, GitHub ne transmet pas la
couleur héritée — utiliser alors la version couleur.

## Image sociale GitHub

`social/fremkit-social-1280x640.png` → Settings → General → Social preview → Upload.
Le SVG déclare `font-family: Inter` ; si la police n'est pas disponible au rendu, le PNG
reste la référence.

## Régénérer

```sh
python3 -m pip install cairosvg pillow
python3 tools/build-assets.py
```

Le script contient toute la géométrie (chemins de dune, grille du F, palette) : c'est là
qu'il faut modifier le dessin, pas dans les SVG générés.
