# Local Docker and model observations

Fremkit publishes two read-only channels only while a dashboard widget subscribes. Their widgets live in the registry. Neither channel starts a container or a model.

## Docker

`docker-local` resolves Docker from `/opt/homebrew/bin/docker`, `/usr/local/bin/docker` or `~/.docker/bin/docker`, then reads the selected context. Only a local Unix socket is accepted; TCP and SSH contexts return `remote-context`. A missing executable returns `unavailable`; a stopped daemon or failed query returns `offline`; malformed data returns `invalid`. The snapshot is `{data, stale, error, updatedAt}`. When no successful snapshot exists, `data` is null and `stale` is false. A later failure retains the previous data with `stale: true`.

`data.containers` contains at most 200 records. Each record has `id`, `name`, `image`, `state`, `status` and `stats`. The optional `stats` object contains Docker's `cpu`, `memory`, `memoryPercent`, `pids`, `netIO` and `blockIO` strings. It is null for stopped containers and whenever stats cannot be collected. A container that stops after listing does not blank the rest of the snapshot. No commands, environment, labels, mounts or ports are published.

The helper needs access to the local Docker socket. This channel cannot start, stop, remove or execute a container.

## Local models

`local-models` reads Ollama on `127.0.0.1:11434` and selected local MLX or oMLX server processes. Its snapshot has independent `installed`, `loaded` and `mlx` parts, each with `{data, stale, error, updatedAt}`. `installed` and `loaded` contain at most 200 Ollama model records with `name`, `size`, `size_vram`, `context_length` and `expires_at`. `mlx` contains at most 20 process records with `pid`, `backend`, a path-free `model` label, `port`, `cpu` and `memoryBytes`. A missing or stopped Ollama daemon returns `offline` on its two parts without hiding MLX processes. Invalid Ollama JSON returns `invalid`.

A listed model or process does not prove inference is running. HTTP responses are limited to 1 MiB, redirects are refused, and no prompts or responses are read.

## RTK

Install RTK with `brew install rtk` (or any method its README lists that puts `rtk` in one of the paths below) and set it up for your coding agent; Fremkit only reads the savings RTK already records. Versions 0.51 and 1.0 were checked.

`rtk` reads the token savings of [RTK](https://github.com/rtk-ai/rtk), the CLI proxy that compacts command output for coding agents. It resolves the program from `/opt/homebrew/bin/rtk`, `/usr/local/bin/rtk`, `~/.cargo/bin/rtk` or `~/.local/bin/rtk`, runs `rtk gain --daily --format json` once a minute and publishes `{data, stale, error, updatedAt}` like `docker-local`. `data.total` has `commands`, `input`, `output`, `saved`, `percent` and `avgTimeMs`; `data.today` is the row for the local calendar day, zeros when RTK has not run yet; `data.daily` holds at most the last 30 days that have a row, oldest first, each with `date`, `commands`, `input`, `output`, `saved` and `percent`. A missing program returns `unavailable`, a failed run `offline`, malformed output `invalid`; a failure keeps the previous data with `stale: true` and retries after 15 seconds. The channel has no command, and no command text from RTK's history is published.
