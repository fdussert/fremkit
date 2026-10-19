import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { errorText, MAX_TEXT, RateLimiter } from '../../companion/lib/devlog.js'

// fremdev/hook.js and fremdev/relay.js are classic content scripts (no import): they are run here
// in a sandbox of fakes, which is also what keeps their copies of lib/devlog.js honest.

const ROOT = join(import.meta.dirname, '..', '..', 'companion')
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const EVENT = '__fremkit_fremdev__'

type Listener = (e: unknown) => void

/** A CustomEvent as the hook builds it: the type and the init's detail. */
class FakeCustomEvent {
  type: string
  detail: unknown
  constructor(type: string, init: { detail?: unknown }) {
    this.type = type
    this.detail = init.detail
  }
}

/** Events whose fields are prototype getters over a private slot, like the browser's. */
class FakeErrorEvent {
  #error: unknown
  #message: string
  constructor(error: unknown, message: string) {
    this.#error = error
    this.#message = message
  }
  get error() {
    return this.#error
  }
  get message() {
    return this.#message
  }
  preventDefault = vi.fn()
}
class FakeRejectionEvent {
  #reason: unknown
  constructor(reason: unknown) {
    this.#reason = reason
  }
  get reason() {
    return this.#reason
  }
  preventDefault = vi.fn()
}

function runHook() {
  const listeners: Record<string, Listener> = {}
  const dispatched: Array<{ type: string; detail: unknown }> = []
  const printed: unknown[][] = []
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn
    },
  }
  const document = { tag: 'document' }
  const EventTarget = {
    prototype: {
      dispatchEvent(this: unknown, e: FakeCustomEvent) {
        if (this !== document) throw new Error('dispatched elsewhere')
        dispatched.push({ type: e.type, detail: e.detail })
        return true
      },
    },
  }
  const console: Record<string, (...args: unknown[]) => unknown> = {
    error: function error(...args: unknown[]) {
      printed.push(args)
      return 'printed'
    },
    log: function log(...args: unknown[]) {
      printed.push(args)
    },
    info: function info(...args: unknown[]) {
      printed.push(args)
    },
    debug: function debug(...args: unknown[]) {
      printed.push(args)
    },
  }
  const original = console.error
  const run = () =>
    new Function('window', 'console', 'document', 'EventTarget', 'CustomEvent', 'ErrorEvent', 'PromiseRejectionEvent', source('fremdev/hook.js'))(
      window, console, document, EventTarget, FakeCustomEvent, FakeErrorEvent, FakeRejectionEvent,
    )
  run()
  const events = () => dispatched.map((d) => (expect(d.type).toBe(EVENT), JSON.parse(d.detail as string)))
  return { run, window, console, original, listeners, dispatched, events, printed }
}

const block = (text: string) => {
  const m = /\/\/ <errorText>[\s\S]*?\/\/ <\/errorText>/.exec(text)
  return m ? m[0] : null
}

