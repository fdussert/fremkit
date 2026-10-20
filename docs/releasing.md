# Releasing Fremkit

How the downloadable app is built, signed, notarized and published. Contributors never need any
of this: the source install (`pnpm run setup`) builds the developer helper, which runs a checkout.

## What the app is

`Fremkit.app` is the helper, built with Sparkle, carrying everything the dashboard needs:

```
Fremkit.app/Contents/
  MacOS/FremkitHelper                 the helper (bundle id dev.fremkit.helper)
  Frameworks/Sparkle.framework        updates
  Resources/server/fremkit-server     Node 24 + the bundled server, one executable
  Resources/server/bridge/fremkit.js  the widget SDK
  Resources/widgets/ themes/ ui/dist/ brand/wallpaper/
  Resources/scripts/                  the Claude Code hook and status line
```

With no `repoPath` in `helper.json`, the helper runs `Resources/server/fremkit-server` with
`FREMKIT_ROOT` set to `Resources` and `FREMKIT_DATA_DIR` to
`~/Library/Application Support/Fremkit`. With a `repoPath`, it runs that checkout exactly as the
developer helper does.

The server is bundled by esbuild into one CommonJS file (`server/scripts/bundle.mjs`) and
injected into the official Node binary as a
[single executable application](https://nodejs.org/api/single-executable-applications.html).
Node and Sparkle are pinned in `scripts/build-app.sh`, downloaded once into
`~/Library/Caches/Fremkit-build`, checked against their published SHA-256 and the hash pinned in
the script, and never committed. Bumping either means changing the version *and* the hash there.

## Once

Done already:

- the **Developer ID Application** certificate of team `874TMS6WBS`, in the login keychain;
- the notarytool keychain profile **`fremkit-notary`**
  (`xcrun notarytool store-credentials fremkit-notary --apple-id … --team-id 874TMS6WBS`).
- **Sparkle's EdDSA keys**: the private key in the login keychain (item "Private key for signing
  Sparkle updates", account `ed25519`), the public key in `packaging/sparkle/public-key.txt`.
  `native/.build/app/sparkle-2.10.0/bin/generate_keys` created them, after a
  `bash scripts/build-app.sh` had downloaded Sparkle; `generate_keys -x <file>` exports the
  private key for a backup, kept off this repository and off any cloud folder. **An app signed
  with a public key can only ever be updated by its private key**: losing it means every
  installed copy has to be reinstalled by hand.

Still to do:

1. **The Homebrew tap.** Create the public repository `fdussert/homebrew-fremkit` with one file,
   `Casks/fremkit.rb`, copied from `packaging/homebrew/fremkit.rb` after the first release (the
   release script fills its `version` and `sha256`), and a README saying
   `brew install --cask fdussert/fremkit/fremkit`. Nothing else is needed.

## Each release

1. On `main`, rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z`, bump the four `version`
   fields (`package.json`, `server/package.json`, `ui/package.json`, `server/src/version.ts`)
   and every `data-fremkit-version` in `site/index.html` (the landing page names the version it
   offers, and Cloudflare Pages publishes it when the commit reaches `main`), commit.
2. `bash scripts/release.sh X.Y.Z`. It refuses a dirty tree or a version that does not match,
   then builds and signs the app, notarizes and staples it, builds, signs, notarizes and staples
   the DMG, zips the app for Sparkle and signs the zip with the private key from the keychain
   (macOS asks once whether `sign_update` may read it), writes `native/dist/appcast.xml` from
   the changelog section and signs it with the same key, and fills the cask's `version` and `sha256`. Notarization takes a few
   minutes per submission; a refusal prints Apple's log.

   **From 0.5.1 on, every release carries the Android app**: run it as
   `FREMKIT_ANDROID_RELEASE=1 bash scripts/release.sh X.Y.Z`. The admin's **Settings → Devices**
   and the site link to `releases/latest/download/Fremkit-Android.apk`, which only the newest
   release answers: a release without the APK breaks both links until the next one. See
   [The Android app](#the-android-app).
3. Run the commands it prints, in order: commit the cask, tag and push, `gh release create` with
   the DMG (also as `Fremkit.dmg`, the name the site's download buttons link to through
   `releases/latest/download/`), the zip and `appcast.xml` (which also posts the release in the Announcements
   discussions), and the Android APK under both its names with its checksum, then copy the cask
   into the tap and push it.

`scripts/notarize.sh` alone notarizes whatever `scripts/build-app.sh` left in `native/dist`, and
checks the result with `codesign --verify --strict`, `spctl` and `stapler validate`.

### Why the appcast is a release asset

The app's `SUFeedURL` is
`https://github.com/fdussert/fremkit/releases/latest/download/appcast.xml`, which GitHub
redirects to the `appcast.xml` of the newest published release. Publishing the release is then
the one step that offers the update: the archive and the feed naming it appear together, a draft
or a failed upload offers nothing, and there is no GitHub Pages branch to keep in step or to
commit to. The feed carries the newest release only, which is all Sparkle needs. The feed is
itself EdDSA-signed (`SURequireSignedFeed`: the app refuses an unsigned or altered one), and the
update is verified by its own EdDSA signature *before it is extracted*
(`SUVerifyUpdateBeforeExtraction`) and by the Developer ID signature of the new app — none of it
depends on where the feed lives. Since builds require a signed feed, a feed published by hand
must be signed too: `sign_update appcast.xml` after the last edit.

## Testing an update locally

Without touching the owner's keychain or the published feed: generate a throwaway key pair into a
temporary directory, build two versions pointed at a local feed, and let Sparkle go from one to
the other.

```sh
# A throwaway Ed25519 pair, outside the repository
mkdir -p /tmp/fremkit-sparkle && node -e '
const { generateKeyPairSync } = require("node:crypto"); const fs = require("node:fs")
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
fs.writeFileSync("/tmp/fremkit-sparkle/private.key", Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url").toString("base64"))
fs.writeFileSync("/tmp/fremkit-sparkle/public.key", Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64"))'

export FREMKIT_SPARKLE_PUBLIC_KEY="$(cat /tmp/fremkit-sparkle/public.key)"
export FREMKIT_SPARKLE_FEED_URL=http://127.0.0.1:8765/appcast.xml
FREMKIT_APP_VERSION=0.2.0 bash scripts/build-app.sh && ditto native/dist/Fremkit.app /tmp/fremkit-sparkle/old/Fremkit.app
FREMKIT_APP_VERSION=0.2.1 bash scripts/build-app.sh
ditto -c -k --sequesterRsrc --keepParent native/dist/Fremkit.app /tmp/fremkit-sparkle/feed/Fremkit-0.2.1.zip
native/.build/app/sparkle-2.10.0/bin/sign_update --ed-key-file /tmp/fremkit-sparkle/private.key /tmp/fremkit-sparkle/feed/Fremkit-0.2.1.zip
# then node scripts/lib/appcast.mjs appcast … > /tmp/fremkit-sparkle/feed/appcast.xml, sign it
# (the app requires a signed feed):
native/.build/app/sparkle-2.10.0/bin/sign_update --ed-key-file /tmp/fremkit-sparkle/private.key /tmp/fremkit-sparkle/feed/appcast.xml
# and serve it
python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/fremkit-sparkle/feed
```

Run the old copy beside the installed one, isolated: `FREMKIT_SUPPORT_DIR` gives it its own
`helper.json`, pid file and logs, and a `helper.json` with `"port": 4301` (and `url`/`adminUrl`
to match), `"touch": false`, `"fence": false`, `"dock": false` and a `display` no screen has keeps
it off the touch panel, off the Edge and from asking for any permission. Sparkle's own settings
go to the `dev.fremkit.helper` defaults domain, shared with the installed helper: delete the
`SU*` keys it leaves there afterwards.

## The iPad app

The iPad app (`ios/`) is released apart from the Mac app and the DMG: it goes to App Store
Connect, then TestFlight, then the App Store, and nothing in `scripts/release.sh` touches it.
Signing values are the owner's and stay out of the repository, in the git-ignored
`ios/Local.xcconfig` (a copy of `ios/Local.example.xcconfig`: `DEVELOPMENT_TEAM` and
`FREMKIT_BUNDLE_ID`). The scripts need Xcode, not the Command Line Tools; `build-ios.sh` finds it.

### Once

1. In App Store Connect, **Apps → +  → New App**: platform iOS, name **Fremkit**, the bundle id of
   `Local.xcconfig`, a SKU of your choice. Then fill what the listing needs, from
   [ipad-app-store.md](ipad-app-store.md): description, keywords, category, the privacy policy
   (`https://fremkit.app/privacy`), the privacy answers (**Data Not Collected**), the age rating,
   and the notes for App Review.
2. In Xcode, **Settings → Accounts**: sign in with the team's Apple account. `upload` signs and
   sends through it.

### Each build

1. Raise `MARKETING_VERSION` in `ios/Fremkit.xcconfig` for a new version; the build number needs
   nothing, it is the commit count of `HEAD`.
2. `scripts/build-ios.sh test`, then, on a clean tree, `scripts/build-ios.sh upload`. It archives
   a Release build, exports it for App Store Connect and uploads it. Upload from `main`: a branch
   can carry the same commit count as a build already sent, which App Store Connect refuses.
3. The build appears under **TestFlight** once Apple has processed it (minutes to an hour).
   Internal testers (the team) get it at once; external testers after Beta App Review. Submitting
   for the App Store is done in App Store Connect, with the notes and video the listing asks for.

`scripts/build-ios.sh archive` stops before the upload, to check a Release build without sending
it.

## The Android app

The Android app (`android/`) ships as an APK attached to the Mac's GitHub release, built and
signed on the owner's Mac by `scripts/release.sh` when `FREMKIT_ANDROID_RELEASE=1`. It is not on
the Play Store. CI builds and tests a debug APK on every push, holds no key and signs nothing.

### The toolchain

`scripts/build-android.sh doctor` checks what the build needs and prints the commands that
install what is missing; it never installs anything itself:

- an **arm64 JDK 17 or later** (Temurin): an x86_64 one runs Gradle under Rosetta, several times
  slower, and the script refuses it. `FREMKIT_JAVA_HOME` picks another;
- the Android SDK's **command-line tools** in `~/Library/Android/sdk/cmdline-tools/latest`, then,
  through their `sdkmanager`, the **platform** and **build-tools** that
  `android/gradle/libs.versions.toml` names (`compileSdk`, `buildTools`), and `platform-tools` for
  `adb`. `FREMKIT_ANDROID_SDK` points at another SDK.

The Gradle wrapper is committed with its checksum; every library version is pinned in the version
catalog. `versionName` is read from the root `package.json` (no fifth version field to bump), and
`versionCode` is the commit count of `HEAD`, so a release from `main` always goes up.

### Once: the signing key

`bash scripts/create-android-keystore.sh` (done already; the owner runs it, an agent never does)
made the one key every release is signed with:

- **Where**: `~/Library/Application Support/Fremkit-release/fremkit-android.p12`, outside the
  repository and outside Fremkit's data folder (which backups carry). The folder is 0700 and the
  file 0600, and `build-android.sh release` refuses to sign when either is looser.
- **Its password** was generated by the script and lives only in the login keychain (service
  `fremkit-android-release`, account `release`), written through `security -i` on stdin and read
  back by `build-android.sh release`. It never appears on a command line, in
  `gradle.properties`, in an environment file or in the repository.
- **A backup** of the keystore file and its password is kept offline by the owner, in a password
  manager. Nothing else holds a copy.
- **The certificate's SHA-256** is committed in `android/signing-cert.sha256`, shown on the site
  and in [devices.md](devices.md#android), and checked on every release.

### Each release

1. `FREMKIT_ANDROID_RELEASE=1 bash scripts/release.sh X.Y.Z`, as in [Each release](#each-release).
   The Android step runs first, on the clean tree: Gradle builds the release APK **unsigned** and
   never sees the key; `zipalign`, then `apksigner` signs it with the password piped on its stdin
   from the keychain; `apksigner verify
   --print-certs` must then report the signer in `android/signing-cert.sha256`, or nothing is
   written. A refused key fails the release before the Mac's long build.
2. The release then carries three Android assets: `Fremkit-Android-X.Y.Z.apk` (the one
   Obtainium's `^Fremkit-Android-.*\.apk$` filter matches), its `.sha256`, and the same APK as
   `Fremkit-Android.apk`, the stable name the admin's and the site's links reach through
   `releases/latest/download/`. `gh release create` in the printed commands lists them.
3. After publishing, check the asset as it is served before announcing the release:

   ```bash
   curl -fLo "$TMPDIR/Fremkit-Android.apk" https://github.com/fdussert/fremkit/releases/latest/download/Fremkit-Android.apk
   scripts/build-android.sh verify "$TMPDIR/Fremkit-Android.apk"
   ```

**The APK only ever rides on a Mac release.** There is no Android-only GitHub release, ever: the
Mac's update feed is `releases/latest/download/appcast.xml` ([Why the appcast is a release
asset](#why-the-appcast-is-a-release-asset)), and a release without `appcast.xml` would become
"latest" and cut every installed Mac off its updates. An urgent Android fix waits for the next Mac
release, or becomes one: a patch version, with the Android line in the CHANGELOG. `release.sh`
never prints a release without the Mac's assets.

### A lost key, a leaked key

**Lost** (the file or its password): no update can ever install over the app already on people's
tablets, since Android installs an update only when it is signed by the same key. Every user would
have to uninstall the app (losing its pairing) and install an APK signed by a new key under the
same `app.fremkit.android`, with a new fingerprint published; Obtainium would refuse it as a signer
change. **Leaked**: whoever holds it can sign an APK that Android installs as an update of Fremkit,
which then reads the stored pairing and its device token. The response is to rotate the key with
APK Signature Scheme v3 (`apksigner rotate`: a lineage in which the old key vouches for the new
one, which signs from then on), publish the new fingerprint, and on the Mac remove every Android
tablet so that each pairs again from a build known to be good. Hence the 0600 file, the password in
the keychain only, and one offline backup.
