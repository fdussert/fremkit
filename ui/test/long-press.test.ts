import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cancelsHold, HOLD_SLOP, startsHold } from '../src/dashboard/longPress'

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

describe('the navigation bar wires both long-press paths', () => {
  it('treats contextmenu on the dots as the long press', () => {
    // This is the one that works on the panel: the driver sends a right click, so the page gets
    // a contextmenu event and never a held button.
    expect(navbar).toMatch(/@contextmenu="holdContextMenu"/)
    expect(navbar).toMatch(/function holdContextMenu[\s\S]*emit\('admin'\)/)
  })
  it('stops that event reaching anything else', () => {
    expect(navbar).toMatch(/function holdContextMenu[\s\S]*preventDefault\(\)/)
    expect(navbar).toMatch(/function holdContextMenu[\s\S]*stopPropagation\(\)/)
  })
  it('keeps the timer path for a real mouse and the Chrome kiosk', () => {
    expect(navbar).toMatch(/@pointerdown="holdDown"/)
    expect(navbar).toMatch(/setTimeout[\s\S]*emit\('admin'\)/)
  })
  it('does not start a hold on a non-primary button', () => {
    expect(navbar).toMatch(/function holdDown[\s\S]*startsHold\(e\.button\)/)
  })
})
