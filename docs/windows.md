# Fremkit on Windows

Fremkit's server runs on Windows 11. The Windows helper (kiosk window, touch, tray icon, installer)
does not exist yet: today Windows is a **development and early-testing target**, run from a
checkout. Everything that is the server's job works; what the helper does on the Mac does not, and
this page says which is which.

## What works, what does not

Works: the dashboard and the admin in a browser, the config, widgets (built-in and installed),
themes, the marketplace, connections and their secrets, the providers that run on Windows (system,
network, battery, volume, clipboard, Claude Code and Codex usage and history, service status,
RTK, GitHub, Azure DevOps and the other account providers), the companion and Fremplay,
and pairing a tablet.

Not available in phase 1, plainly:

- **No helper.** No kiosk window, no touch driver, no mouse fence, no Dock badges, no tray icon,
  no launch at login, no supervision (nothing restarts the server when it dies), no updates.
  `pnpm kiosk` is the stand-in for the kiosk window: it opens Microsoft Edge full screen on the
  2560 x 720 display. It does not make the panel's touches land on the strip; see
  [Touch](#touch).
- **Channels that are Mac-only** are not registered on Windows, and a widget that reads one is shown
  greyed out ("Not available on this platform") rather than left to fail: `spotify`, `shortcuts`,
  `dock`, `cleanshot`, `mutedeck`, and `disk-map` (the disk map is hidden: its scanner is a Swift
  program, and there is no Windows scanner yet). `brightness` is hidden too; Windows brightness
  (DDC/CI) comes with the helper. The table is `CHANNEL_PLATFORMS` in
  `server/src/platform/channels.ts`.
- **Mac-only details inside channels that do run.** The system provider's Mac temperature readings
  (macmon) do not exist here. Docker is looked for under Program Files, but only a local Unix socket
  context is accepted and Docker Desktop on Windows uses a named pipe, so `docker-local` is
  expected to answer `remote-context` there. The arrow on a Claude Code card that brings its terminal to
  the front does nothing (`unsupported`), and a session does not report its process id, tty or
  terminal application.
- **No Windows 10 and no Linux.** The code treats any platform that is not `win32` as the Mac, so
  Linux CI keeps working, but nothing there is a supported way to run Fremkit.

## Where things are

| What | Where |
|---|---|
| Data (config, installed widgets, caches, secrets) | `<checkout>\data`, or the absolute path in `FREMKIT_DATA_DIR` |
| Support folder (the access secret, `access-<port>.token`; the helper's files later) | `%LOCALAPPDATA%\Fremkit`, or the absolute path in `FREMKIT_SUPPORT_DIR` |
| Kiosk browser profile | `%LOCALAPPDATA%\Fremkit\kiosk-profile` |

`FREMKIT_DATA_DIR` and `FREMKIT_SUPPORT_DIR` must be absolute drive paths (`D:\fremkit-data`); a
relative one is refused. Never edit `data\fremkit.json` by hand, as on the Mac.

## Setting up a development machine

Windows 11, [Git](https://git-scm.com), Node 22.13 or later (`node:sqlite`, which Codex history
needs, is available without a flag from that version) and pnpm. `scripts/setup.sh` is the Mac's
setup (it checks for macOS and builds the helper) and does not apply here. In PowerShell:

```powershell
corepack enable pnpm
pnpm install
pnpm build
```

Run it:

```powershell
pnpm start        # the server on 127.0.0.1:4242, serving the built UI
pnpm open         # in another terminal: your default browser, signed in (pnpm open /admin, pnpm open --print)
pnpm kiosk        # the dashboard full screen in Edge on the 2560 x 720 display
```

`pnpm open` and `pnpm kiosk` are Node scripts, so they behave as on the Mac. The server answers only
callers holding its access secret (SECURITY.md); both read it from the token file and hand the
browser a one-time `/auth?code=` link. The secret itself never appears on a command line.

`pnpm dev` runs `scripts/dev.sh`, which needs `bash` and `openssl` (Git for Windows ships both).
Without them, start the two halves yourself, each in its own terminal:

```powershell
$env:FREMKIT_DEV = '1'; $env:FREMKIT_WIDGET_DEV = '1'; pnpm --filter server dev
pnpm --filter ui dev
pnpm open --dev
```

`FREMKIT_DEV=1` is what puts the Vite origin on the server's trusted list, as in
[contributing.md](contributing.md#scripts).

To run a second server beside the first, give it its own port and data folder, and use a port in
the range your other tools do not (examples use 18001):

```powershell
$env:FREMKIT_PORT = '18001'; $env:FREMKIT_DATA_DIR = 'C:\Users\<you>\fremkit-scratch'; pnpm start
$env:FREMKIT_URL = 'http://127.0.0.1:18001'; pnpm open --print
```

After adding or editing a widget's manifest, rescan (the Windows form of the command in
`AGENTS.md`):

```powershell
$token = (Get-Content "$env:LOCALAPPDATA\Fremkit\access-4242.token" -TotalCount 1)
Invoke-RestMethod -Method Post -Headers @{ Authorization = "Bearer $token" } http://127.0.0.1:4242/api/widgets/rescan
```

Checks: `pnpm typecheck` and `pnpm test` run on Windows (CI runs them on `windows-latest`, which is
where the Windows branches execute for real). `pnpm e2e` is not part of that job; it runs on the
Ubuntu one.

### Working in a VM

Development happens in a Windows 11 virtual machine (ARM64 on an Apple Silicon Mac, x64
elsewhere; the server has no native modules, so one build serves both). Keep the checkout on the
VM's own disk: `node_modules` on a shared folder is slow, and ACLs do not survive one. The
panel's touches cannot be tested in a VM, which has no Edge attached.

## The data folder is yours alone

On the Mac the data folder is `0700` and its files `0600`. Windows has no such bits, so at every
start the server gives the folder an ACL: your account and SYSTEM only, inheritance from the parent
removed, the grant inherited by everything created later (`icacls`, run by absolute path, in
`server/src/data-permissions.ts`). The support folder that holds the access secret gets the same
without the walk.

That is a reset, and it has a consequence: **an explicit ACL entry you add inside the data folder
is cleared at the next start.** Whatever is already in the folder is reset to inherit from it
(`icacls … /reset /T`), so a backup tool's grant or a hand-made "allow" on a file there does not
survive.

If the ACL cannot be applied the server still starts and logs a short code
(`acl-whoami-failed`, `acl-sid-invalid`, `acl-icacls-failed`, `acl-icacls-partial`), never a SID or a
name.

## Secrets: DPAPI

Secrets are protected with Windows DPAPI under your account, through the PowerShell host (below):

- `secrets.key` holds a random 32-byte key, wrapped by DPAPI (current user);
- `secrets.dpapi.json` holds each value, AES-256-GCM encrypted under that key, filed by
  `<connectionId>/<fieldKey>`.

Neither file carries a plaintext secret, a value never reaches argv, and a connection's secret is
never returned by the API, as on the Mac ([connections.md](connections.md#where-the-values-are-kept)).
A config brought over from a Mac says `keychain`; on Windows that means DPAPI, so it works as is
(its secrets are not carried along: the keychain does not travel, type them again).

**A `file` backend moves to DPAPI by itself.** A config that says `secrets.backend: "file"`
(carried over from an earlier config or another system) keeps its secrets in clear text in
`data\secrets.json`. At start, Windows moves them (`server/src/secrets/move-to-dpapi.ts`): every
secret is written to DPAPI and read back, and only when each one comes back identical is the
config switched to `dpapi` (the history keeps the version before, as *Secrets moved under Windows
protection*) and `data\secrets.json` deleted. Nothing to do, nothing to type again; the log says
`plaintext secrets.json moved to DPAPI` with the code `moved`.

If the move cannot finish, nothing changes: the backend stays `file`, `data\secrets.json` stays as
it was, the secrets keep working, and the next start tries again. The log says `plaintext
secrets.json kept; trying again at next start` with a code, never a secret or its name:

- `dpapi-failed`: DPAPI did not answer or refused (see [the PowerShell host](#the-powershell-host)
  and the `stored secrets unreadable` codes below).
- `mismatch`: a secret did not read back as written. It should not happen; if it keeps coming
  back, open an issue with that log line.
- `file-unreadable`: `data\secrets.json` cannot be read (locked by another program, access denied)
  or is not a JSON object. A lock passes by itself. A file that is not a JSON object is rewritten
  as one by saving any secret from the admin (the store already reads it as empty); restart
  afterwards.
- `config-save`: the config could not be saved (`data\fremkit.json` locked by another program, an
  antivirus or the indexer, or a full disk).
- `config-sync`: the move is done but the saved config could not be flushed to disk, so
  `data\secrets.json` is kept; the next start deletes it if every value in it still matches DPAPI,
  and keeps it otherwise (`leftover-differs`, below).
- `file-remove`: the move is done but `data\secrets.json` could not be deleted; the next start
  deletes it under the same rule.

Entries no store can read, a malformed name or a value that is not text (only a hand edit makes
them), are left out of the move rather than stopping it: the log says `secrets.json entries no
store can read, not moved` with the code `entries-skipped` and their count, never their names, and
they go with the file.

A `data\secrets.json` found beside a config already on DPAPI (a start interrupted between the switch
and the deletion) is deleted when every secret in it is in DPAPI with the same value
(`leftover-removed`). One that differs, or cannot be read, is kept and logged
(`leftover-differs`, `leftover-unreadable`): it is plaintext, so look at it, then delete it yourself.

### When the store cannot be read

DPAPI keys belong to one Windows user on one machine. A data folder copied from another PC or user,
a restored backup, a hand-altered file, or a `secrets.dpapi.json` with no `secrets.key` beside it
starts **empty**: the server boots, the log says `stored secrets unreadable here, starting empty`
with a code (`dpapi-foreign`, `invalid-arg`, `key-invalid`, `key-missing`, `index-corrupt`), and you
type the secrets again. The old files are never overwritten: the first write sets them aside as
`secrets.key.unreadable-<stamp>` and `secrets.dpapi.json.unreadable-<stamp>`, one stamp (a
millisecond timestamp) for the pair, before a new key is made.

**`dpapi-foreign` does not always mean another user's key.** Windows answers it, with error
`0x8009000B` among others, when the user's profile is not loaded: a server started from a service
or a scheduled task under a different account, or before the profile is available. If the secrets
are yours, do not retype anything yet:

1. Stop the server. If nothing has been written since (no new secret typed), nothing was set aside:
   start it again as yourself, in a normal session, and the store reads.
2. If a secret was typed in the meantime, a new `secrets.key` and `secrets.dpapi.json` exist beside
   the `.unreadable-<stamp>` pair. Move the new two away, rename the pair back (drop the
   `.unreadable-<stamp>` suffix on both, same stamp), and start the server as yourself.

   ```powershell
   cd <data folder>
   Rename-Item secrets.key secrets.key.new; Rename-Item secrets.dpapi.json secrets.dpapi.json.new
   Rename-Item secrets.key.unreadable-<stamp> secrets.key
   Rename-Item secrets.dpapi.json.unreadable-<stamp> secrets.dpapi.json
   ```

A host that is merely unreachable (`timeout`, `host-exited`) is not an unreadable store: reads and
writes fail with that code and the next call tries again, and no file is touched.

## The PowerShell host

Windows system calls that Node has no API for (the clipboard, the volume, batteries, Wi-Fi and the
default route, DPAPI, the list of WSL distributions, a notification sound) go through one
long-lived Windows PowerShell child, `server/src/win/powershell-host.ts` running
`server/src/win/host.ps1`. It exists because starting `powershell.exe` costs about a second and the
Core Audio interop is compiled once, not per call.

The rules are the security rules, so they are worth knowing before changing it:

- The script is a constant, shipped with the server and read from disk once. It is sent on the
  child's stdin as a base64 bootstrap; argv holds only the fixed flags (`HOST_ARGS`), never a
  script path or data, because any account on the machine reads every process's command line.
- The operations are a closed list (`HostOp`: `clipboard.read`, `clipboard.write`,
  `clipboard.private`, `volume.get`, `volume.set`, `volume.mute`, `battery`, `network.wifi`,
  `network.default`, `sound`, `dpapi.protect`, `dpapi.unprotect`, `wsl.list`, `memory`, `drives`,
  `processes`); anything else answers `unknown-op`. Each op validates its argument.
- One request is in flight at a time. A call's timer starts when its line is written, and only an
  op that overruns it restarts the host; a call that waits too long for its turn fails with `busy`
  and leaves the host alone.
- Requests and answers are one JSON line each, ASCII only, so no console code page can mangle
  text. Clipboard text, DPAPI values and device names travel on stdin and stdout and are never
  logged; stderr is drained and dropped; an answer's failure code is a short fixed token.
- Every Windows tool the server runs itself (`icacls`, `whoami`, `ping`, `wsl`, `rundll32`,
  PowerShell) is run by absolute path under `%SystemRoot%\System32` through `windowsTool()`
  (`server/src/platform/windows-tools.ts`), with an argument list and no shell. `SystemRoot`,
  `LOCALAPPDATA` and the other environment folders are used only when they are absolute drive
  paths. `PATH` for children starts with the system folders (`safePath`), and children get an
  allow-listed environment. Memory, drives and processes come from the host rather than from
  `systeminformation`, which would start a `powershell.exe` of its own per call; on Windows the
  server calls it only for `currentLoad()`, which reads `os.cpus()` and runs nothing.

To add an op: the list and its types in `powershell-host.ts`, the handler and its argument checks
in `host.ps1` (the comment at its top is the protocol table), a fake in the tests, and a line here
if it changes what the host may touch.

## Tablets

Pairing an iPad or Android tablet works as on the Mac ([devices.md](devices.md)), with the
differences that matter on Windows:

- The PC is advertised with a Node mDNS responder (no `dns-sd` binary), and the pairing certificate
  is made without `openssl`.
- Windows Defender Firewall can prompt the first time Node listens for the tablet on port 4243;
  allow it on private networks. If the tablet does not find the PC, use the QR code, or the typed
  address ([devices.md](devices.md#troubleshooting)).

## Claude Code and Codex

[claude-code.md](claude-code.md#windows) has the Windows hook and status line commands, and
[its WSL section](claude-code.md#wsl) what is read from WSL distributions, how a distribution is
ticked (**Privacy → WSL distributions to read**), and why live sessions in WSL need *mirrored*
networking. That is all the WSL setup there is; this page does not repeat it.

Codex ([codex.md](codex.md)) is looked for in the Windows install locations. When it is installed
only inside WSL and a distribution is ticked, the account and history come from the first ticked
distribution: the app-server runs as `wsl.exe -d <distro> … exec codex <args>` with a fixed
argument list, and its `state_5.sqlite` is copied from `\\wsl.localhost\<distro>` into
`<data folder>\tmp\wsl-codex-<random>` (read there, removed when the copy has settled, swept at
start) and read with `node:sqlite`. Nothing is read or started in a distribution that is not ticked.

## Touch

Not solved yet, and not the server's job. Without iCUE, the Xeneon Edge's panel sends its touches
as absolute mouse input that Windows spreads over the primary display, so touching the strip clicks
somewhere else. The Windows helper (a later phase) is where that is handled. Until then, drive the
dashboard from the mouse or from a tablet.
