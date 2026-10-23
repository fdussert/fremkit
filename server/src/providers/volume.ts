import type { Provider } from './types.js'
import { osascript, type Runner } from './osascript.js'
import { z } from 'zod'
import { tr } from '../i18n.js'
import { targetPlatform } from '../platform/index.js'
import { HostError, sharedHost, type HostVolume } from '../win/powershell-host.js'

export function parseVolume(raw: string): { level: number; muted: boolean } {
  const level = Number(/output volume:(\d+)/.exec(raw)?.[1] ?? 0)
  const muted = /output muted:true/.test(raw)
  return { level, muted }
}

/** The level is a finite number; anything else is a caller mistake, not a volume of zero. */
export const SetPayloadSchema = z.object({ level: z.number().finite() })
export const MutePayloadSchema = z.object({ muted: z.boolean() })

export interface VolumeDeps {
  platform?: NodeJS.Platform
  host?: { call<T>(op: 'volume.get' | 'volume.set' | 'volume.mute', arg?: unknown, timeoutMs?: number): Promise<T> }
}

export function createVolumeProvider(run: Runner = osascript, deps: VolumeDeps = {}): Provider {
  if (targetPlatform(deps.platform) === 'win32') return createWindowsVolumeProvider(deps)
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

/** Windows: the same payload checks and the same clamp, with the host in place of osascript. */
function createWindowsVolumeProvider(deps: VolumeDeps): Provider {
  const host = () => deps.host ?? sharedHost()
  // Before a first success the snapshot type still needs a level, so it is 0 with the error; the widget ignores error snapshots.
  let last: { level: number; muted: boolean } = { level: 0, muted: false }
  return {
    channel: 'volume',
    intervalMs: 1000,
    poll: async () => {
      try {
        return (last = await host().call<HostVolume>('volume.get', undefined, 5000))
      } catch (e) {
        // `no-device` (no output device) and a host that is gone both keep the last level on screen.
        return { ...last, error: e instanceof HostError ? e.code : 'offline' }
      }
    },
    commands: {
      set: async (payload) => {
        const parsed = SetPayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'volume.invalidLevel'))
        const level = Math.max(0, Math.min(100, Math.round(parsed.data.level)))
        await host().call('volume.set', { level }, 5000)
        last = { ...last, level }
        return { level }
      },
      mute: async (payload) => {
        const parsed = MutePayloadSchema.safeParse(payload)
        if (!parsed.success) throw new Error(tr(undefined, 'volume.invalidMute'))
        const muted = parsed.data.muted
        await host().call('volume.mute', { muted }, 5000)
        last = { ...last, muted }
        return { muted }
      },
    },
  }
}
