/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSwipe } from '../src/dashboard/useSwipe'
import { HOLD_SWIPE_EVENT } from '../src/shared/widgetMessages'

function wheel(deltaX: number): WheelEvent {
  return new WheelEvent('wheel', { deltaX, cancelable: true })
}

describe('useSwipe and a widget holding swipes off', () => {
  afterEach(() => { vi.useRealTimers() })

  it('ignores the wheel that follows a slider out of its widget, then swipes again', () => {
    vi.useFakeTimers()
    const swipes: number[] = []
    const s = useSwipe((d) => swipes.push(d))

    window.dispatchEvent(new Event(HOLD_SWIPE_EVENT))
    s.wheel(wheel(80))
    expect(swipes).toEqual([])

    vi.advanceTimersByTime(600)
    s.wheel(wheel(80))
    expect(swipes).toEqual([1])
  })

  it('still swallows the held wheel, so nothing else scrolls', () => {
    const s = useSwipe(() => {})
    window.dispatchEvent(new Event(HOLD_SWIPE_EVENT))
    const e = wheel(80)
    s.wheel(e)
    expect(e.defaultPrevented).toBe(true)
  })
})
