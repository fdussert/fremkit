# Local Docker and model observations

Fremkit publishes two channels only while a dashboard widget subscribes. Their widgets live in the registry. `local-models` is read-only and never starts a model; `docker-local` can start, stop and restart a container it listed, for a widget that was granted its commands, and does nothing else to one.

## Docker

`docker-local` resolves Docker from `/opt/homebrew/bin/docker`, `/usr/local/bin/docker` or `~/.docker/bin/docker`, then reads the selected context. Only a local Unix socket is accepted; TCP and SSH contexts return `remote-context`. A missing executable returns `unavailable`; a stopped daemon or failed query returns `offline`; malformed data returns `invalid`. The snapshot is `{data, stale, error, updatedAt}`. When no successful snapshot exists, `data` is null and `stale` is false. A later failure retains the previous data with `stale: true`.

`data.containers` contains at most 200 records. Each record has `id`, `name`, `image`, `state`, `status` and `stats`. The optional `stats` object contains Docker's `cpu`, `memory`, `memoryPercent`, `pids`, `netIO` and `blockIO` strings. It is null for stopped containers and whenever stats cannot be collected. A container that stops after listing does not blank the rest of the snapshot. No commands, environment, labels, mounts or ports are published.

`data.actions` lists what the channel can do to a container: `["start", "stop", "restart"]`. A release older than these commands publishes no `actions` at all, so a widget shows a button only for a verb it finds there.

### Commands

`start`, `stop` and `restart` each take `{ id }`, the `id` of a container from the last snapshot, and answer `{ ok: true }` or `{ ok: false, error }`. A widget sends them with `Fremkit.sendCommand('docker-local', 'stop', { id })` and needs `docker-local` in its manifest's `commands`, which the person installing it is asked to accept.

- The target comes from the list and from nothing else: an id the channel did not publish answers `unknown-container`, anything that is not an identifier answers `invalid`. A name is not accepted.
- The context is read again before each action. A context that is no longer a local Unix socket answers `remote-context` and nothing is run.
- One action runs at a time on a container; a second one meanwhile answers `busy`.
- A caller that is neither this Mac nor a paired device answers `local-only`.
- A missing executable answers `unavailable`; any other failure answers `failed`, with no text from Docker. `docker stop` is given 60 seconds, since it waits for the container's own grace period.
- The list is polled again as soon as an action ends, whatever its outcome.

The helper needs access to the local Docker socket. This channel cannot remove, kill, pause or create a container, and cannot run anything inside one.

## Local models

`local-models` reads Ollama on `127.0.0.1:11434` and selected local MLX or oMLX server processes. Its snapshot has independent `installed`, `loaded` and `mlx` parts, each with `{data, stale, error, updatedAt}`. `installed` and `loaded` contain at most 200 Ollama model records with `name`, `size`, `size_vram`, `context_length` and `expires_at`. `mlx` contains at most 20 process records with `pid`, `backend`, a path-free `model` label, `port`, `cpu` and `memoryBytes`. A missing or stopped Ollama daemon returns `offline` on its two parts without hiding MLX processes. Invalid Ollama JSON returns `invalid`.

A listed model or process does not prove inference is running. HTTP responses are limited to 1 MiB, redirects are refused, and no prompts or responses are read.

## RTK

Install RTK with `brew install rtk` (or any method its README lists that puts `rtk` in one of the paths below) and set it up for your coding agent; Fremkit only reads the savings RTK already records. Versions 0.51 and 1.0 were checked.

`rtk` reads the token savings of [RTK](https://github.com/rtk-ai/rtk), the CLI proxy that compacts command output for coding agents. It resolves the program from `/opt/homebrew/bin/rtk`, `/usr/local/bin/rtk`, `~/.cargo/bin/rtk` or `~/.local/bin/rtk`, runs `rtk gain --daily --format json` once a minute and publishes `{data, stale, error, updatedAt}` like `docker-local`. `data.total` has `commands`, `input`, `output`, `saved`, `percent` and `avgTimeMs`; `data.today` is the row for the local calendar day, zeros when RTK has not run yet; `data.daily` holds at most the last 30 days that have a row, oldest first, each with `date`, `commands`, `input`, `output`, `saved` and `percent`. A missing program returns `unavailable`, a failed run `offline`, malformed output `invalid`; a failure keeps the previous data with `stale: true` and retries after 15 seconds. The channel has no command, and no command text from RTK's history is published.
