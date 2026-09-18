import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cancelsHold, DOUBLE_TAP_MS, DOUBLE_TAP_SLOP, HOLD_SLOP, isDoubleTap, startsHold } from '../src/dashboard/longPress'
import { ADMIN_GESTURES, DEFAULT_ADMIN_GESTURE } from '../src/shared/types'

const navbar = readFileSync(fileURLToPath(new URL('../src/dashboard/NavBar.vue', import.meta.url)), 'utf8')

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

describe('the navigation bar wires every gesture the driver can deliver', () => {
  it('treats a right button on the dots as the long press', () => {
    // The one that works inside the helper's web view: with the native menu emptied and text
    // interaction off, WebKit never runs the contextmenu pipeline, but a right mouse down is a
    // plain mouse event and always arrives.
    expect(navbar).toMatch(/if \(e\.button === 2\) \{ holdRightButton\(e\); return \}/)
    expect(navbar).toMatch(/function holdRightButton[\s\S]*openAdmin\(\)/)
  })
  it('keeps contextmenu, which is the signal in a browser', () => {
    expect(navbar).toMatch(/@contextmenu="holdContextMenu"/)
    expect(navbar).toMatch(/function holdContextMenu[\s\S]*openAdmin\(\)/)
    expect(navbar).toMatch(/function holdContextMenu[\s\S]*preventDefault\(\)/)
    expect(navbar).toMatch(/function holdContextMenu[\s\S]*stopPropagation\(\)/)
  })
  it('accepts the double tap, which arrives as an ordinary double click', () => {
    expect(navbar).toMatch(/@dblclick="adminDoubleClick"/)
    expect(navbar).toMatch(/function adminDoubleClick[\s\S]*openAdmin\(\)/)
  })
  it('keeps the timer path for a real mouse and the Chrome kiosk', () => {
    expect(navbar).toMatch(/@pointerdown="holdDown"/)
    expect(navbar).toMatch(/setTimeout[\s\S]*emit\('admin'\)/)
  })
  it('does not start a hold on a non-primary button', () => {
    expect(navbar).toMatch(/function holdDown[\s\S]*startsHold\(e\.button\)/)
  })
  it('honours the setting on every path', () => {
    for (const fn of ['holdRightButton', 'holdContextMenu', 'adminDoubleClick']) {
      expect(navbar, fn).toMatch(new RegExp(`function ${fn}[\\s\\S]*wantsGesture\\(`))
    }
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

describe('the navigation bar counts the double tap itself', () => {
  it('does not rely on the browser raising dblclick', () => {
    // The driver restores the cursor 0.25 s after a tap while its own double-tap window is
    // 0.3 s, so the pointer warps away and back between the two and WebKit's click counting
    // resets. dblclick never arrives on the panel.
    expect(navbar).toMatch(/function isSecondTap[\s\S]*isDoubleTap\(lastTap, tap\)/)
    expect(navbar).toMatch(/function holdDown[\s\S]*wantsGesture\('doubleTap'\) && isSecondTap\(e\)/)
  })
  it('checks it before the long-press timer, and whatever the long-press setting says', () => {
    const holdDown = navbar.slice(navbar.indexOf('function holdDown'))
    const second = holdDown.indexOf('isSecondTap(e)')
    const longPress = holdDown.indexOf("wantsGesture('longPress')")
    expect(second).toBeGreaterThan(-1)
    expect(second).toBeLessThan(longPress)
  })
  it('keeps the dblclick handler for browsers that do raise it', () => {
    expect(navbar).toMatch(/@dblclick="adminDoubleClick"/)
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
