import { describe, expect, it, vi } from 'vitest'
import { CONFIRM_WINDOW_MS, useConfirm } from '../src/shared/useConfirm'

describe('useConfirm', () => {
  it('arms on the first tap and runs on the second', () => {
    const c = useConfirm(() => 1000)
    const action = vi.fn()
    expect(c.ask('a', action)).toBe(false)
    expect(c.armed('a')).toBe(true)
    expect(action).not.toHaveBeenCalled()
    expect(c.ask('a', action)).toBe(true)
    expect(action).toHaveBeenCalledTimes(1)
    expect(c.armed('a')).toBe(false)
  })

  it('a tap on another key re-arms rather than running anything', () => {
    const c = useConfirm(() => 1000)
    const a = vi.fn(), b = vi.fn()
    c.ask('a', a)
    expect(c.ask('b', b)).toBe(false)
    expect(c.armed('a')).toBe(false)
    expect(c.armed('b')).toBe(true)
    expect(a).not.toHaveBeenCalled(); expect(b).not.toHaveBeenCalled()
  })

  it('forgets an armed key once the window has passed', () => {
    vi.useFakeTimers()
    let now = 1000
    const c = useConfirm(() => now)
    const action = vi.fn()
    c.ask('a', action)
    now += CONFIRM_WINDOW_MS + 1
    vi.advanceTimersByTime(CONFIRM_WINDOW_MS + 1)
    expect(c.armed('a')).toBe(false)
    expect(c.ask('a', action)).toBe(false)
    expect(action).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
