import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cancelsHold, HOLD_SLOP, startsHold } from '../src/dashboard/longPress'
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
