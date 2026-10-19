/**
 * When it is day and when it is night, computed on this machine.
 *
 * Sunrise and sunset come from the sunrise equation (the one in the NOAA and Wikipedia
 * write-ups), good to a couple of minutes outside the polar circles, which is far finer than a
 * brightness ramp needs. No network and no geolocation: the coordinates are the ones the user
 * typed in the Screen settings.
 */

import type { BrightnessSettings } from '../config/schema.js'

type DayNight = BrightnessSettings['dayNight']

/**
 * What the schedule needs to know: where, or at what times. The brightness's `dayNight` settings
 * are one; the theme's day / night switch (`themeSchedule` in the config) is another, read with
 * no ramp.
 */
export type SunSchedule = Pick<DayNight, 'schedule' | 'latitude' | 'longitude' | 'dayAt' | 'nightAt'>

/** A switch from one level to the other: the ramp starts at `at`. */
export interface Transition { at: number; to: 'day' | 'night' }

const DAY_MS = 86_400_000
const J2000 = 2451545.0
const UNIX_EPOCH_JD = 2440587.5
const rad = (deg: number): number => (deg * Math.PI) / 180
const deg = (r: number): number => (r * 180) / Math.PI

const toJulian = (ms: number): number => ms / DAY_MS + UNIX_EPOCH_JD
const fromJulian = (jd: number): number => (jd - UNIX_EPOCH_JD) * DAY_MS

/**
 * Sunrise and sunset of Julian cycle `n` (days since J2000) at a place, in epoch ms, or the polar
 * case: `day` when the sun never sets that day, `night` when it never rises.
 */
export function sunEvents(n: number, latitude: number, longitude: number): { rise: number; set: number } | 'day' | 'night' {
  const jStar = n - longitude / 360
  const m = (357.5291 + 0.98560028 * jStar) % 360
  const c = 1.9148 * Math.sin(rad(m)) + 0.02 * Math.sin(rad(2 * m)) + 0.0003 * Math.sin(rad(3 * m))
  const lambda = (m + c + 180 + 102.9372) % 360
  const transit = J2000 + jStar + 0.0053 * Math.sin(rad(m)) - 0.0069 * Math.sin(rad(2 * lambda))
  const sinDecl = Math.sin(rad(lambda)) * Math.sin(rad(23.4397))
  const cosDecl = Math.cos(Math.asin(sinDecl))
  const cosOmega = (Math.sin(rad(-0.833)) - Math.sin(rad(latitude)) * sinDecl) / (Math.cos(rad(latitude)) * cosDecl)
  if (cosOmega > 1) return 'night'
  if (cosOmega < -1) return 'day'
  const omega = deg(Math.acos(cosOmega))
  return { rise: fromJulian(transit - omega / 360), set: fromJulian(transit + omega / 360) }
}

/** Minutes after local midnight of `HH:MM`. */
function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number)
  return h * 60 + m
}

/**
 * The transitions in a window of three days around `now`, sorted, or a constant phase when there
 * are none (polar day or night, or the same time typed twice).
 *
 * Fixed times are read in the Mac's own time zone, through `Date`'s local setters, so a daylight
 * saving change moves them with the clock on the wall.
 */
export function transitionsAround(now: number, settings: SunSchedule): Transition[] | 'day' | 'night' | 'no-location' {
  const out: Transition[] = []
  if (settings.schedule === 'fixed') {
    const dayAt = minutesOf(settings.dayAt)
    const nightAt = minutesOf(settings.nightAt)
    if (dayAt === nightAt) return 'day'
    for (let offset = -1; offset <= 1; offset++) {
      const base = new Date(now)
      base.setDate(base.getDate() + offset)
      for (const [minutes, to] of [[dayAt, 'day'], [nightAt, 'night']] as const) {
        const d = new Date(base)
        d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
        out.push({ at: d.getTime(), to })
      }
    }
  } else {
    if (settings.latitude === undefined || settings.longitude === undefined) return 'no-location'
    const n = Math.round(toJulian(now) - J2000)
    let polar: 'day' | 'night' | undefined
    for (let k = n - 1; k <= n + 1; k++) {
      const ev = sunEvents(k, settings.latitude, settings.longitude)
      if (typeof ev === 'string') { if (k === n) polar = ev; continue }
      out.push({ at: ev.rise, to: 'day' }, { at: ev.set, to: 'night' })
    }
    if (polar && !out.some((t) => Math.abs(t.at - now) < DAY_MS)) return polar
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Where the schedule stands at `now`. `night` is 0 in full day, 1 in full night, in between on a ramp. */
export interface Phase {
  night: number
  state: 'day' | 'night' | 'dimming' | 'brightening'
  /** Start of the next transition, or undefined when there is none in sight (polar). */
  next?: Transition
  /** Start of the transition that put the schedule where it is now, if any. */
  last?: Transition
}

export function phaseAt(now: number, settings: SunSchedule & Pick<DayNight, 'rampMinutes'>): Phase | 'no-location' {
  const events = transitionsAround(now, settings)
  if (events === 'no-location') return events
  if (typeof events === 'string') return { night: events === 'night' ? 1 : 0, state: events }
  let last: Transition | undefined
  let next: Transition | undefined
  for (const e of events) {
    if (e.at <= now) last = e
    else if (!next) next = e
  }
  if (!last) {
    // Before the first event of the window: the opposite of where it goes next.
    const state = next?.to === 'night' ? 'day' : 'night'
    return { night: state === 'night' ? 1 : 0, state, next }
  }
  const rampMs = settings.rampMinutes * 60_000
  const progress = rampMs === 0 ? 1 : Math.min(1, (now - last.at) / rampMs)
  const night = last.to === 'night' ? progress : 1 - progress
  const state = progress >= 1 ? last.to : last.to === 'night' ? 'dimming' : 'brightening'
  return { night, state, next, last }
}