describe('fremdev/hook.js', () => {
  it('carries lib/devlog.js errorText block byte for byte', () => {
    const lib = block(source('lib/devlog.js'))
    expect(lib).not.toBeNull()
    expect(block(source('fremdev/hook.js'))).toBe(lib)
    // and the intrinsics it reads, taken the same way
    for (const line of source('lib/devlog.js').split('\n').filter((l) => /^const (gopd|getProto|isArray|ownKeys|quote|symbolDescription|domProto|domName|domMessage) = /.test(l))) {
      expect(source('fremdev/hook.js')).toContain(line)
    }
  })

  it("prints first, then dispatches console.error's text exactly as errorText joins it", () => {
    const h = runHook()
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    let ran = 0
    const cases: unknown[][] = [
      ['plain'],
      [new TypeError('boom'), 'after'],
      [{ a: 1, b: [2] }],
      [circular],
      [Symbol('s')],
      [],
      [undefined, null, 42, 7n],
      ['x'.repeat(400)],
      [{ toJSON: () => { ran += 1; return 'x' } }],
      [{ get g() { ran += 1; return 1 } }],
      [new Proxy({ a: 1 }, { get: () => { ran += 1; return 1 } })],
    ]
    for (const args of cases) {
      h.dispatched.length = 0
      h.printed.length = 0
      expect(h.console.error(...args)).toBe('printed')
      expect(ran).toBe(0)
      // Compared by identity: an equality check would read the Proxy itself.
      expect(h.printed).toHaveLength(1)
      expect(h.printed[0].length === args.length && h.printed[0].every((a, i) => a === args[i])).toBe(true)
      const expected = errorText(args)
      expect(ran).toBe(0)
      expect(h.events()).toEqual([{ kind: 'error', text: expected }])
      expect(expected.length).toBeLessThanOrEqual(MAX_TEXT)
    }
  })

  it('looks like the console it wraps', () => {
    const h = runHook()
    expect(h.console.error).not.toBe(h.original)
    expect(h.console.error.name).toBe('error')
    expect(h.console.error.toString()).toBe(Function.prototype.toString.call(h.original))
    expect(h.console.error.length).toBe(0)
    expect('prototype' in h.console.error).toBe(false)
    const flag = Object.getOwnPropertyDescriptor(h.window, '__fremdevHooked')
    expect(flag).toMatchObject({ enumerable: false, configurable: true })
    expect(Object.keys(h.window)).not.toContain('__fremdevHooked')
  })

  it('does not follow a value whose inspection logs again', () => {
    const h = runHook()
    const loud = new Proxy({}, { ownKeys: () => { h.console.error('inner'); return [] } })
    h.console.error(loud)
    expect(h.printed).toEqual([[loud], ['inner']])
    expect(h.events()).toEqual([{ kind: 'error', text: '{}' }])
  })

  it('dispatches a dev server signal from log, info and debug, and nothing for an ordinary line', () => {
    const h = runHook()
    h.console.debug('[vite] connected.')
    h.console.log('[vite] server connection lost. Polling for restart...')
    h.console.info('[HMR] App is up to date.')
    h.console.log('hello')
    h.console.log({ not: 'a string' })
    expect(h.events()).toEqual([{ kind: 'up' }, { kind: 'down' }, { kind: 'hot' }])
    expect(h.printed).toHaveLength(5)
  })

  it('reports uncaught errors and rejections without preventing them', () => {
    const h = runHook()
    const error = new FakeErrorEvent(new Error('bad'), 'ignored')
    const rejection = new FakeRejectionEvent('nope')
    h.listeners.error(error)
    h.listeners.unhandledrejection(rejection)
    h.listeners.error(new FakeErrorEvent(null, 'Script error.'))
    expect(h.events().map((e) => e.text)).toEqual(['Uncaught Error: bad', 'Uncaught (in promise) nope', 'Uncaught Script error.'])
    expect(error.preventDefault).not.toHaveBeenCalled()
    expect(rejection.preventDefault).not.toHaveBeenCalled()
  })

  it("reads an event's fields through the getters it took at load, never the page's", () => {
    const h = runHook()
    let ran = 0
    // The page redefines them after the hook ran: on the prototype and on the event itself.
    const saved = Object.getOwnPropertyDescriptor(FakeErrorEvent.prototype, 'error')!
    Object.defineProperty(FakeErrorEvent.prototype, 'error', { get: () => (ran++, 'page'), configurable: true })
    try {
      const e = new FakeErrorEvent(new TypeError('real'), 'm')
      Object.defineProperty(e, 'error', { get: () => (ran++, 'page') })
      h.listeners.error(e)
      const r = new FakeRejectionEvent('why')
      Object.defineProperty(r, 'reason', { get: () => (ran++, 'page') })
      h.listeners.unhandledrejection(r)
    } finally {
      Object.defineProperty(FakeErrorEvent.prototype, 'error', saved)
    }
    expect(ran).toBe(0)
    expect(h.events().map((e) => e.text)).toEqual(['Uncaught TypeError: real', 'Uncaught (in promise) why'])
  })

  it('hooks a page only once', () => {
    const h = runHook()
    const wrapped = h.console.error
    h.run()
    expect(h.console.error).toBe(wrapped)
  })
})

