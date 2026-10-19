/**
 * The tiles the worm knocks about: whatever frames the tapped screen shows, measured when the
 * call comes, moved only through a CSS transform on the frame around the iframe — never the
 * widget, never the config — and handed back exactly as they were.
 */
import { T } from './timeline'

/** The inline style properties the scene writes, and so the only ones it puts back. */
const TOUCHED = ['transform', 'will-change'] as const

interface Saved { value: string; priority: string }

export interface Crack {
  /** Polylines in the tile's own frame, origin at its centre. */
  lines: Array<Array<[number, number]>>
}

export interface Tile {
  el: HTMLElement
  /** Where it sat when the call came, in viewport pixels. */
  x: number; y: number; w: number; h: number
  /** Offset from that place, rotation in radians, and their speeds. */
  dx: number; dy: number; a: number
  vx: number; vy: number; va: number
  /** When the worm hit it, in scene seconds; null while it stands. */
  hitAt: number | null
  crack: Crack | null
  /** The pose it springs back from. */
  from: { dx: number; dy: number; a: number } | null
  /** Its own rhythm for the trembling, so the tiles do not shake in lockstep. */
  seed: number
  saved: Record<string, Saved>
  /** Whether the frame had a style attribute at all, so an emptied one can go too. */
  hadStyle: boolean
}

export function captureTiles(els: HTMLElement[]): Tile[] {
  return els.map((el, i) => {
    const r = el.getBoundingClientRect()
    const saved: Record<string, Saved> = {}
    for (const p of TOUCHED) saved[p] = { value: el.style.getPropertyValue(p), priority: el.style.getPropertyPriority(p) }
    return {
      el, x: r.left, y: r.top, w: r.width, h: r.height,
      dx: 0, dy: 0, a: 0, vx: 0, vy: 0, va: 0,
      hitAt: null, crack: null, from: null,
      seed: 1.7 + i * 2.39, saved, hadStyle: el.hasAttribute('style'),
    }
  })
}

/** Puts back exactly what the frame's inline style said before the scene. */
export function restoreTiles(tiles: Tile[]): void {
  for (const t of tiles) {
    for (const p of TOUCHED) {
      const s = t.saved[p]
      if (s.value) t.el.style.setProperty(p, s.value, s.priority)
      else t.el.style.removeProperty(p)
    }
    // An attribute only the scene wrote goes as well, so the markup is what it was.
    if (!t.hadStyle && t.el.getAttribute('style') === '') t.el.removeAttribute('style')
  }
}

/** Distance from a point to a tile's resting rectangle. */
export function distanceToTile(t: Tile, px: number, py: number): { d: number; x: number; y: number } {
  const x = Math.max(t.x, Math.min(px, t.x + t.w)), y = Math.max(t.y, Math.min(py, t.y + t.h))
  return { d: Math.hypot(px - x, py - y), x, y }
}

/** A deterministic pseudo-random sequence, so a capture can be repeated frame for frame. */
export function prng(seed: number): () => number {
  let s = Math.floor(seed * 0x7fffffff) >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

/** The crack a blow at (ix, iy), in the tile's own frame, leaves in a `w` × `h` tile. */
export function crackFor(w: number, h: number, ix: number, iy: number, rand: () => number): Crack {
  const lines: Crack['lines'] = []
  const hw = w / 2 - 6, hh = h / 2 - 6
  const inside = (x: number, y: number) => Math.abs(x) <= hw && Math.abs(y) <= hh
  const clampIn = (x: number, y: number): [number, number] => [Math.max(-hw, Math.min(hw, x)), Math.max(-hh, Math.min(hh, y))]
  const [ox, oy] = clampIn(ix, iy)
  const reach = Math.max(w, h) * 0.9
  const branches = 6 + Math.floor(rand() * 4)
  for (let b = 0; b < branches; b++) {
    let ang = (b / branches) * Math.PI * 2 + rand() * 0.6
    let x = ox, y = oy
    const line: Array<[number, number]> = [[x, y]]
    const len = reach * (0.35 + rand() * 0.65)
    let walked = 0
    while (walked < len) {
      const step = 10 + rand() * 22
      ang += (rand() - 0.5) * 0.7
      x += Math.cos(ang) * step; y += Math.sin(ang) * step; walked += step
      if (!inside(x, y)) { line.push(clampIn(x, y)); break }
      line.push([x, y])
      // A side crack now and then.
      if (rand() < 0.18) {
        const side: Array<[number, number]> = [[x, y]]
        let sa = ang + (rand() < 0.5 ? 1 : -1) * (0.5 + rand() * 0.6), sx = x, sy = y
        for (let k = 0; k < 3; k++) {
          sa += (rand() - 0.5) * 0.6
          sx += Math.cos(sa) * (8 + rand() * 14); sy += Math.sin(sa) * (8 + rand() * 14)
          if (!inside(sx, sy)) break
          side.push([sx, sy])
        }
        if (side.length > 1) lines.push(side)
      }
    }
    lines.push(line)
  }
  // A ring of short chords around the impact, where the surface caved.
  const ring = 18 + rand() * 18
  const ringLine: Array<[number, number]> = []
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * Math.PI * 2
    const rr = ring * (0.8 + rand() * 0.4)
    const p = clampIn(ox + Math.cos(a) * rr, oy + Math.sin(a) * rr)
    ringLine.push(p)
  }
  lines.push(ringLine)
  return { lines }
}

