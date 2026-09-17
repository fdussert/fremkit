import { describe, it, expect } from 'vitest'
import { POPOVER_MARGIN, popoverRect } from '../src/shared/popover'

/** A 2560×720 Edge panel with an 80 px bar: the widget area ends at 640. */
const SCREEN = { width: 2560, height: 720 }
const BAR_TOP = 640
const anchor = (left: number, width = 160) => ({ left, width, top: BAR_TOP })

describe('popoverRect', () => {
  it('centres the box on the anchor and hangs it one margin above the bar', () => {
    const r = popoverRect(anchor(1200), { width: 400, height: 240 }, SCREEN)
    expect(r).toEqual({ left: 1200 + 80 - 200, top: BAR_TOP - POPOVER_MARGIN - 240, width: 400, height: 240 })
  })

  it('clamps to the left margin when the anchor sits at the left edge', () => {
    const r = popoverRect(anchor(0), { width: 400, height: 240 }, SCREEN)
    expect(r.left).toBe(POPOVER_MARGIN)
  })

  it('clamps to the right margin when the anchor sits at the right edge', () => {
    const r = popoverRect(anchor(SCREEN.width - 160), { width: 400, height: 240 }, SCREEN)
    expect(r.left).toBe(SCREEN.width - POPOVER_MARGIN - 400)
  })

  it('shrinks a box taller than the room above the bar and keeps it at the top margin', () => {
    const r = popoverRect(anchor(1200), { width: 400, height: 900 }, SCREEN)
    expect(r.height).toBe(BAR_TOP - POPOVER_MARGIN * 2)
    expect(r.top).toBe(POPOVER_MARGIN)
  })

  it('shrinks a box wider than the screen and pins it to the left margin', () => {
    const r = popoverRect(anchor(1200), { width: 4000, height: 240 }, { width: 800, height: 720 })
    expect(r.width).toBe(800 - POPOVER_MARGIN * 2)
    expect(r.left).toBe(POPOVER_MARGIN)
  })

  it('never returns a negative size when there is no room at all', () => {
    const r = popoverRect({ left: 0, width: 40, top: 8 }, { width: 400, height: 240 }, { width: 20, height: 8 })
    expect(r.width).toBe(0)
    expect(r.height).toBe(0)
  })

  it('takes a custom margin', () => {
    const r = popoverRect(anchor(1200), { width: 400, height: 240 }, SCREEN, 40)
    expect(r.top).toBe(BAR_TOP - 40 - 240)
  })
})
