/**
 * Where everything is, as a function of time: the worm's path, its body along it, the sand line,
 * and the phases of the scene. Pure, so the choreography can be checked without a canvas.
 *
 * Coordinates are CSS pixels of the viewport, in the scene's own frame: the worm always travels
 * towards +x here, and the renderer mirrors the picture when the thumper was on the right.
 */

/** The phases, in seconds from the call. */
export const T = {
  /** The ground starts to tremble at once; the sand climbs over the bottom of the screen. */
  sandRise: [0.15, 1.2] as const,
  /** When the path's clock starts: the head is still deep under the sand, coming up. */
  pathStart: 0.45,
  /** When the tiles start to spring back, and the sand to drain away. */
  settle: 5.0,
  sandFall: [5.1, 5.9] as const,
  /** Everything is back where it was. */
  end: 6.3,
}

/** Control points of the head's path, as fractions of the viewport (x of the width, y of the height). */
const KEYS: Array<[number, number]> = [
  [0.055, 1.6], [0.075, 1.08], [0.1, 0.55], [0.15, 0.3], [0.22, 0.3], [0.29, 0.55],
  [0.36, 1.0], [0.45, 1.2], [0.53, 0.85], [0.61, 0.38], [0.7, 0.33], [0.8, 0.52],
  [0.89, 0.98], [0.96, 1.4], [1.03, 1.9], [1.1, 2.4],
  // Deep under the far side, so the whole length of the body can follow the head down.
  [1.17, 2.9], [1.24, 3.4], [1.31, 3.9], [1.38, 4.4],
]
/** The key the head's pace is set against: the path up to it takes `travel` seconds. */
const PACE_KEY = 15

export interface Point { x: number; y: number }

export interface Path {
  /**
   * Point at arc length `s` from the start, clamped to the ends. Written into `out` when given,
   * so a loop over the body allocates nothing.
   */
  at(s: number, out?: Point): Point
  /** Total arc length. */
  length: number
  /** Head arc length at path time `tau` (seconds since `T.pathStart`). */
  headAt(tau: number): number
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u, u3 = u2 * u
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
}

/** The path for a viewport of `w` × `h`; `calm` keeps the worm low and far away. */
export function buildPath(w: number, h: number, calm = false): Path {
  const keys = calm ? KEYS.map(([x, y]) => [x, 1 + (y - 1) * 0.16] as [number, number]) : KEYS
  const pts = keys.map(([x, y]) => ({ x: x * w, y: y * h }))
  // Dense polyline along a Catmull-Rom spline, with the cumulative arc length at each vertex.
  const xs: number[] = [], ys: number[] = [], cum: number[] = []
  const STEPS = 48
  let paceLength = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)]
    for (let k = i === 0 ? 0 : 1; k <= STEPS; k++) {
      const u = k / STEPS
      const x = catmull(p0.x, p1.x, p2.x, p3.x, u), y = catmull(p0.y, p1.y, p2.y, p3.y, u)
      const n = xs.length
      cum.push(n === 0 ? 0 : cum[n - 1] + Math.hypot(x - xs[n - 1], y - ys[n - 1]))
      xs.push(x); ys.push(y)
    }
    if (i + 1 === PACE_KEY) paceLength = cum[cum.length - 1]
  }
  const length = cum[cum.length - 1]

  function at(s: number, out: Point = { x: 0, y: 0 }): Point {
    if (s <= 0) { out.x = xs[0]; out.y = ys[0]; return out }
    if (s >= length) { out.x = xs[xs.length - 1]; out.y = ys[ys.length - 1]; return out }
    // Binary search for the segment holding s.
    let lo = 0, hi = cum.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid }
    const f = (s - cum[lo]) / (cum[hi] - cum[lo] || 1)
    out.x = xs[lo] + (xs[hi] - xs[lo]) * f; out.y = ys[lo] + (ys[hi] - ys[lo]) * f
    return out
  }

  // The head's progress: it climbs slowly out of the sand and gains speed going down, the way a
  // heavy thing would. Integrated once, then scaled so the head dives at the far side on time.
  const DT = 1 / 240
  const table: number[] = [0]
  let s = 0
  while (s < length) {
    const a = at(s), b = at(s + 4)
    const slope = (b.y - a.y) / (Math.hypot(b.x - a.x, b.y - a.y) || 1) // +1 straight down
    const v = 1 + 0.45 * slope
    s += v * DT * 1000
    table.push(Math.min(s, length))
  }
  // The table's clock runs in arbitrary units; map its index to a duration of `travel` seconds.
  const travel = calm ? 4.2 : 3.7
  // Paced on the stretch up to PACE_KEY, so the deep run-out beyond it does not hurry the head.
  let paceIndex = table.findIndex((v) => v >= paceLength)
  if (paceIndex < 0) paceIndex = table.length - 1
  const scale = paceIndex / travel
  function headAt(tau: number): number {
    if (tau <= 0) return 0
    const i = tau * scale
    const i0 = Math.min(table.length - 1, Math.floor(i)), i1 = Math.min(table.length - 1, i0 + 1)
    return table[i0] + (table[i1] - table[i0]) * (i - i0)
  }

  return { at, length, headAt }
}

