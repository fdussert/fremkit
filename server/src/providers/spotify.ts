import type { Provider } from './types.js'
import { osascript, type Runner } from './osascript.js'

const SEP = '|||'
const IS_RUNNING = 'tell application "System Events" to (name of processes) contains "Spotify"'
const STATE = `tell application "Spotify"
  if player state is stopped then return "stopped"
  set sep to "${SEP}"
  return (player state as string) & sep & (name of current track) & sep & (artist of current track) & sep & (album of current track) & sep & (artwork url of current track) & sep & (duration of current track) & sep & (player position) & sep & (sound volume)
end tell`

export function parseSpotify(raw: string) {
  const [state, title, artist, album, artwork, duration, position, volume] = raw.split(SEP)
  return {
    available: true as const,
    state: state as 'playing' | 'paused' | 'stopped',
    title, artist, album, artwork,
    durationMs: Number(duration),
    positionMs: Math.round(Number(position) * 1000),
    volume: Number(volume),
  }
}

export function createSpotifyProvider(run: Runner = osascript): Provider {
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
    },
  }
}
