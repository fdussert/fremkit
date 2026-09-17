import type { Provider } from './types.js'
import { osascript, type Runner } from './osascript.js'

export function parseVolume(raw: string): { level: number; muted: boolean } {
  const level = Number(/output volume:(\d+)/.exec(raw)?.[1] ?? 0)
  const muted = /output muted:true/.test(raw)
  return { level, muted }
}

export function createVolumeProvider(run: Runner = osascript): Provider {
  return {
    channel: 'volume',
    intervalMs: 1000,
    poll: async () => parseVolume(await run('get volume settings')),
    commands: {
      set: async (payload) => {
        const level = Math.max(0, Math.min(100, Math.round(Number((payload as { level?: number })?.level ?? 0))))
        await run(`set volume output volume ${level}`)
        return { level }
      },
      mute: async (payload) => {
        const muted = Boolean((payload as { muted?: boolean })?.muted)
        await run(`set volume output muted ${muted}`)
        return { muted }
      },
    },
  }
}
