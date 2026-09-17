import type { Provider } from './types.js'
import { osascript, type Runner } from './osascript.js'
import { z } from 'zod'
import { tr } from '../i18n.js'

export function parseVolume(raw: string): { level: number; muted: boolean } {
  const level = Number(/output volume:(\d+)/.exec(raw)?.[1] ?? 0)
  const muted = /output muted:true/.test(raw)
  return { level, muted }
}

/** The level is a finite number; anything else is a caller mistake, not a volume of zero. */
export const SetPayloadSchema = z.object({ level: z.number().finite() })
export const MutePayloadSchema = z.object({ muted: z.boolean() })

export function createVolumeProvider(run: Runner = osascript): Provider {
  return {
    channel: 'volume',
    intervalMs: 1000,
    poll: async () => parseVolume(await run('get volume settings')),
    commands: {
      set: async (payload) => {
        // Through zod, not Number(): `{ level: "loud" }` gave NaN, which the clamp passed
        // straight through and which then reached osascript as the literal `NaN`.
        const parsed = SetPayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'volume.invalidLevel'))
        const level = Math.max(0, Math.min(100, Math.round(parsed.data.level)))
        await run(`set volume output volume ${level}`)
        return { level }
      },
      mute: async (payload) => {
        const parsed = MutePayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'volume.invalidMute'))
        const muted = parsed.data.muted
        await run(`set volume output muted ${muted}`)
        return { muted }
      },
    },
  }
}
