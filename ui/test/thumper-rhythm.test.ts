import { describe, expect, it } from 'vitest'
import { createRhythm, isTap, steady, type Press, type ThumpResult } from '../src/dashboard/thumper/rhythm'

/** A clean tap at `at` ms. */
function tap(at: number, over: Partial<Press> = {}): Press {
  return { down: at, up: at + 80, moved: 2, button: 0, ...over }
}

/** Feeds taps at the given times and returns what the last one did. */
function play(times: number[], rhythm = createRhythm()): ThumpResult[] {
  return times.map((t) => rhythm.press(tap(t)))
}

describe('isTap', () => {
  it('accepts a short, still press of the primary button', () => {
    expect(isTap(tap(0))).toBe(true)
  })
  it('refuses a swipe, a long press and the other buttons', () => {
    expect(isTap(tap(0, { moved: 60 }))).toBe(false)
    expect(isTap(tap(0, { moved: 11 }))).toBe(false)
    expect(isTap(tap(0, { up: 900 }))).toBe(false)
    expect(isTap(tap(0, { button: 2 }))).toBe(false)
  })
})

describe('steady', () => {
  it('wants every gap in bounds and close to the mean', () => {
    expect(steady([500, 500, 500])).toBe(true)
    expect(steady([450, 520, 480])).toBe(true)
    expect(steady([360, 690])).toBe(false)
    expect(steady([300, 300, 300])).toBe(false)
    expect(steady([800, 800, 800])).toBe(false)
  })
})

describe('the rhythm', () => {
  it('calls on the fourth steady tap', () => {
    expect(play([0, 500, 1000, 1500]).map((r) => r.kind)).toEqual(['thump', 'thump', 'thump', 'call'])
  })
  it('counts the taps as they come', () => {
    expect(play([0, 500, 1000])).toEqual([{ kind: 'thump', count: 1 }, { kind: 'thump', count: 2 }, { kind: 'thump', count: 3 }])
  })
  it('accepts the slow and the fast ends of the range', () => {
    expect(play([0, 360, 720, 1080]).at(-1)?.kind).toBe('call')
    expect(play([0, 690, 1380, 2070]).at(-1)?.kind).toBe('call')
  })
  it('accepts a human wobble', () => {
    expect(play([0, 480, 1010, 1490]).at(-1)?.kind).toBe('call')
  })
  it('refuses taps too fast: that is a double tap, not a thumper', () => {
    expect(play([0, 250, 500, 750, 1000, 1250]).some((r) => r.kind === 'call')).toBe(false)
  })
  it('refuses taps too slow', () => {
    expect(play([0, 900, 1800, 2700, 3600]).some((r) => r.kind === 'call')).toBe(false)
  })
  it('refuses an irregular rhythm', () => {
    expect(play([0, 380, 1050, 1430]).some((r) => r.kind === 'call')).toBe(false)
    expect(play([0, 400, 1050, 1450, 2100]).some((r) => r.kind === 'call')).toBe(false)
  })
  it('refuses taps split across a long pause, but lets a new rhythm start after it', () => {
    const r = createRhythm()
    expect(play([0, 500, 1000, 4000], r).map((x) => x.kind)).toEqual(['thump', 'thump', 'thump', 'thump'])
    expect(r.press(tap(4000 + 500))).toEqual({ kind: 'thump', count: 2 })
    expect(play([5000, 5500], r).at(-1)?.kind).toBe('call')
  })
  it('starts over on a swipe in the middle', () => {
    const r = createRhythm()
    play([0, 500], r)
    expect(r.press(tap(1000, { moved: 80 }))).toEqual({ kind: 'reset' })
    expect(r.press(tap(1500))).toEqual({ kind: 'thump', count: 1 })
  })
  it('starts over on a wheel swipe in the middle', () => {
    const r = createRhythm()
    play([0, 500, 1000], r)
    r.reset()
    expect(r.press(tap(1500))).toEqual({ kind: 'thump', count: 1 })
  })
  it('counts from zero again after a call', () => {
    const r = createRhythm()
    play([0, 500, 1000, 1500], r)
    expect(r.press(tap(2000))).toEqual({ kind: 'thump', count: 1 })
  })
})
