// @vitest-environment jsdom
/**
 * companion/fremdev/perf.js, the isolated-world script that reads a dev tab's performance timeline
 * (load, LCP, CLS, long tasks, JS heap) and tells the worker at most once a second. It is a classic
 * script: it is run here with a stubbed `performance` and `PerformanceObserver`, a fake
 * `chrome.runtime`, and a fresh `window` object per page for its once-per-page guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'

const source = readFileSync(new NodeURL('../../companion/fremdev/perf.js', import.meta.url), 'utf8')

type Entry = Record<string, unknown>

function page({ loadEventEnd = 1234.4, heap }: { loadEventEnd?: number; heap?: number } = {}) {
  const observers: Array<{ type: string; buffered: boolean; cb: (list: { getEntries(): Entry[] }) => void }> = []
  class FakeObserver {
    cb: (list: { getEntries(): Entry[] }) => void
    constructor(cb: (list: { getEntries(): Entry[] }) => void) {
      this.cb = cb
    }
    observe(opts: { type: string; buffered: boolean }) {
      observers.push({ type: opts.type, buffered: opts.buffered, cb: this.cb })
    }
    disconnect() {}
  }
  const nav = { loadEventEnd }
  const performance: Record<string, unknown> = {
    getEntriesByType: (type: string) => (type === 'navigation' ? [nav] : []),
  }
  if (heap !== undefined) performance.memory = { usedJSHeapSize: heap }
  const sendMessage = vi.fn((_msg: unknown) => Promise.resolve())
  const chrome: { runtime: { id: string | undefined; sendMessage: typeof sendMessage } } = { runtime: { id: 'ext', sendMessage } }
  const win: Record<string, unknown> = { addEventListener: vi.fn() }
  const run = () =>
    new Function('window', 'document', 'chrome', 'setTimeout', 'clearTimeout', 'setInterval', 'performance', 'PerformanceObserver', source)(
      win, document, chrome, setTimeout, clearTimeout, setInterval, performance, FakeObserver,
    )
  /** The page's timeline gains entries of this type. */
  const emit = (type: string, entries: Entry[]) => {
    for (const o of observers) if (o.type === type) o.cb({ getEntries: () => entries })
  }
  const sent = () => sendMessage.mock.calls.map(([m]) => m)
  return { run, emit, sent, observers, nav, performance, chrome }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('fremdev/perf.js', () => {
  it('observes LCP, layout shifts and long tasks, buffered', () => {
    const p = page()
    p.run()
    expect(p.observers.map((o) => [o.type, o.buffered])).toEqual([
      ['largest-contentful-paint', true],
      ['layout-shift', true],
      ['longtask', true],
    ])
  })

  it('sends the load, the latest LCP, the CLS without input-driven shifts and the long tasks, in one message', () => {
    const p = page()
    p.run()
    p.emit('largest-contentful-paint', [{ startTime: 500 }, { startTime: 800.2 }])
    p.emit('layout-shift', [
      { value: 0.015, hadRecentInput: false },
      { value: 0.5, hadRecentInput: true },
      { value: 0.005, hadRecentInput: false },
    ])
    p.emit('longtask', [{ duration: 80 }])
    vi.advanceTimersByTime(1_000)
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'perf', load: 1234, lcp: 800, cls: 0.02, longTasks: 1 }])
  })

  it('sends at most once a second: five changes within 1 s give one message, and nothing when nothing changed', () => {
    const p = page()
    p.run()
    for (let i = 1; i <= 5; i++) {
      p.emit('largest-contentful-paint', [{ startTime: i * 100 }])
      vi.advanceTimersByTime(150)
    }
    vi.advanceTimersByTime(1_000)
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'perf', load: 1234, lcp: 500 }])
    // The same value again is no change.
    p.emit('largest-contentful-paint', [{ startTime: 500 }])
    vi.advanceTimersByTime(5_000)
    expect(p.sent()).toHaveLength(1)
    p.emit('longtask', [{ duration: 51 }, { duration: 49 }])
    vi.advanceTimersByTime(1_000)
    expect(p.sent().at(-1)).toEqual({ target: 'worker', type: 'dev.event', kind: 'perf', load: 1234, lcp: 500, longTasks: 1 })
  })

  it('waits for loadEventEnd above 0, and reads the heap in MB where Chrome has it', () => {
    const p = page({ loadEventEnd: 0, heap: 45 * 1_048_576 })
    p.run()
    vi.advanceTimersByTime(1_000)
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'perf', heapMb: 45 }])
    p.nav.loadEventEnd = 640
    vi.advanceTimersByTime(2_000)
    expect(p.sent().at(-1)).toEqual({ target: 'worker', type: 'dev.event', kind: 'perf', load: 640, heapMb: 45 })
    // The heap moves with nothing else happening: it is read again now and then.
    ;(p.performance.memory as { usedJSHeapSize: number }).usedJSHeapSize = 60 * 1_048_576
    vi.advanceTimersByTime(11_000)
    expect(p.sent().at(-1)).toEqual({ target: 'worker', type: 'dev.event', kind: 'perf', load: 640, heapMb: 60 })
  })

  it('bounds what it sends', () => {
    const p = page({ loadEventEnd: 9_999_999 })
    p.run()
    p.emit('layout-shift', [{ value: 250, hadRecentInput: false }])
    p.emit('largest-contentful-paint', [{ startTime: 700_000 }])
    vi.advanceTimersByTime(1_000)
    expect(p.sent()).toEqual([{ target: 'worker', type: 'dev.event', kind: 'perf', load: 600_000, lcp: 600_000, cls: 100 }])
  })

  it('runs once per page, and an orphaned script sends nothing', () => {
    const p = page()
    p.run()
    p.run()
    expect(p.observers).toHaveLength(3)
    p.chrome.runtime.id = undefined
    p.emit('largest-contentful-paint', [{ startTime: 800 }])
    vi.advanceTimersByTime(1_000)
    expect(p.sent()).toEqual([])
  })
})