const GRAVITY = 1700

/** Knocks a tile hit at viewport point (ix, iy) by a body moving along (ux, uy). */
export function knock(t: Tile, now: number, ix: number, iy: number, ux: number, uy: number, speed: number, rand: () => number): void {
  if (t.hitAt !== null) return
  t.hitAt = now
  const cx = t.x + t.w / 2, cy = t.y + t.h / 2
  // Shoved along the worm's travel and away from its body, and thrown up a little.
  const push = Math.min(700, 240 + speed * 0.25)
  let fx = ux * push, fy = uy * push * 0.5 - (160 + rand() * 220)
  // Heavier tiles fly less.
  const mass = Math.sqrt((t.w * t.h) / 40000) + 0.6
  fx /= mass; fy /= mass
  t.vx = fx; t.vy = fy
  const rx = ix - cx, ry = iy - cy
  const torque = rx * fy - ry * fx
  const inertia = (t.w * t.w + t.h * t.h) / 12
  t.va = Math.max(-5, Math.min(5, (torque / inertia) * 0.35 + (rand() - 0.5) * 1.2))
  t.crack = crackFor(t.w, t.h, rx, ry, rand)
}

/** A damped spring from 1 to 0 over `u` seconds, with a small overshoot. */
export function springBack(u: number): number {
  if (u <= 0) return 1
  const zeta = 0.5, omega = 13
  const wd = omega * Math.sqrt(1 - zeta * zeta)
  const v = Math.exp(-zeta * omega * u) * (Math.cos(wd * u) + ((zeta * omega) / wd) * Math.sin(wd * u))
  return u > 1.1 ? 0 : v
}

/**
 * Moves every tile to time `now` (scene seconds, `dt` since the last step) and writes its pose.
 * `shake` is 0..1 per tile; the calm version passes 0 and never knocks anything.
 */
export function stepTiles(tiles: Tile[], now: number, dt: number, shake: (t: Tile) => number, viewportH: number): void {
  tiles.forEach((t, i) => {
    if (now >= T.settle + i * 0.035) {
      if (!t.from) t.from = { dx: t.dx, dy: t.dy, a: t.a }
      const k = springBack(now - T.settle - i * 0.035)
      t.dx = t.from.dx * k; t.dy = t.from.dy * k; t.a = t.from.a * k
    } else if (t.hitAt !== null) {
      t.vy += GRAVITY * dt
      t.vx *= 1 - 0.6 * dt
      t.dx += t.vx * dt; t.dy += t.vy * dt; t.a += t.va * dt
      // Off the bottom, it stops falling: it only has to come back from there.
      if (t.y + t.dy > viewportH + 200) { t.dy = viewportH + 200 - t.y; t.vy = 0; t.vx = 0; t.va = 0 }
    }
    let jx = 0, jy = 0, ja = 0
    const s = t.hitAt === null ? shake(t) : 0
    if (s > 0) {
      const q = now * 38 + t.seed * 10
      jx = s * 7 * (Math.sin(q) * 0.6 + Math.sin(q * 2.31 + t.seed) * 0.4)
      jy = s * 5 * (Math.sin(q * 1.73 + 1.1) * 0.6 + Math.sin(q * 3.07) * 0.4)
      ja = s * 0.012 * Math.sin(q * 1.21 + t.seed * 3)
    }
    const x = t.dx + jx, y = t.dy + jy, a = t.a + ja
    t.el.style.setProperty('will-change', 'transform')
    t.el.style.setProperty('transform', `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${a.toFixed(4)}rad)`)
  })
}
