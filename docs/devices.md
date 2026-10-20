# Show the dashboard on a tablet

The Fremkit app shows one screen of your dashboard from a Mac on the same network, on an iPad or
an Android tablet: real widgets, live data, touch, Claude sessions. The tablet is a **paired
device**: the Mac trusts it explicitly, it can be revoked at any time, and nothing listens on the
network until you turn it on. This page follows the iPad; the Android app pairs and behaves the
same way, and [Android](#android) says where it differs.

The app is iPad only (iPadOS 17 or later). It is distributed through TestFlight; to build it
yourself see [Building the app](#building-the-app).

## Turn it on

Until the app is available to everyone, pairing is an experimental feature, hidden on a fresh
install. To show it, open **Settings → About** in the admin, click the version number seven times
within a few seconds (or focus it and press Enter seven times), and tick **Tablets and extra
screens** under **Experimental features**. That shows **Settings → Devices**, and the screen selector
with **+ Add a screen** above the canvas. **Settings → Devices** also stays visible, option or not,
while pairing is on or an iPad is paired, so it can always be switched off or the iPad unpaired.

Then open **Settings → Devices** and switch on **Allow a tablet on the local network**.
Fremkit generates a key the first time and starts a second listener on port **4243**, over TLS,
with a self-signed certificate. It answers only private and link-local addresses, IPv4 or
IPv6, and the Mac itself: a public address and Tailscale get no answer. A VPN that uses the same
private addresses as your home network cannot be told apart from it and does reach the Mac, but
needs a pairing code or a paired iPad's key to do anything. macOS may ask whether to accept incoming connections for Fremkit:
accept. If another application holds port 4243 the admin says so and the switch goes back off.

The section then shows a QR code, the same pairing code in clear text, and a **fingerprint** of
four words. A code is valid for 5 minutes and works once; **New code** makes another. Outside of
a live code, the Mac does not answer pairing at all, and the iPad says the code is no longer
showing.

## Pair

1. Open the Fremkit app on the iPad. Allow **Local Network** when it asks (it needs it to reach
   your Mac; see [Prompts](#prompts-on-the-ipad-and-the-mac)).
2. Scan the QR code. This is the normal path: the code carries the Mac's address and the hash of
   its key, so it needs no discovery and no typing. Opening the `fremkit://` link from the iPad's
   Camera app does the same. It also carries a long one-time secret that pairs even while the Mac
   is refusing codes because something on the network is guessing them: the QR code always works
   while it is showing.
3. The iPad measures the size its dashboard really gets (1408 × 950 on a 13-inch iPad Pro, for
   instance) and reports it. The device appears in the Devices section; pick the screen it shows,
   or **Create a screen its size**, and lay that screen out like any other.

**Without the camera**, the app lists the Macs it finds on the network (Bonjour, `_fremkit._tcp`).
Pick yours, type the code, and **check that the four words on the iPad are the ones the admin
shows** before you confirm: they come from your Mac's key, so a Mac that shows other words is not
yours. The code you type only works for the Mac whose key the iPad sees, so another machine that
took your Mac's name cannot pass it on to your Mac. The list shows each Mac by its computer name
(System Settings → General → Sharing), which the Mac announces on the local network while
**Allow a tablet on the local network** is on: anyone on the same network can see it, as with AirDrop or file sharing.
Rename the Mac there if you would rather it did not carry yours. There is no field for typing an address: a Mac that is not in the list is reached with the
QR code.

The iPad keeps what it needs to reconnect in its keychain and pins the Mac's key: it talks to
that Mac and no other, whatever the network calls it. If the Mac's address changes, the app finds
it again by itself, with the dashboard up: as soon as it sees the Mac announce its new address on
the network, or about a minute after the old one stops answering. It tries the Mac's `.local` name,
the last address that worked, and every other private (RFC 1918) IPv4 address the Mac last told it
about on its Wi-Fi or Ethernet, never a VPN's or a virtual machine's (the app asks
`GET /api/devices/me?addresses=1`; the dashboard page and the widgets are not told), so unplugging the Ethernet cable moves it to the Mac's Wi-Fi address even when the network's
name lookup fails. Each of those addresses must present the pinned key, like any other; another key
at one of them only means another machine holds it now. A Mac that answers nowhere (asleep,
say) leaves the dashboard where it is until it comes back.

## What the iPad can do

It shows the screen you gave it and does what the Edge does on that screen: every widget, its
connections (the secrets stay on the Mac), Claude session focus, the clipboard. Only that screen:
a widget's connection, a shortcut button or a service probe placed on another screen is out of its
reach, and an iPad with no screen yet can use none. It cannot open
the admin or change anything in the configuration; those stay on the Mac. The status bar is
hidden and the screen stays awake while the app is in front.

**Brightness.** When a device screen is attached, the iPad sets that screen's brightness: the
admin's *Settings → *a screen* → Brightness*, the brightness widget and the day/night schedule are applied on
the iPad, and a change made in its Control Center is reported back. If the app is closed or in the
background for about 30 seconds, the admin and the widget say "The tablet is not showing this
screen right now" and keep the setting until the app is back.

## Revoke and reset

**Remove** in the Devices section revokes one iPad: its connection is closed at once, and the app
notices within 30 seconds (it checks that the Mac still knows it) and shows "This iPad is no
longer allowed"; **Pair again** leads to the welcome screen. **Remove every tablet** does it for
all of them. **Reset the certificate** makes a new key, which removes every iPad too: each one
shows "This Mac's key has changed" and must be paired again with **Pair again**. The app never
forgets a pairing by itself, and keeps retrying meanwhile, so an iPad that only met another
machine on the Mac's old address recovers on its own. Neither touches a linked browser extension
([docs/companion.md](companion.md)), which pins no key: it is removed from its own row. Turning the switch off
closes the listener and the iPads show that the Mac is unreachable until it is back on.

## Prompts on the iPad and the Mac

- **Local Network** on the iPad. Without it nothing reaches the Mac. If you refused it: Settings →
  Privacy & Security → Local Network → Fremkit.
- **Incoming connections** on the Mac: the macOS firewall may ask once to let Fremkit's server
  accept them. Accept.

## Troubleshooting

- **The Mac is not in the list.** The router or access point may not relay Bonjour (mDNS) between
  Ethernet and Wi-Fi, between bands, or between VLANs; or the Mac is connected to both Wi-Fi and
  Ethernet. Use the QR code, which works without Bonjour, or tap **Enter the Mac's address** under
  the list (the Android app, and the iPad app from its next version) and type one of the addresses
  **Settings → Devices** shows beside the code: the app then shows the four words of whatever
  answers there, to compare as for a Mac in the list. Or put the Mac and the iPad on the same Wi-Fi.
- **The app says it cannot reach the Mac.** The Mac is asleep, pairing is switched off, or the
  Local Network permission was refused (above). The app retries by itself.
- **The app says "This Mac's key has changed".** The certificate was reset in Fremkit (or another
  machine answers at the Mac's address). Tap **Pair again** and pair as the first time; if you
  did not reset it, check that the iPad is on the right network.
- **The app says "This iPad is no longer allowed".** The device was removed in the admin: tap
  **Pair again**.
- **The four words differ.** Do not pair. Check that you picked your own Mac in the list; if the
  words still differ, use the QR code.
- **Brightness says "The tablet is not showing this screen right now".** Open the app and show that
  screen.

## What the Mac exposes

Only an allow-list of routes answers on port 4243: the dashboard's page, the widgets' code, and
what a paired dashboard reads and sends (`/api/config`, `/ws`, the proxy, the device's own
`GET /api/devices/me` and `POST /api/devices/me/brightness`). Anything else, the admin included,
answers 404. What does answer is narrowed to the iPad's own screen: `/api/config` and the `config`
channel carry that screen, its widgets, the theme and the language, and none of the connections,
marketplace records, privacy switches or other screens. The page itself and the widgets' files
answer before pairing, by design: they say which widgets are installed, not how they are set up. See [SECURITY.md](../SECURITY.md#a-paired-device).

## Android

The Android app does what the iPad app does, from the same switch in **Settings → Devices**, over
the same port and the same pinned key. It needs **Android 9 or later** and **Android System
WebView 82 or later**, and nothing from Google Play: no Play services, no account, no analytics,
no crash reporter. The only machine it ever connects to is the Mac it is paired with; the WebView's
Safe Browsing lookups and usage metrics are turned off.

### Install

The app is not on the Play Store. Each Fremkit release carries it as an APK:

- **From the tablet's browser**: open
  `https://github.com/fdussert/fremkit/releases/latest/download/Fremkit-Android.apk` (the admin's
  **Settings → Devices** and the [site](https://fremkit.app) link to it), then open the downloaded
  file. Android asks once to let the browser install apps (**Install unknown apps**); allow it for
  that browser, and turn it back off afterwards if you like.
- **With [Obtainium](https://github.com/ImranR98/Obtainium)**, which then keeps the app up to date:
  add `https://github.com/fdussert/fremkit` as an app source (GitHub), and set its APK filter to
  `^Fremkit-Android-.*\.apk$`. Each release holds the APK twice, under its versioned name and as
  `Fremkit-Android.apk` for the link above; the filter keeps Obtainium to one of them.

There is no updater inside the app: it would need to talk to GitHub, and the app talks to your Mac
only. When the Mac runs a newer Fremkit than the app, the app's own screens (the welcome screen,
the unreachable screen, its settings) say so in one line; when the Mac is the older one, they say
to update Fremkit on the Mac. That line never covers the dashboard.

**Check the signature before the first install.** Android installs an update only when it is signed
by the same key as the installed app, so the first install is the one to check: every later one
is held to it. The signing certificate's SHA-256 is:

```
a6ccdda6b0f8df2923cc25227c8cf05b8a0376672be827cd351e787557a58225
```

It is also in the repository (`android/signing-cert.sha256`) and on the site. On a Mac with the
Android SDK's build-tools, `apksigner verify --print-certs Fremkit-Android.apk` prints it as the
*Signer #1 certificate SHA-256 digest*; from a checkout, `scripts/build-android.sh verify <apk>`
checks the signature and compares the signer with that file.

**Google developer verification.** Google has announced that certified Android devices will
require apps to come from a developer it has verified, starting with a few countries before the
rest of the world. Fremkit will register when the rule reaches its users; until then, a certified
tablet where it already applies may refuse the APK. Installing with `adb install` from a computer
is not affected.

**Phones.** The APK installs on a phone too, and a phone pairs like a tablet with the size it
measures. Nothing is designed for a phone's screen: lay out a screen its size if you try it.

### Pair

1. On the Mac, switch on **Allow a tablet on the local network** (see [Turn it on](#turn-it-on)).
   The macOS firewall may ask whether to accept incoming connections for Fremkit: accept.
2. In the app, tap **Scan the code** and point the camera at the QR code. Android asks once for the
   camera. A `fremkit://` link opened from another app (a camera app that reads QR codes, a
   browser) pairs as well, but the app always asks first *Pair with …?*, paired or not: on Android
   any installed app can open such a link, and only you should choose which Mac this tablet shows.
3. **Without the camera**, tap **Enter the code**: the app lists the Macs it finds on the network
   (`_fremkit._tcp`), you pick yours, check that the **four words** match the admin's, and type the
   code, exactly as on the iPad. Turning the code into its proof can take a few seconds on a
   modest tablet: the spinner is that work, not the network.

The tablet then measures the size its dashboard gets and reports it, and you give it a screen in
the Devices section, as for an iPad. The pairing is stored encrypted under a key of the Android
Keystore, in a file that every backup and device-to-device transfer leaves out: a restored or
replaced tablet pairs again.

### On the tablet

The dashboard runs full screen: the system bars stay hidden (a swipe from the edge shows them over
the page for a moment), and the screen stays on while the dashboard is in front. **Back** sends the
app to the background rather than closing the page.

**Brightness** is the app window's own level, set from the admin, the brightness widget or the
day/night schedule as for an iPad, and it applies while the app is in front. **The system slider
wins**: moving it drops the app's level, the screen shows yours, and the admin follows what the
tablet reports. With automatic brightness on, the tablet reports the last level set by hand. The
app never changes the system's own setting, and needs no permission for this.

**The app's settings** (pin the app, forget the Mac, the versions of the app and of Fremkit on
the Mac) open from the **⋮** button of the welcome screen, a long press on the Mac's name on the
unreachable screen, or, over the dashboard, the page's own menu: the gesture that opens the admin
on the Edge (hold or double-tap a page button in the bar) shows **App settings** instead.

**Screen pinning** keeps the tablet on Fremkit, for a tablet on a wall or a desk that does nothing
else. It is Android's own feature and is off on most tablets: turn it on first in the system
settings (**Security**, sometimes under **Security & location → Advanced**, called **App pinning**
on recent versions), then use **Pin this app** in the app's settings. Android asks you to confirm,
and you leave with the system's gesture (on most tablets, touch and hold **Back** and
**Overview**). There is no launch at boot and no deeper kiosk mode.

**"Update Android System WebView".** The dashboard runs in Android System WebView, which updates
apart from Android. An older one than 82 cannot carry the page's messages to the app (brightness,
a revoked tablet), so the app shows this screen instead of a dashboard that half works: update
**Android System WebView** from the tablet's app store (the button opens its page in the system
settings), then **Check again**.

### Troubleshooting on Android

- **The Mac is not in the list** (manual path). The same network reasons as on the iPad
  ([Troubleshooting](#troubleshooting)); on Android, some Wi-Fi drivers and access points also drop
  multicast, which the list depends on, more often while the tablet saves power. Scan the QR code
  instead: it needs no discovery.
- **Paired, then unreachable after the Mac's address changed.** Not every Android version resolves
  a Mac's `.local` name. The app then tries the last address that worked, the Mac's other addresses
  and the Macs it hears on the network, so it usually finds the Mac again by itself; if the network
  hides it from discovery too, scan a new code.
- **"This Mac's key has changed", "This tablet is no longer allowed"**: as on the iPad, **Pair
  again**.
- **Developing: the Mac answers 421 over `adb reverse`.** A request reaching port 4243 through the
  loopback forward is refused by design (a paired device is never the Mac itself). Test over the
  local network.

### Building it yourself

The Gradle project is `android/`: `android/fremkit-kit` holds the logic, pure Kotlin tested on any
JVM, and `android/app` the screens and the WebView over it. `scripts/build-android.sh doctor` says
what the Mac lacks (an arm64 JDK 17 or later, the SDK's platform and build-tools, `adb`) and
prints the commands that install it.

```bash
scripts/build-android.sh test     # the kit's tests and the app's JVM tests
scripts/build-android.sh build    # a debug APK, lint, and the check that no Play services library got in
FREMKIT_ANDROID_DEVICE=<serial> scripts/build-android.sh install   # onto a tablet over adb, then launched
pbpaste | FREMKIT_ANDROID_DEVICE=<serial> scripts/build-android.sh install --seed   # paired from a link on stdin
```

A debug build installs beside the released app (`app.fremkit.android.debug`). Releasing is in
[releasing.md](releasing.md#the-android-app).

## Building the app

The Xcode project is `ios/Fremkit.xcodeproj`. Signing values never enter the repository:

```bash
cp ios/Local.example.xcconfig ios/Local.xcconfig   # git-ignored: your team id and bundle id
scripts/build-ios.sh build     # the simulator, signed ad hoc: needs no Local.xcconfig
scripts/build-ios.sh test      # FremkitKit's tests (the pairing and connection logic)
FREMKIT_IOS_DEVICE=<udid> scripts/build-ios.sh install   # signed debug build onto your iPad
```

`xcodebuild` needs Xcode itself, not the Command Line Tools; the script finds `/Applications/Xcode.app`
(or `FREMKIT_XCODE`), and with your own commands `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
does the same. Publishing is described in [releasing.md](releasing.md#the-ipad-app).
