import { execFile } from 'node:child_process'
import type { CommandContext, Provider } from './types.js'
import { osascript, type Runner } from './osascript.js'
import { tr } from '../i18n.js'

/**
 * Field separator for the AppleScript answer.
 *
 * ASCII unit separator, not `|||`: a track, artist or album name can contain any printable text,
 * and a title with three pipes in it used to shift every field after it.
 */
const SEP = '\x1f'
const IS_RUNNING = 'tell application "System Events" to (name of processes) contains "Spotify"'
/**
 * The position is rounded to milliseconds by AppleScript rather than read as the float it is.
 *
 * `player position` is the one fractional value here, and AppleScript writes a number with the
 * Mac's own decimal separator: on a French system it answers `69,724998`, which `Number()` reads
 * as NaN — and a NaN position is a progress bar that never moves. An integer has no separator to
 * get wrong. `duration` is already in milliseconds, and `sound volume` is already whole.
 */
export const STATE = `tell application "Spotify"
  if player state is stopped then return "stopped"
  set sep to "${SEP}"
  return (player state as string) & sep & (name of current track) & sep & (artist of current track) & sep & (album of current track) & sep & (artwork url of current track) & sep & (duration of current track) & sep & (round ((player position) * 1000)) & sep & (sound volume)
end tell`

export function parseSpotify(raw: string) {
  const [state, title, artist, album, artwork, duration, position, volume] = raw.split(SEP)
  return {
    available: true as const,
    state: state as 'playing' | 'paused' | 'stopped',
    title, artist, album, artwork,
    durationMs: Number(duration),
    positionMs: Number(position),
    volume: Number(volume),
  }
}

/** The one program the `activate` command runs, by bundle id, with a fixed argv. */
export const SPOTIFY_BUNDLE_ID = 'com.spotify.client'
/**
 * By absolute path, not by name: `execFile` resolves a bare name through `PATH`, and the server
 * inherits whatever `PATH` the helper — or a terminal, or a login shell's rc file — happened to
 * hand it. There is one `open` on macOS and this is where it lives.
 */
export const OPEN_PROGRAM = '/usr/bin/open'
/** How long `open` may take before the command gives up. */
export const ACTIVATE_TIMEOUT_MS = 10_000

export type Opener = (file: string, args: string[]) => Promise<void>

const openProgram: Opener = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: ACTIVATE_TIMEOUT_MS }, (err, _out, stderr) => {
      // Neither `stderr` nor the error's own message goes any further: both quote the command
      // line, and a widget learns nothing useful from either. The caller turns this into one
      // fixed sentence.
      if (err) reject(new Error(stderr.trim() || err.message))
      else resolve()
    })
  })

export function createSpotifyProvider(run: Runner = osascript, open: Opener = openProgram): Provider {
  const tell = (cmd: string) => run(`tell application "Spotify" to ${cmd}`).then(() => ({ ok: true }))
  return {
    channel: 'spotify',
    intervalMs: 1000,
    async poll() {
      if ((await run(IS_RUNNING)) !== 'true') return { available: false }
      const raw = await run(STATE)
      if (raw === 'stopped') return { available: true, state: 'stopped' }
      return parseSpotify(raw)
    },
    commands: {
      playPause: () => tell('playpause'),
      next: () => tell('next track'),
      previous: () => tell('previous track'),
      /**
       * Brings the Spotify application forward — what a long press on the widget asks for.
       *
       * Takes no payload at all: the argv is fixed, so there is nothing a caller could steer.
       * Loopback-gated like every other command that acts on the Mac.
       */
      activate: async (_payload, ctx?: CommandContext) => {
        if (!ctx?.loopback) return { ok: false, error: tr(undefined, 'provider.localOnly') }
        try {
          await open(OPEN_PROGRAM, ['-b', SPOTIFY_BUNDLE_ID])
          return { ok: true }
        } catch {
          // A fixed sentence: the underlying failure quotes the command line, and a widget in a
          // sandboxed iframe is not who that belongs to. The server's log has the rest.
          return { ok: false, error: tr(undefined, 'spotify.activateFailed') }
        }
      },
    },
  }
}
