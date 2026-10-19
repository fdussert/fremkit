/**
 * Which theme is in force: the config's `theme`, or its `themeSchedule.night` at night.
 *
 * Day and night are the screen brightness's own (`brightness/schedule.ts`): sunrise and sunset
 * computed on this Mac from coordinates the user typed, or two fixed times on the Mac's clock.
 * Without the ramp — a theme switches at once — and without a screen: the theme is the same on
 * every screen, so its schedule is one per config.
 *
 * Computed here and published on the `theme` channel, so the dashboard, the admin and a paired
 * device switch together and none of them carries the sun maths.
 */

import type { Config } from '../config/schema.js'
import type { Provider } from '../providers/types.js'
import { phaseAt } from '../brightness/schedule.js'

export interface ThemeInForce {
  /** The theme id the config names for now. An unknown id is painted as the built-in theme, as always. */
  id: string
  phase: 'day' | 'night'
  /** False when the config has no night theme: `phase` is then always `day`. */
  scheduled: boolean
  /** The next switch, when there is one in sight. */
  next?: { at: string; to: 'day' | 'night' }
  /** A sunrise-and-sunset schedule with no coordinates yet: the day theme stays. */
  problem?: 'no-location'
}

export function themeInForce(config: Pick<Config, 'theme' | 'themeSchedule'>, now: number): ThemeInForce {
  const schedule = config.themeSchedule
  if (!schedule) return { id: config.theme, phase: 'day', scheduled: false }
  const phase = phaseAt(now, { ...schedule, rampMinutes: 0 })
  if (phase === 'no-location') return { id: config.theme, phase: 'day', scheduled: true, problem: 'no-location' }
  // With no ramp the state is always settled: `dimming` and `brightening` cannot happen.
  const night = phase.state === 'night' || phase.state === 'dimming'
  return {
    id: night ? schedule.night : config.theme,
    phase: night ? 'night' : 'day',
    scheduled: true,
    ...(phase.next ? { next: { at: new Date(phase.next.at).toISOString(), to: phase.next.to } } : {}),
  }
}

/**
 * The `theme` snapshot as a device hears it: the theme in force and its phase, without the time of
 * the next switch. That time is the next sunrise or sunset at the coordinates the user typed, so it
 * places the Mac on a map; the device switches when the channel says so and never needs it.
 */
export function deviceThemeView(data: unknown): unknown {
  if (!data || typeof data !== 'object') return null
  const { next: _next, ...rest } = data as Record<string, unknown>
  return rest
}

/** How often the schedule is read again: a theme switches within this of sunset. */
export const THEME_INTERVAL_MS = 10_000

/**
 * The `theme` channel. Polled on a short clock so the switch lands on time; the registry
 * publishes only when the answer changed, which is twice a day (and on every save that changes
 * it: the app refreshes the channel whenever the config changes).
 */
export function createThemeProvider(config: () => Config, now: () => number = Date.now): Provider<ThemeInForce> {
  return {
    channel: 'theme',
    intervalMs: THEME_INTERVAL_MS,
    poll: async () => themeInForce(config(), now()),
  }
}
