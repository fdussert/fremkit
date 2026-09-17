import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * `widgets/weather/wmo.js` and `widgets/pomodoro/phases.js` are the pure halves of two widgets,
 * pulled out of their `index.html` so they can be exercised here. They are plain browser scripts
 * with no module system, so they are evaluated against a scope object standing in for `globalThis`
 * rather than imported — which also proves they leave exactly one global behind.
 */
async function load<T>(rel: string, global: string): Promise<T> {
  const src = await readFile(fileURLToPath(new URL(`../../widgets/${rel}`, import.meta.url)), 'utf8')
  const scope: Record<string, unknown> = {}
  new Function('globalThis', src)(scope)
  return scope[global] as T
}

interface Wmo {
  describe(code: unknown): { key: string; label: { fr: string; en: string } }
  svg(key: string, size: number): string
  upcomingHours(
    hourly: unknown,
    nowIso: string,
    count: number,
  ): { time: string; temperature: number | null; code: number | null; precipitation: number | null }[]
}

interface Pomodoro {
  phaseAt(index: number, cycles: number): string
  durationMs(phase: string, settings: Record<string, unknown>): number
  completedInSet(index: number, cycles: number): number
  mmss(ms: number): string
}

const wmo = await load<Wmo>('weather/wmo.js', 'FremkitWmo')
const pom = await load<Pomodoro>('pomodoro/phases.js', 'FremkitPomodoro')

describe('weather/wmo.js', () => {
  it('maps the documented WMO codes to a glyph and both languages', () => {
    expect(wmo.describe(0)).toEqual({ key: 'sun', label: { fr: 'Ciel dégagé', en: 'Clear sky' } })
    expect(wmo.describe(3).key).toBe('cloud')
    expect(wmo.describe(45).key).toBe('fog')
    expect(wmo.describe(65).key).toBe('rain')
    expect(wmo.describe(75).key).toBe('snow')
    expect(wmo.describe(95).key).toBe('thunder')
  })
  it('falls back to a cloud for a code the API never documented', () => {
    expect(wmo.describe(1234).key).toBe('cloud')
    expect(wmo.describe(null).label.en).toBe('Unknown weather')
  })
  it('draws a sized SVG for a known key and for an unknown one', () => {
    expect(wmo.svg('sun', 32)).toContain('width="32"')
    expect(wmo.svg('nope', 16)).toContain('<svg')
  })
  it('keeps only the hours after the reading it was given', () => {
    const hourly = {
      time: ['2026-09-17T18:00', '2026-09-17T19:00', '2026-09-17T20:00', '2026-09-17T21:00'],
      temperature_2m: [20, 19, 18, 17],
      weather_code: [0, 1, 2, 3],
      precipitation_probability: [0, 10, 20, 30],
    }
    const out = wmo.upcomingHours(hourly, '2026-09-17T19:15', 2)
    expect(out.map((h) => h.time)).toEqual(['2026-09-17T20:00', '2026-09-17T21:00'])
    expect(out[0]).toMatchObject({ temperature: 18, code: 2, precipitation: 20 })
  })
  it('tolerates a response with no hourly block', () => {
    expect(wmo.upcomingHours(undefined, '2026-09-17T19:15', 3)).toEqual([])
  })
})

describe('pomodoro/phases.js', () => {
  it('alternates work and breaks, with a long one every fourth cycle', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => pom.phaseAt(i, 4))
    expect(seq).toEqual(['work', 'short', 'work', 'short', 'work', 'short', 'work', 'long', 'work'])
  })
  it('honours another cycle count', () => {
    expect(pom.phaseAt(1, 2)).toBe('short')
    expect(pom.phaseAt(3, 2)).toBe('long')
  })
  it('reads durations from the settings and falls back on nonsense', () => {
    const s = { work: 25, shortBreak: 5, longBreak: 15 }
    expect(pom.durationMs('work', s)).toBe(25 * 60_000)
    expect(pom.durationMs('long', s)).toBe(15 * 60_000)
    expect(pom.durationMs('work', { work: 0 })).toBe(25 * 60_000)
    expect(pom.durationMs('short', {})).toBe(5 * 60_000)
  })
  it('fills one dot per finished work phase and empties the set after the long break', () => {
    const dots = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => pom.completedInSet(i, 4))
    expect(dots).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 0])
  })
  it('formats the remaining time, never below zero', () => {
    expect(pom.mmss(25 * 60_000)).toBe('25:00')
    expect(pom.mmss(61_000)).toBe('1:01')
    expect(pom.mmss(500)).toBe('0:01')
    expect(pom.mmss(-5000)).toBe('0:00')
  })
})
