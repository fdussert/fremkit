/**
 * What level a screen should be at, from its settings, the clock, the Mac's built-in display and
 * the last manual change. Pure: the provider calls it on every tick and after every event.
 *
 * The rules, as the Screen settings explain them:
 *
 * - **Neither mode on**: the screen stays where it was last put. A manual change is just the level.
 * - **Day / night**: `day` in the day, `night` at night, a linear ramp of `rampMinutes` starting at
 *   each transition.
 * - **Follow the Mac**: `builtin% × scale + offset`, clamped to 0–100.
 * - **Both**: follow the Mac, with day/night as a *ceiling* that goes from 100 (day: no cap) down to
 *   the night level, along the same ramp. The ambient light sensor knows the room better than a
 *   clock does; the schedule only keeps a bright room at night from waking up the strip.
 * - **A manual change while a mode is on** holds until the next transition starts (day/night) or
 *   until the built-in display moves by `FOLLOW_RELEASE` (follow the Mac), whichever comes first —
 *   or until the user taps "back to automatic". A change made while no mode was on never overrides
 *   a mode turned on later.
 */

import type { BrightnessSettings } from '../config/schema.js'
import { phaseAt, transitionsAround, type Phase } from './schedule.js'

/** How far the built-in display has to move (0–1) before a manual change gives way to it. */
export const FOLLOW_RELEASE = 0.1

export type BrightnessMode = 'manual' | 'day-night' | 'follow-mac' | 'both'

/** The last level a person chose, with what the world looked like when they did. */
export interface Held {
  value: number
  at: number
  /** The mode that was in force: a change made in `manual` never overrides an automatic mode. */
  mode: BrightnessMode
  /** The built-in display's level at that moment, 0–1, when there is one. */
  builtin: number | null
}

export interface DecideInput {
  settings: BrightnessSettings | undefined
  now: number
  /** The Mac's built-in display, 0–1, or null when there is none (or it is off, lid closed). */
  builtin: number | null
  held: Held | null
}

export interface Decision {
  /** The level to put the screen at, 0–100, or null for "leave it alone". */
  target: number | null
  mode: BrightnessMode
  /** True while a manual change holds an automatic mode back. */
  overridden: boolean
  /** True when `held` no longer applies; the caller drops it. */
  releaseHeld: boolean
  /** Day/night asked for but not computable: no coordinates typed yet. */
  dayNightProblem?: 'no-location'
  /** Follow-the-Mac asked for but no built-in display to follow. */
  followProblem?: 'no-builtin'
  phase?: Pick<Phase, 'state' | 'next'>
}

const clamp = (v: number): number => Math.max(0, Math.min(100, Math.round(v)))
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export function followLevel(builtin: number, settings: BrightnessSettings['followMac']): number {
  return clamp(builtin * 100 * settings.scale + settings.offset)
}

/** True when a manual change made under an automatic mode has run its course. */
function heldExpired(held: Held, input: DecideInput, dayNight: boolean, follow: boolean): boolean {
  if (dayNight && input.settings) {
    const events = transitionsAround(held.at, input.settings.dayNight)
    if (Array.isArray(events)) {
      const next = events.find((e) => e.at > held.at)
      if (next && input.now >= next.at) return true
    }
  }
  if (follow && held.builtin !== null && input.builtin !== null) {
    if (Math.abs(input.builtin - held.builtin) >= FOLLOW_RELEASE - 1e-9) return true
  }
  return false
}

export function decide(input: DecideInput): Decision {
  const { settings, held } = input
  const dnAsked = settings?.dayNight.enabled === true
  const fmAsked = settings?.followMac.enabled === true
  const phase = dnAsked && settings ? phaseAt(input.now, settings.dayNight) : undefined
  const dayNight = dnAsked && phase !== undefined && phase !== 'no-location'
  const follow = fmAsked && input.builtin !== null
  const mode: BrightnessMode = dayNight && follow ? 'both' : dayNight ? 'day-night' : follow ? 'follow-mac' : 'manual'
  const problems = {
    ...(dnAsked && phase === 'no-location' ? { dayNightProblem: 'no-location' as const } : {}),
    ...(fmAsked && input.builtin === null ? { followProblem: 'no-builtin' as const } : {}),
  }
  const shownPhase = phase && phase !== 'no-location' ? { state: phase.state, ...(phase.next ? { next: phase.next } : {}) } : undefined

  if (mode === 'manual') {
    return { target: held?.value ?? null, mode, overridden: false, releaseHeld: false, ...problems }
  }

  let auto: number
  const p = phase as Phase | undefined
  if (mode === 'day-night') auto = clamp(lerp(settings!.dayNight.day, settings!.dayNight.night, p!.night))
  else {
    const followed = followLevel(input.builtin!, settings!.followMac)
    auto = mode === 'both' ? Math.min(followed, clamp(lerp(100, settings!.dayNight.night, p!.night))) : followed
  }

  const counts = held !== null && held.mode !== 'manual'
  const expired = counts && heldExpired(held, input, dayNight, follow)
  if (counts && !expired) {
    return { target: held.value, mode, overridden: true, releaseHeld: false, ...problems, ...(shownPhase ? { phase: shownPhase } : {}) }
  }
  return { target: auto, mode, overridden: false, releaseHeld: held !== null, ...problems, ...(shownPhase ? { phase: shownPhase } : {}) }
}
