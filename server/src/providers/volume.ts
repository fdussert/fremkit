import type { Provider } from './types.js'
import { osascript, type Runner } from './osascript.js'
import { createScriptHost } from './osascript-host.js'
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

/**
 * The two settings the widget shows, written out by the script.
 *
 * `get volume settings` answers a record, which `osascript -e` prints and the host that runs the
 * polls (osascript-host.ts) cannot: it hands back text only. The text is laid out as `osascript`
 * printed it, so `parseVolume` reads either. An output with no volume of its own (a display over
 * HDMI) answers `missing value` for both, which reads as 0 and not muted, as it always did.
 */
export const VOLUME_SETTINGS = `set v to get volume settings
return "output volume:" & (output volume of v) & ", output muted:" & (output muted of v)`

/**
 * `command` runs what a tap asks for, one process each: taps are rare. `poll` answers once a
 * second and must not start a process each time (see osascript-host.ts for what that cost), so
 * the real one is a host kept open. A test hands in one fake and gets it for both.
 */
export function createVolumeProvider(
  command: Runner = osascript,
  poll: Runner = command === osascript ? createScriptHost().run : command,
): Provider {
  return {
    channel: 'volume',
    intervalMs: 1000,
    poll: async () => parseVolume(await poll(VOLUME_SETTINGS)),
    commands: {
      set: async (payload) => {
        // Through zod, not Number(): `{ level: "loud" }` gave NaN, which the clamp passed
        // straight through and which then reached osascript as the literal `NaN`.
        const parsed = SetPayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'volume.invalidLevel'))
        const level = Math.max(0, Math.min(100, Math.round(parsed.data.level)))
        await command(`set volume output volume ${level}`)
        return { level }
      },
      mute: async (payload) => {
        const parsed = MutePayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'volume.invalidMute'))
        const muted = parsed.data.muted
        await command(`set volume output muted ${muted}`)
        return { muted }
      },
    },
  }
}