function runRelay() {
  let clock = 1_000_000
  const timers: Array<() => void> = []
  let onEvent: Listener = () => undefined
  const sent: Array<Record<string, unknown>> = []
  const window: Record<string, unknown> = {}
  const document = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === EVENT) onEvent = fn
    },
  }
  const chrome = { runtime: { id: 'ext', sendMessage: (m: Record<string, unknown>) => (sent.push(m), Promise.resolve()) } }
  const DateFake = { now: () => clock }
  const setTimeout = (fn: () => void) => void timers.push(fn)
  new Function('window', 'document', 'chrome', 'Date', 'setTimeout', source('fremdev/relay.js'))(window, document, chrome, DateFake, setTimeout)
  const post = (data: unknown) => onEvent({ detail: JSON.stringify(data) })
  const raw = (detail: unknown) => onEvent({ detail })
  return { window, document, sent, timers, post, raw, at: (t: number) => { clock = t } }
}

describe('fremdev/relay.js', () => {
  it('forwards 10 events a second and counts every error over that', () => {
    const r = runRelay()
    for (let i = 0; i < 1000; i++) r.post({ kind: 'error', text: `e${i}` })
    expect(r.sent).toHaveLength(10)
    expect(r.sent[0]).toEqual({ target: 'worker', type: 'dev.event', kind: 'error', text: 'e0' })
    expect(r.timers).toHaveLength(1)
    r.timers.shift()!()
    expect(r.sent[10]).toEqual({ target: 'worker', type: 'dev.event', kind: 'count', n: 990 })
    r.at(1_001_000)
    r.post({ kind: 'error', text: 'later' })
    expect(r.sent[11]).toEqual({ target: 'worker', type: 'dev.event', kind: 'error', text: 'later' })
  })

  it("decides exactly as lib/devlog.js's RateLimiter on the same sequence", () => {
    const r = runRelay()
    let t = 0
    const limiter = new RateLimiter(10, () => t)
    // Bursts, gaps and the edges of the window.
    const times: number[] = []
    for (let i = 0; i < 15; i++) times.push(1000)
    for (let i = 0; i < 12; i++) times.push(1500 + i * 30)
    times.push(1999, 2000, 2000, 2001, 2999, 3000, 5000)
    for (let i = 0; i < 30; i++) times.push(5000 + i * 97)
    const relay: boolean[] = []
    const lib: boolean[] = []
    for (const [i, at] of times.entries()) {
      t = at
      r.at(at)
      const before = r.sent.length
      r.post({ kind: 'hot', text: String(i) })
      relay.push(r.sent.length > before)
      lib.push(limiter.allow())
    }
    expect(relay).toEqual(lib)
    expect(lib.filter(Boolean).length).toBeGreaterThan(10)
    expect(lib.includes(false)).toBe(true)
  })

  it('forwards a known kind and a bounded text only, and survives anything else', () => {
    const r = runRelay()
    r.post({ kind: 'navigate', tabId: 9 })
    r.post('error')
    r.post(null)
    r.raw('{not json')
    r.raw({ kind: 'error', text: 'an object detail' })
    r.raw(JSON.stringify({ kind: 'error', text: 'z'.repeat(5000) }))
    expect(r.sent).toEqual([])
    r.post({ kind: 'error', text: 'y'.repeat(1000).slice(0, 1000), tabId: 9, n: 5 })
    r.post({ kind: 'hot', text: 'z', tabId: 9 })
    r.post({ kind: 'error', text: { no: 1 } })
    expect(r.sent).toEqual([
      { target: 'worker', type: 'dev.event', kind: 'error', text: 'y'.repeat(300) },
      { target: 'worker', type: 'dev.event', kind: 'hot' },
      { target: 'worker', type: 'dev.event', kind: 'error', text: '' },
    ])
  })

  it('writes nothing on the page', () => {
    const r = runRelay()
    expect(Object.keys(r.document)).toEqual(['addEventListener'])
    expect(source('fremdev/relay.js')).not.toMatch(/dataset|setAttribute|postMessage/)
    expect(source('fremdev/hook.js')).not.toMatch(/dataset|setAttribute|postMessage/)
  })
})
