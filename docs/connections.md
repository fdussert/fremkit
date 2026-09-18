# Connections

A widget that talks to an outside service reads its credentials from a *connection*: a named set
of fields, configured once in the admin's **Connections** dialog and referenced by the widget's
`connection` setting. Several widgets can share one connection, and one service can have several
(two printers, five calendars).

![The Connections dialog in the admin](images/admin-connections.png)

| Type | Fields | Used by |
|---|---|---|
| [Azure DevOps](#azure-devops) | organisation, project, personal access token | `ado-pipelines` |
| [Bambu Lab](#bambu-lab) | IP address, serial number, access code, model | `bambu-job` |
| [GitHub](#github) | API host, personal access token, repositories | `github-inbox`, `github-actions` |
| [Homey Pro](#homey-pro) | address, API key | `homey-devices`, `homey-flows` |
| [ICS calendar](#ics-calendars) | calendar address, colour | `calendar` |

Each connection has a **Test** button that does a real round trip and reports what it found.

## Where the values are kept

Non-secret fields live in `data/fremkit.json`, which is git-ignored. Fields marked secret never
do: they go to a secret store chosen by `secrets.backend`.

- `keychain` (the default on macOS) — one generic-password item per secret, service `fremkit`,
  account `<connectionId>/<fieldKey>`. Caveat: `security` takes the value as a command-line
  argument, so it is briefly visible in `ps` to other processes of the same user. On a shared
  machine, prefer the file backend.
- `file` (the default elsewhere) — `data/secrets.json`, mode 600, git-ignored.

Changing the backend migrates nothing: the secrets have to be typed again.

A secret is never returned by the API, logged, written to the config or sent on the WebSocket.
`GET /api/connections` replaces each one with a boolean saying whether it is set. Error messages
are reduced to a phrase rather than passed through, because a network error can quote the URL and
the URL can carry the organisation or the calendar address. Deleting a connection a widget still
points at is refused with a 409 naming the widgets.

## Local Network

macOS 15 and later gate LAN access per application. The server runs inside whatever launched it —
your terminal under `pnpm dev`, or Fremkit Helper when it manages the server — and *that* app must
be allowed under System Settings → Privacy & Security → Local Network. Otherwise every connection
to a LAN device fails as `EHOSTUNREACH` while `ping` works. This is the usual cause of a Bambu
printer or a Homey that answers `ping` but not Fremkit. See
[troubleshooting.md](troubleshooting.md).

---

## Azure DevOps

| Field | Secret | What it is |
|---|---|---|
| `organization` | no | The segment after `dev.azure.com/` in the project URL |
| `project` | no | The project name |
| `pat` | **yes** | A personal access token |

**Getting the token.** In Azure DevOps, User settings → Personal access tokens → New token. Tick
**Build** in **Read** mode; nothing else is needed. Give it the shortest lifetime you can live
with — the widget stops working the day it expires, and the test then says the token was refused.

The token is sent as the password of an HTTP Basic pair with an empty user name, which is what
`dev.azure.com` expects, over https. It is stored as a secret and never logged.

Used by [`ado-pipelines`](widgets.md#ado-pipelines).

## Bambu Lab

| Field | Secret | What it is |
|---|---|---|
| `host` | no | The printer's IP address (or host name) |
| `serial` | no | The printer's serial number |
| `accessCode` | **yes** | The LAN access code |
| `model` | no | H2C, H2D, H2S, X1C, X1E, P1S, P1P, A1, A1 mini, other — display only |

**Getting the credentials.** On the printer's own screen: the IP address and the access code are
under Settings → Network, next to the LAN mode switch; the serial number is under Settings →
About.

Fremkit connects to the printer's own MQTT broker over TLS on port 8883 and never talks to Bambu's
cloud. The printer serves a self-signed certificate, so the certificate is not verified — the
traffic stays on the LAN and is still encrypted.

**LAN-only mode.** Not required on most firmware: the local broker also answers while the printer
stays connected to Bambu's cloud. But firmware with Bambu's "authorization control" (H2 series, X1
on 2025 firmware) may refuse third-party local access unless developer mode is enabled, which
Bambu only offers in LAN-only mode. A test that fails on authentication with an access code you
know is right is that.

### The chamber camera

P1 and A1 printers serve JPEG frames on port 6000, and Fremkit reads them directly.

X1 and H2 printers do not: they publish an RTSPS stream on port 322 instead, which needs
**ffmpeg** on the machine running Fremkit — `brew install ffmpeg`. Without it the tile says so
rather than just "unavailable". The stream also has to be switched on from the printer, under
Settings → Camera → **LAN Mode Liveview**; with it off the port answers and then refuses the
session, and the tile shows its placeholder.

Fremkit passes the stream URL to ffmpeg through a private temporary file rather than on the
command line, so the access code does not show up in the process list. On an ffmpeg build too old
for that it falls back to the command line, and the code is then visible to anyone who can list
processes on the machine.

### What the TLS does and does not prove

The printer serves a self-signed certificate on both the MQTT port and the camera port, so
Fremkit connects with `rejectUnauthorized: false`: the traffic is encrypted, but nothing checks
*who* is on the other end. Anything on the same network that can answer for the printer's address
— by ARP spoofing it, or by being handed it through DHCP — can present its own certificate,
receive the LAN access code, and serve whatever chamber image it likes.

This is a property of LAN mode, not of Fremkit: the printer has no certificate authority to
verify against. It is worth knowing if the Fremkit machine shares a network with devices you do
not control, in which case a printer on its own VLAN is the answer. Pinning the certificate the
printer first presented would narrow the window to the first connection; it is not implemented.

Used by [`bambu-job`](widgets.md#bambu-job).

## GitHub

| Field | Secret | What it is |
|---|---|---|
| `host` | no | The API root. Empty means `https://api.github.com` |
| `token` | **yes** | A personal access token |
| `repos` | no | Comma-separated `owner/name` list, read by the Actions widget |

**Getting the token.** GitHub offers two kinds and Fremkit accepts either, but only one of them
can read your notifications — see the limitation below.

*Classic* (Settings → Developer settings → Personal access tokens → Tokens (classic)), the one to
pick if you want the inbox. It starts with `ghp_`. Tick **notifications**; add **repo** if any
repository you care about is private, and **read:org** if your review requests come through a
team. `repo` already carries the Actions read access, so there is nothing else to tick.

*Fine-grained* (Settings → Developer settings → Personal access tokens → Fine-grained tokens),
starting with `github_pat_`. Grant, all **read-only**: **Metadata**, **Pull requests** and
**Actions** (repository permissions). Select the repositories you want the Actions widget to
watch; a token scoped to "public repositories only" shows no private workflow run.

**Notifications need a classic token.** `GET /notifications` is one of the endpoints GitHub has
not opened to fine-grained tokens: it answers `403 Resource not accessible by personal access
token` however the **Notifications** account permission is set. Fremkit does not treat that as a
broken connection. Review requests, your own pull requests and the Actions runs keep working, the
connection test says as much in its detail line, and the `github-inbox` widget draws one small
"Notifications need a classic token" line in place of the inbox. The provider asks once and then
stops asking, so the 403 is not repeated every minute.

Whichever you pick, give it the shortest lifetime you can live with: the widgets stop the day it
expires, and the connection test then says the token was refused.

**GitHub Enterprise Server.** Put the API root in `host` — `https://github.example.com/api/v3`,
not the web address. Only `https` is accepted: the token travels on every call. The web links the
widgets open are rebuilt from each repository's own `html_url`, so they point at your server
rather than at github.com.

**Repositories.** `repos` is what the Actions widget reads, one API call per repository per poll,
ten repositories at most. Leave it empty and the inbox widget still works; the Actions widget just
has nothing to draw. The widget's own **Repositories** setting is a `pick` list fed by
`GET /user/repos`, and narrows the display to a subset of what the connection fetches.

A repository the token cannot reach answers `404`, not `403` — GitHub hides a private repository
rather than admitting it exists — so the widget says "Repository not found or not accessible by
this token" rather than guessing which, and a misspelt `owner/name` and a repository outside a fine-grained token's selection look
exactly alike. Check the spelling first, then the token's repository selection.

**What it costs.** One poll a minute: the inbox, two pull-request searches and one call per
repository. Every one of them is a conditional request — the previous `ETag` goes back as
`If-None-Match` — and GitHub does not charge a `304 Not Modified` against the hourly quota, so a
quiet day costs almost nothing. `X-Poll-Interval` on the notifications response is honoured, and a
`403` that GitHub blames on the rate limit stops the polling until `X-RateLimit-Reset`.

**One source failing is not the whole tile failing.** The four sources — notifications, review
requests, your pull requests, the Actions runs — are polled independently. One that fails keeps
the rows it last had and is labelled in the snapshot's `errors` map (`unauthorized`, `forbidden`,
`fine-grained-token`, `rate-limited`, `not-found`, `offline`); the widgets draw that one line and
leave the rest alone. The whole-snapshot `error` appears only when the token itself is refused or when every
source failed at once.

The token is sent as a bearer token, stored as a secret, and never logged, echoed back or put in a
URL. Error messages are reduced to a phrase rather than passed through, because a network error
quotes the URL and on an Enterprise host the URL is itself private.

**Pull request checks.** The snapshot has room for a CI verdict next to each of your pull
requests, and Fremkit leaves it empty: the search results carry no head commit, so filling it in
would cost two extra calls per pull request every minute. The `github-actions` widget shows the CI
state instead.

Used by [`github-inbox`](widgets.md#github-inbox) and
[`github-actions`](widgets.md#github-actions).

## Homey Pro

| Field | Secret | What it is |
|---|---|---|
| `host` | no | The Homey's IP address, or its `homey-xxxx.local` name |
| `apiKey` | **yes** | A local API key |

**Getting the key.** In the Homey app, Settings → General → API Keys → create a key. Tick at least
**Devices** and **Flows** in read *and* control mode — read alone lists everything but refuses
every tap. Add **Zones** (read) if you want zone names on the device tiles and in the device
picker; without it the tiles still work, they just lose the grouping. The **System** scope is not
needed: the connection test falls back to the devices endpoint when it is missing.

Fremkit talks to the Homey's own local Web API over plain http inside the LAN and never to Athom's
cloud. The key is sent as a bearer token, stored as a secret, and never logged, echoed back or put
in a URL. A Homey Pro (2023) is the model this was written against.

Every ten seconds Fremkit reads the devices, the flows and the Advanced Flows. The snapshot keeps
the capabilities a tile can draw — `onoff`, `dim`, `target_temperature` and every `measure_*` and
`alarm_*` reading — with their current values, units and ranges. A poll that fails keeps the last
snapshot on screen, dimmed, and retries after five seconds. Advanced Flows and flow folders only
exist on recent firmware; their absence costs a label, not the connection.

Used by [`homey-devices`](widgets.md#homey-devices) and
[`homey-flows`](widgets.md#homey-flows).

## Synology

| Field | Secret | What it is |
|---|---|---|
| `host` | no | The NAS address, with the DSM HTTPS port if it is not `5001` |
| `account` | no | A DSM account |
| `password` | **yes** | Its password |
| `otp` | **yes** | A verification code, only for the first login of a two-factor account |
| `deviceId` | **yes** | Written by Fremkit after a two-factor login — leave it empty |
| `allowSelfSigned` | no | Accept the certificate a NAS on the LAN serves |

**Use a dedicated account.** Control Panel → User → create one, give it no access to any shared
folder, and deny it every application. The two APIs Fremkit reads —
`SYNO.Core.System.Utilization` and `SYNO.Storage.CGI.Storage` — need nothing more. A password
that also opens the file shares is a password on a dashboard, which is a strictly worse trade
than the five minutes it takes.

**Two-factor accounts.** Fill `otp` with a fresh six-digit code and save. DSM refuses a code it
has already seen, so Fremkit asks it to issue a *device token* at the same time and stores that
token as another secret of the connection; every later login uses the token, and the spent code
is deleted for you.

**The Test button never spends the code.** It logs in with the password alone, because it has
nowhere to put a device token — there is no saved connection yet — and a Test that enrolled
would consume the six digits and leave the first poll to retry them, which DSM refuses for
ever. DSM asks for a code only *after* accepting the password, so on a two-factor account Test
answers "password accepted — enrolment happens on the first poll after saving". That is a
success: the credentials are right.

**A privilege the account lacks** is reported as such rather than as a wrong password. DSM
answers code 105 for an API the account may not call, and a new session would not change it —
so the connection says "this DSM account lacks the permission to read this", and the widgets
show `forbidden`. `SYNO.Core.System`, which carries the model and the DSM version, is the one
call whose refusal costs only a label: the gauges and the volumes still arrive without it.

**The certificate.** Fremkit only ever talks HTTPS to the NAS. A Synology on the local network
almost always serves a certificate no authority signed, so `allowSelfSigned` exists; turn it on
only for a local address you know. It is off by default and applies to this connection alone —
never to anything else the server talks to.

Every thirty seconds Fremkit reads CPU, memory and network counters, the model, the DSM version
and the uptime, then the volumes and disks: size, used, status, and each disk's model,
temperature and SMART verdict. A poll that fails keeps the last snapshot on screen with an
`offline`, `unauthorized` or `forbidden` marker and retries after ten seconds.

Every call is a `POST` with its parameters in the body. The password, the code and the session
id would otherwise travel in a query string, which is the first thing the NAS's own access log
and any reverse proxy in front of it write down. The session id lives in memory only; a session
DSM has forgotten (codes 106, 107 and 119) is re-established without the widget noticing, and a
failed poll logs out rather than leaving a session behind to expire on its own. None of the
password, the code, the token or the session id is ever logged, echoed back by the API or quoted
in an error — not even the network error's own message, which carries the address.

Used by the `synology-storage` and `synology-system` widgets, published on
[the registry](https://github.com/fdussert/fremkit-sietch) rather than shipped with Fremkit.

## ICS calendars

| Field | Secret | What it is |
|---|---|---|
| `url` | **yes** | The published calendar address |
| `color` | no | The dot that tells this calendar from the others |

The address *is* the credential — anyone holding it can read the whole calendar — so it is stored
as a secret and never logged or echoed back. Only `https` is accepted, at every redirect hop.

**Outlook on the web.** Settings → Calendar → Shared calendars → *Publish a calendar*, pick the
calendar and the **Can view all details** permission, publish, then copy the **ICS** link — not
the HTML one.

**Google Calendar.** Settings → *Settings for my calendars* → the calendar → Integrate calendar →
**Secret address in iCal format**. Use the secret address rather than the public one unless the
calendar is meant to be world-readable; resetting it revokes every copy.

Fremkit re-downloads the file every five minutes, expands recurrences — including exceptions,
moved instances and cancellations — over the next fortnight, and caps the download at 5 MB. One
connection is one calendar; add as many as you like and the `calendar` widget merges them, each
keeping its colour.

Used by [`calendar`](widgets.md#calendar).
