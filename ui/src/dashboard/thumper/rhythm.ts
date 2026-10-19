/**
 * The thumper's rhythm: four steady taps on one of the stage's edge strips.
 *
 * A tap is a press and release that barely moved and did not linger. Four of them, each gap
 * between `MIN_GAP_MS` and `MAX_GAP_MS` and every gap within `TOLERANCE` of their mean, make a
 * call. Anything else — a swipe, a double tap, a long press, a pause, a gap out of step —
 * starts the count again, from that tap when it can still be the first of a new rhythm.
 *
 * The bounds keep clear of the bar's own gestures: a double tap is under 300 ms, a long press
 * arrives as the right button or a held one, and a swipe moves far more than `TAP_SLOP`.
 *
 * DOM-free on purpose, so the rule can be exercised without a browser.
 */
import { HOLD_SLOP } from '../longPress'

export const THUMPS = 4
export const MIN_GAP_MS = 350
export const MAX_GAP_MS = 700
/** How far a gap may stray from the mean of the gaps, as a fraction of it. */
export const TOLERANCE = 0.25
/** Movement past this many pixels is a swipe, not a tap: the same slop a long press tolerates. */
export const TAP_SLOP = HOLD_SLOP
/** A press held longer than this is not a thump. */
export const MAX_PRESS_MS = 400

export interface Press {
  /** When the press went down and came up, in milliseconds on any one clock. */
  down: number
  up: number
  /** How far the pointer travelled between the two, in pixels. */
  moved: number
  /** The pointer button; only the primary one thumps. */
  button: number
}

/** Whether a press is a tap at all. */
export function isTap(p: Press): boolean {
  return p.button === 0 && p.moved <= TAP_SLOP && p.up - p.down >= 0 && p.up - p.down <= MAX_PRESS_MS
}

/** Whether a series of gaps is steady: each in bounds and close to their mean. */
export function steady(gaps: number[]): boolean {
  if (gaps.some((g) => g < MIN_GAP_MS || g > MAX_GAP_MS)) return false
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return gaps.every((g) => Math.abs(g - mean) <= TOLERANCE * mean)
}

export type ThumpResult =
  /** Not a tap: the count is back to zero. */
  | { kind: 'reset' }
  /** A tap that is the `count`-th of a rhythm still being built. */
  | { kind: 'thump'; count: number }
  /** The fourth steady tap. The count is back to zero. */
  | { kind: 'call' }

export interface Rhythm {
  press(p: Press): ThumpResult
  /** Something that is not a tap happened on the strip (a wheel swipe): start again. */
  reset(): void
}

export function createRhythm(): Rhythm {
  // The times of the taps of the rhythm being built, oldest first.
  let taps: number[] = []

  function press(p: Press): ThumpResult {
    if (!isTap(p)) { taps = []; return { kind: 'reset' } }
    const at = p.down
    const next = [...taps, at]
    // Drop the oldest taps until what is left is still a steady rhythm: a tap out of step can
    // be the first of a new one, and a late tap after a pause always is.
    while (next.length > 1 && !steady(gapsOf(next))) next.shift()
    taps = next
    if (taps.length >= THUMPS) { taps = []; return { kind: 'call' } }
    return { kind: 'thump', count: taps.length }
  }

  return { press, reset: () => { taps = [] } }
}

function gapsOf(times: number[]): number[] {
  const gaps: number[] = []
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1])
  return gaps
}
