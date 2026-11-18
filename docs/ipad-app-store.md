# The iPad app on the App Store

What App Store Connect asks for, ready to paste. The copy is in English and French, the app's two
languages. Limits are App Store Connect's; each field below fits its own. How a build gets there
is in [releasing.md](releasing.md#the-ipad-app).

## App information

| Field | Value |
|---|---|
| Name | Fremkit |
| Category | Utilities (primary), Productivity (secondary) |
| Privacy policy URL | https://fremkit.app/privacy |
| Support URL | https://github.com/fdussert/fremkit/issues |
| Marketing URL | https://fremkit.app |
| Age rating | 4+: no objectionable content, and no unrestricted web access (the web view stays on the paired Mac's own pages) |
| App privacy | Data Not Collected |
| Price | Free |
| Devices | iPad only, iPadOS 17 or later |

## Listing

**Subtitle** (30)

- EN: A second screen of widgets
- FR: Un second écran de widgets

No Apple product name in the name, the subtitle, the promotional text, the keywords or the header
and search images: App Review rejects it under guideline 5.2.5, "Mac" as much as "iPad" ("A second
screen for your Mac" was refused), and raises one field per round. The one accepted use is a line
stating what the app requires, as the description's last one does.

**Promotional text** (170)

- EN: A live second screen for your desk: calendar, now playing, printers, smart home, your own
  widgets. Scan a code, and it is there.
- FR: Un second écran en direct pour votre bureau : agenda, musique en cours, imprimantes, maison
  connectée, vos widgets. Scannez un code, c'est prêt.

**Description** (4000)

EN:

> Fremkit shows a screen of the Fremkit dashboard running on your computer: the widgets you chose,
> laid out for this screen, live.
>
> Fremkit is a free, open-source desktop dashboard. You lay out widgets in its editor (a clock,
> your calendar, what is playing, your 3D printer, your smart home, your CI pipelines, your AI
> agents at work, or a widget you write yourself) and this screen shows them, updating as they
> change. Touch them as you would on your desk.
>
> • Pairs in seconds: scan the QR code your computer shows, or pick it from the list and type its
>   code.
> • Its own screen: give this device a layout of its own, made for its size, in either orientation.
> • Follows your desk: brightness, day and night themes, and changes you make in the editor arrive
>   at once.
> • Private by design: the app talks only to your own computer, on your local network, over an
>   encrypted connection pinned to its key. No account, no cloud, no analytics.
>
> Requires the Fremkit app on a Mac on the same local network, free at fremkit.app.

FR:

> Fremkit affiche un écran du tableau de bord Fremkit qui tourne sur votre ordinateur : les widgets
> que vous avez choisis, disposés pour cet écran, en direct.
>
> Fremkit est un tableau de bord de bureau gratuit et open source. Vous disposez des widgets dans
> son éditeur (une horloge, votre agenda, la musique en cours, votre imprimante 3D, votre maison
> connectée, vos pipelines, vos agents IA au travail, ou un widget que vous écrivez vous-même) et
> cet écran les affiche, à jour. Touchez-les comme sur votre bureau.
>
> • Appairé en quelques secondes : scannez le QR code affiché par votre ordinateur, ou
>   choisissez-le dans la liste et tapez son code.
> • Son propre écran : donnez à cet appareil une disposition à lui, faite pour sa taille, dans les
>   deux orientations.
> • Suit votre bureau : luminosité, thèmes de jour et de nuit, et les changements faits dans
>   l'éditeur arrivent aussitôt.
> • Privé par conception : l'app ne parle qu'à votre ordinateur, sur votre réseau local, par une
>   connexion chiffrée liée à sa clé. Pas de compte, pas de cloud, pas de statistiques.
>
> Nécessite l'app Fremkit sur un Mac du même réseau local, gratuite sur fremkit.app.

**Keywords** (100, comma-separated, no spaces after commas)

- EN: `dashboard,widgets,desktop,companion,second screen,status,calendar,smart home,homelab,monitor`
- FR: `tableau de bord,widgets,bureau,second écran,écran,agenda,domotique,statut,moniteur,compagnon`

No brand of anyone else (Corsair, Xeneon, Claude…): App Review refuses third-party trademarks in
keywords. No Apple product name either (see the subtitle).

**What's New** (first version)

- EN: First release.
- FR: Première version.

## Screenshots

iPad 13" is required (2064 × 2752 portrait or 2752 × 2064 landscape); App Store Connect scales it
for the smaller iPads. Three, portrait, one per page of a device screen on the demo dashboard
(`FREMKIT_DEMO=1`, docs/demo-mode.md), in English and in French:

1. **Today**: clock, weather, calendar, music, Dock badges, Claude sessions and limits.
2. **Work**: service status, timer, processes, CPU, memory, network, disk map.
3. **Mac**: shortcuts, clipboard, batteries, volume, brightness, disks, uptime, world clock.

No pairing screen: it names the Mac it pairs with. Nothing else shows a real name, address or
account.

No price either, in any language (guideline 2.3.7): App Review counts any visible "free" (free
disk space or memory included), "gratuit", "libre", currency sign, cost or price as a price
reference, wherever it appears in a screenshot. Leave out or configure the widgets that show one.
The word "free" is allowed in the description, not in the screenshots.

To take them again:

1. Start a demo server with a kept folder on a free port (`FREMKIT_DEMO=1 FREMKIT_PORT=… FREMKIT_DATA_DIR=…`)
   and switch pairing on there. The listener is always 4243: switch it off on the live server
   for the time being.
2. `scripts/build-ios.sh build`, then create an iPad Pro 13-inch simulator, boot it and
   `xcrun simctl install` the app. Seed it with a pairing link (`POST /api/devices/code`, its
   `url`) written to the app's data container as `tmp/FremkitSeedLink`
   (`xcrun simctl get_app_container <udid> <bundle id> data`), then launch it.
3. In the demo's admin, **Settings → Devices → Create a screen its size**, pre-filled from the
   Edge, then lay out its pages.
4. `xcrun simctl status_bar <udid> override --time 9:41 --batteryState charged --batteryLevel 100`,
   and `xcrun simctl io <udid> screenshot <file>.png` on each page. Switch the demo's language
   in Settings → General for the French set.

## Notes for App Review

The reviewer has no Mac running Fremkit, and the app does nothing without one. Give them:

- what it is: a companion that shows a dashboard served by the Fremkit app on the user's Mac,
  over the local network, with no server of ours;
- the links to the demo videos (see below), each with the version and build it shows;
- how to try it themselves: install Fremkit from https://fremkit.app on a Mac on the same network,
  open **Settings → Devices**, switch it on and scan the QR code;
- why it asks for the camera (scanning the pairing code) and the local network (finding the Mac
  and loading its dashboard).

### The demo video

App Review reviews this app from a video, and asks for a new one with every submission (or a line
in the Notes saying the earlier one still holds). What it asked for changed between two rounds of
the same review, so the Notes of 1.0 carry both:

- **A screen recording made on a physical iPad**, of the build under review, from a fresh install
  so that every permission request shows. This is the one the second round asked for:
  1. Delete the app from the iPad, which resets its permissions.
  2. In TestFlight, show the version and build number, and install it.
  3. Open the app and scan: the **camera** request appears. Scan the QR code the Mac shows.
  4. Accept the **local network** request when it appears (pairing from the list of Macs raises it
     if scanning did not).
  5. The dashboard: its pages, widgets touched, and a change made in the Mac's editor arriving.
- **A film from a separate camera**, the iPad and the Mac in the same shot while they pair: the
  "designated hardware" the first round asked for, when it refused a screen recording.

Show the same pages as the screenshots, from the same demo server, or the review says it cannot
find the screens they show.

Put the links (unlisted is fine) in the **Notes** field of **App Review Information**, say there
which version and build each one shows, then answer the review message. YouTube turns a portrait
video of three minutes or less into a Short: give the `https://www.youtube.com/watch?v=…` form of
the link, which plays it as an ordinary video.
