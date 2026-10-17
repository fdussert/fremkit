# Releasing Fremkit.app

How the downloadable app is built, signed, notarized and published. Contributors never need any
of this: the source install (`bun run setup`) builds the developer helper, which runs a checkout.

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
   the changelog section, and fills the cask's `version` and `sha256`. Notarization takes a few
   minutes per submission; a refusal prints Apple's log.
3. Run the commands it prints, in order: commit the cask, tag and push, `gh release create` with
   the DMG, the zip and `appcast.xml`, then copy the cask into the tap and push it.

`scripts/notarize.sh` alone notarizes whatever `scripts/build-app.sh` left in `native/dist`, and
checks the result with `codesign --verify --strict`, `spctl` and `stapler validate`.

### Why the appcast is a release asset

The app's `SUFeedURL` is
`https://github.com/fdussert/fremkit/releases/latest/download/appcast.xml`, which GitHub
redirects to the `appcast.xml` of the newest published release. Publishing the release is then
the one step that offers the update: the archive and the feed naming it appear together, a draft
or a failed upload offers nothing, and there is no GitHub Pages branch to keep in step or to
commit to. The feed carries the newest release only, which is all Sparkle needs; the update
itself is verified by its EdDSA signature and by the Developer ID signature of the new app, not
by where the feed lives.

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
# then node scripts/lib/appcast.mjs appcast … > /tmp/fremkit-sparkle/feed/appcast.xml, and
python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/fremkit-sparkle/feed
```

Run the old copy beside the installed one, isolated: `FREMKIT_SUPPORT_DIR` gives it its own
`helper.json`, pid file and logs, and a `helper.json` with `"port": 4301` (and `url`/`adminUrl`
to match), `"touch": false`, `"fence": false`, `"dock": false` and a `display` no screen has keeps
it off the touch panel, off the Edge and from asking for any permission. Sparkle's own settings
go to the `dev.fremkit.helper` defaults domain, shared with the installed helper: delete the
`SU*` keys it leaves there afterwards.