/** Smoothstep. */
export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** The sand line's base height (its y), `h` the viewport height, `t` seconds since the call. */
export function sandLine(t: number, h: number, calm = false): number {
  const depth = calm ? 0.07 : 0.2
  const up = smooth(T.sandRise[0], T.sandRise[1], t) * (1 - smooth(T.sandFall[0], T.sandFall[1], t))
  return h + 12 - up * (depth * h + 12)
}

/** How hard the ground shakes, 0..1: a rumble that grows until the worm breaks out, then fades. */
export function rumble(t: number): number {
  return smooth(0, 1.35, t) * (1 - smooth(1.6, 4.6, t) * 0.55) * (1 - smooth(T.settle - 0.3, T.settle + 0.4, t))
}

/**
 * How far the head rears above the sand, 0..1, from its height `hy` over the sand line `base`
 * on a screen `h` tall. The higher it rears, the more it turns its maw on the viewer and opens it.
 */
export function rearing(hy: number, base: number, h: number): number {
  return smooth(base - 0.12 * h, base - 0.6 * h, hy)
}

/** How far the maw faces the viewer, 0 (side on) to 1 (straight at us). */
export function facing(rear: number): number {
  return 0.2 + 0.8 * rear
}

/** How open the maw is, 0..1. */
export function mawOpen(rear: number): number {
  return 0.08 + 0.92 * smooth(0.15, 0.85, rear)
}

/**
 * The body radius at `s` pixels behind the head, for a worm of length `len` and head radius `r`.
 *
 * Full girth along the whole body, then a short bullet tip about one radius long: it leaves the
 * body with no slope, so there is no kink where it begins, stays full most of the way, and closes
 * on a small rounded cap, so whatever part of the tail clears the sand ends finished, never on a
 * flat cut or a sharp point.
 */
export function radiusAt(s: number, len: number, r: number): number {
  const neck = 1 + 0.06 * Math.exp(-((s - r * 1.2) ** 2) / (r * r * 0.5))
  const tip = TIP * r
  if (s <= len - tip) return r * neck
  const u = Math.min(1, (s - (len - tip)) / tip)
  return r * Math.pow(Math.max(0, 1 - Math.pow(u, 1.8)), 0.6)
}

/** The tail's tip, in body radii. */
export const TIP = 1.1

/**
 * The smallest armour plate, as a fraction of the body's girth: through the rounded tips the
 * plates keep this size instead of crowding into a hatch.
 */
export const PLATE_FLOOR = 0.6

/**
 * Where the `i`-th of `n` spine samples sits along a body of length `len`: a little closer
 * together towards the tail, so its rounded tip gets enough of them.
 */
export function sampleAt(i: number, n: number, len: number): number {
  const u = i / (n - 1)
  const k = 0.45
  return len * (u * (1 - k) + k * (1 - (1 - u) * (1 - u)))
}

export interface Dimensions {
  /** Head radius and body length, in pixels. */
  radius: number
  length: number
}

export function dimensions(w: number, h: number, calm = false): Dimensions {
  const radius = calm ? h * 0.035 : h * 0.155
  return { radius, length: calm ? w * 0.3 : Math.min(w * 0.75, h * 2.85) }
}
