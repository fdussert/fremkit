import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/**
 * `widgets/disk-map/sunburst.js`, the pure half of the disk map widget, evaluated against a scope
 * object standing in for `globalThis` (see widget-logic.test.ts for the same pattern).
 */
interface Arc { ring: number; a0: number; a1: number; kind: string; name: string; size: number; path: string[] | null; top: number; count: number }
interface Sunburst {
  layout(view: unknown, opts: { rings?: number; minDegrees?: number; lockDegrees?: number }): { arcs: Arc[] }
  arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string
  parseColor(v: string): [number, number, number] | null
  colorFor(base: string, top: number, ring: number, count: number): string
  formatBytes(bytes: number, locale: string): string
  ago(then: number, now: number, locale: string): string
}

const src = await readFile(fileURLToPath(new URL('../../widgets/disk-map/sunburst.js', import.meta.url)), 'utf8')
const scope: Record<string, unknown> = {}
new Function('globalThis', src)(scope)
const S = scope.FremkitSunburst as Sunburst

const view = {
  name: '~', kind: 'd', size: 1000,
  children: [
    { name: 'Library', kind: 'd', size: 500, children: [{ name: 'Caches', kind: 'd', size: 400 }, { name: 'x', kind: 'f', size: 5 }] },
    { name: 'Movies', kind: 'd', size: 300 },
    { name: 'a', kind: 'f', size: 4 },
    { name: 'b', kind: 'f', size: 3 },
    { name: '', kind: 'o', size: 100, count: 12 },
    { name: 'Mail', kind: 'x', size: 0, unreadable: 1 },
  ],
}

describe('sunburst layout', () => {
  const { arcs } = S.layout(view, { rings: 2, minDegrees: 3.5, lockDegrees: 4 })
  const ring1 = arcs.filter((a) => a.ring === 1)

  it('splits the first ring by size and merges what is narrower than a finger', () => {
    expect(ring1.map((a) => [a.kind, a.name])).toEqual([['d', 'Library'], ['d', 'Movies'], ['o', ''], ['x', 'Mail']])
    const others = ring1.find((a) => a.kind === 'o')!
    expect(others.count).toBe(14)
    expect(others.size).toBe(107)
    const lib = ring1[0]
    // 360° less the locked sliver, in proportion to 500 / 1000.
    expect(lib.a1 - lib.a0).toBeCloseTo((360 - 4) * 0.5, 5)
  })
  it('gives an unreadable folder a fixed sliver at the end of the circle', () => {
    const mail = ring1.find((a) => a.kind === 'x')!
    expect(mail.a1).toBeCloseTo(360, 5)
    expect(mail.a1 - mail.a0).toBeCloseTo(4, 5)
  })
  it('nests the second ring inside its parent, with the parent’s hue', () => {
    const caches = arcs.find((a) => a.name === 'Caches')!
    expect(caches.ring).toBe(2)
    expect(caches.path).toEqual(['Library', 'Caches'])
    expect(caches.top).toBe(0)
    expect(caches.a0).toBeCloseTo(0, 5)
    expect(caches.a1).toBeCloseTo((360 - 4) * 0.4, 5)
    // 5 bytes of 1000 is under 3.5°: merged into that ring's "others".
    expect(arcs.some((a) => a.ring === 2 && a.name === 'x')).toBe(false)
  })
  it('draws nothing past the rings asked for', () => {
    expect(S.layout(view, { rings: 1 }).arcs.every((a) => a.ring === 1)).toBe(true)
  })
  it('copes with an empty or zero-sized view', () => {
    expect(S.layout({ name: 'e', kind: 'd', size: 0 }, {}).arcs).toEqual([])
    expect(S.layout(null, {}).arcs).toEqual([])
  })
})

describe('sunburst geometry, colour and text', () => {
  it('draws a segment and a whole ring', () => {
    expect(S.arcPath(100, 100, 30, 50, 0, 90)).toMatch(/^M100 50A50 50 0 0 1 150 100L130 100A30 30 0 0 0 100 70Z$/)
    expect(S.arcPath(100, 100, 30, 50, 0, 360)).toContain('A50 50 0 1 1 100 150')
  })
  it('steps the hue per first-ring folder and lightens outwards', () => {
    expect(S.parseColor('#d9b36a')?.[0]).toBeCloseTo(39, 0)
    expect(S.parseColor('rgb(255, 0, 0)')).toEqual([0, 1, 0.5])
    expect(S.parseColor('nonsense')).toBeNull()
    expect(S.colorFor('#ff0000', 0, 1, 4)).not.toBe(S.colorFor('#ff0000', 1, 1, 4))
    const l = (c: string) => Number(/ (\d+)%\)$/.exec(c)![1])
    expect(l(S.colorFor('#ff0000', 0, 2, 4))).toBeGreaterThan(l(S.colorFor('#ff0000', 0, 1, 4)))
  })
  it('formats sizes in decimal units, in both languages', () => {
    expect(S.formatBytes(0, 'en')).toBe('0 B')
    expect(S.formatBytes(1_500_000_000, 'en')).toBe('1.5 GB')
    expect(S.formatBytes(1_500_000_000, 'fr')).toBe('1,5 Go')
    expect(S.formatBytes(380_000_000_000, 'en')).toBe('380 GB')
  })
  it('says how long ago', () => {
    const now = 10_000_000
    expect(S.ago(now - 10_000, now, 'en')).toBe('just now')
    expect(S.ago(now - 2 * 3600_000, now, 'fr')).toBe('il y a 2 h')
    expect(S.ago(now - 3 * 86400_000, now, 'en')).toBe('3 d ago')
  })
})
