/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSwipe } from '../src/dashboard/useSwipe'
import { HOLD_SWIPE_EVENT, swipeDelta } from '../src/shared/widgetMessages'

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

describe('a swipe a widget saw', () => {
  afterEach(() => { vi.useRealTimers() })
  // The lock is module-wide and the test above left one on the real clock: start well past it.
  const pastEarlierLocks = () => vi.advanceTimersByTime(10 * 60_000)

  it('turns the page once, and the wheel the same drag sends after it does not turn another', () => {
    vi.useFakeTimers()
    pastEarlierLocks()
    const swipes: number[] = []
    const s = useSwipe((d) => swipes.push(d))
    s.fling(1)
    s.wheel(wheel(80))
    s.fling(-1)
    expect(swipes).toEqual([1])
    vi.advanceTimersByTime(600)
    s.fling(-1)
    expect(swipes).toEqual([1, -1])
  })
  it('waits while a slider holds swipes off', () => {
    vi.useFakeTimers()
    pastEarlierLocks()
    const swipes: number[] = []
    const s = useSwipe((d) => swipes.push(d))
    window.dispatchEvent(new Event(HOLD_SWIPE_EVENT))
    s.fling(1)
    expect(swipes).toEqual([])
  })
})

describe('swipeDelta', () => {
  it('takes 1 or -1 and nothing else', () => {
    expect(swipeDelta({ delta: 1 })).toBe(1)
    expect(swipeDelta({ delta: -1 })).toBe(-1)
    for (const bad of [{ delta: 2 }, { delta: '1' }, { delta: 0 }, {}, null, 'x']) expect(swipeDelta(bad)).toBeNull()
  })
})
