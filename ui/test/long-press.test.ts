/**
 * The rules the bar's gestures are made of, on their own: DOM-free, so they can be exercised
 * without a browser. What the bar *does* with them is asserted by mounting it, in
 * `nav-bar-admin.test.ts` — these used to read NavBar.vue and match regexes against its source,
 * which proved only that the file still said what it said.
 */
import { describe, expect, it } from 'vitest'
import { ADMIN_REPEAT_MS, cancelsHold, DOUBLE_TAP_MS, DOUBLE_TAP_SLOP, HOLD_SLOP, isDoubleTap, startsHold } from '../src/dashboard/longPress'
import { ADMIN_GESTURES, DEFAULT_ADMIN_GESTURE } from '../src/shared/types'

describe('startsHold', () => {
  it('starts on the primary button only', () => {
    expect(startsHold(0)).toBe(true)
  })
  it('ignores the right button, which is what the driver sends for a long press', () => {
    // The Edge's touch driver turns a held press into rightMouseDown + rightMouseUp. Starting a
    // hold on it would only have that hold cancelled by its own release a moment later — and
    // would clear the state the contextmenu handler is about to act on.
    expect(startsHold(2)).toBe(false)
    expect(startsHold(1)).toBe(false)
  })
})

describe('cancelsHold', () => {
  const origin = { x: 100, y: 100 }
  it('lets a finger wobble', () => {
    expect(cancelsHold(origin, { x: 100, y: 100 })).toBe(false)
    expect(cancelsHold(origin, { x: 106, y: 100 })).toBe(false)
  })
  it('cancels once the finger is really travelling', () => {
    expect(cancelsHold(origin, { x: 100 + HOLD_SLOP + 1, y: 100 })).toBe(true)
    expect(cancelsHold(origin, { x: 120, y: 130 })).toBe(true)
  })
})

describe('ADMIN_REPEAT_MS', () => {
  it('is longer than the gap between an event and its echo, shorter than two deliberate presses', () => {
    // A right click's `contextmenu` follows its button event immediately; a `dblclick` follows the
    // second tap it was counted from. Both are within a frame. A person pressing twice on purpose
    // is not.
    expect(ADMIN_REPEAT_MS).toBeGreaterThan(DOUBLE_TAP_MS)
    expect(ADMIN_REPEAT_MS).toBeLessThan(1500)
  })
})

describe('isDoubleTap', () => {
  const tap = (at: number, x = 100, y = 100) => ({ at, x, y })

  it('is never true for the first tap', () => {
    expect(isDoubleTap(null, tap(0))).toBe(false)
  })
  it('pairs two taps close in time and place', () => {
    expect(isDoubleTap(tap(0), tap(200))).toBe(true)
    expect(isDoubleTap(tap(1000), tap(1000 + DOUBLE_TAP_MS))).toBe(true)
  })
  it('lets a slow second tap be a tap of its own', () => {
    expect(isDoubleTap(tap(0), tap(DOUBLE_TAP_MS + 1))).toBe(false)
    expect(isDoubleTap(tap(0), tap(3000))).toBe(false)
  })
  it('lets two taps on different dots be two taps', () => {
    expect(isDoubleTap(tap(0, 100, 100), tap(200, 100 + DOUBLE_TAP_SLOP + 1, 100))).toBe(false)
    expect(isDoubleTap(tap(0, 100, 100), tap(200, 300, 100))).toBe(false)
  })
  it('forgives the wobble of a finger', () => {
    expect(isDoubleTap(tap(0, 100, 100), tap(150, 108, 104))).toBe(true)
  })
})

describe('which gestures a setting allows', () => {
  // Mirrors wantsGesture() in NavBar.vue, which is three lines of prop reading around this rule.
  const wants = (setting: string, kind: string) => setting === 'both' || setting === kind

  it('accepts both by default', () => {
    expect(wants(DEFAULT_ADMIN_GESTURE, 'longPress')).toBe(true)
    expect(wants(DEFAULT_ADMIN_GESTURE, 'doubleTap')).toBe(true)
  })
  it('narrows to one when asked', () => {
    expect(wants('longPress', 'longPress')).toBe(true)
    expect(wants('longPress', 'doubleTap')).toBe(false)
    expect(wants('doubleTap', 'doubleTap')).toBe(true)
    expect(wants('doubleTap', 'longPress')).toBe(false)
  })
  it('offers both-first in the admin, since that is the default', () => {
    expect(ADMIN_GESTURES[0]).toBe('both')
    expect([...ADMIN_GESTURES].sort()).toEqual(['both', 'doubleTap', 'longPress'])
  })
})
