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

- EN: Your Mac's dashboard on iPad
- FR: Votre tableau de bord sur iPad

**Promotional text** (170)

- EN: Turn an iPad into a second dashboard for your Mac: calendar, now playing, printers, smart home,
  your own widgets. Scan a code, and it is there.
- FR: Faites d'un iPad un second tableau de bord pour votre Mac : agenda, musique en cours,
  imprimantes, maison connectée, vos widgets. Scannez un code, c'est prêt.

**Description** (4000)

EN:

> Fremkit for iPad shows a screen of the Fremkit dashboard running on your Mac: the widgets you
> chose, laid out for the iPad, live.
>
> Fremkit is a free, open-source dashboard for macOS. You lay out widgets in its editor (a clock,
> your calendar, what is playing, your 3D printer, your smart home, your CI pipelines, your AI
> agents at work, or a widget you write yourself) and the iPad shows them, updating as they change.
> Touch them as you would on the Mac.
>
> • Pairs in seconds: scan the QR code your Mac shows, or pick your Mac from the list and type its
>   code.
> • Its own screen: give the iPad a layout of its own, made for its size, in either orientation.
> • Follows your Mac: brightness, day and night themes, and changes you make in the editor arrive
>   at once.
> • Private by design: the iPad talks only to your Mac, on your local network, over an encrypted
>   connection pinned to your Mac's key. No account, no cloud, no analytics.
>
> Requires Fremkit on a Mac on the same local network: free at fremkit.app.

FR:

> Fremkit pour iPad affiche un écran du tableau de bord Fremkit qui tourne sur votre Mac : les
> widgets que vous avez choisis, disposés pour l'iPad, en direct.
>
> Fremkit est un tableau de bord gratuit et open source pour macOS. Vous disposez des widgets dans
> son éditeur (une horloge, votre agenda, la musique en cours, votre imprimante 3D, votre maison
> connectée, vos pipelines, vos agents IA au travail, ou un widget que vous écrivez vous-même) et
> l'iPad les affiche, à jour. Touchez-les comme sur le Mac.
>
> • Appairé en quelques secondes : scannez le QR code affiché par votre Mac, ou choisissez votre Mac
>   dans la liste et tapez son code.
> • Son propre écran : donnez à l'iPad une disposition à lui, faite pour sa taille, dans les deux
>   orientations.
> • Suit votre Mac : luminosité, thèmes de jour et de nuit, et les changements faits dans l'éditeur
>   arrivent aussitôt.
> • Privé par conception : l'iPad ne parle qu'à votre Mac, sur votre réseau local, par une connexion
>   chiffrée liée à la clé de votre Mac. Pas de compte, pas de cloud, pas de statistiques.
>
> Nécessite Fremkit sur un Mac du même réseau local : gratuit sur fremkit.app.

**Keywords** (100, comma-separated, no spaces after commas)

- EN: `dashboard,widgets,mac,companion,second screen,status,calendar,smart home,homelab,monitor`
- FR: `tableau de bord,widgets,mac,second écran,écran,agenda,domotique,statut,moniteur,compagnon`

No brand of anyone else (Corsair, Xeneon, Claude…): App Review refuses third-party trademarks in
keywords.

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
- a link to a short screen recording: the Mac's **Settings → Devices**, the QR code, the iPad
  pairing and showing its screen, a widget touched;
- how to try it themselves: install Fremkit from https://fremkit.app on a Mac on the same network,
  click the version seven times in **Settings → About**, tick **iPad and extra screens**, open
  **Settings → Devices**, switch it on and scan the QR code. Drop this step once the option is
  visible by default;
- why it asks for the camera (scanning the pairing code) and the local network (finding the Mac
  and loading its dashboard).
