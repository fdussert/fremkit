import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { errorText, MAX_FRAME, MAX_FRAMES, MAX_STACK, MAX_TEXT, RateLimiter } from '../../companion/lib/devlog.js'

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
  #place: [string, number, number]
  constructor(error: unknown, message: string, place: [string, number, number] = ['', 0, 0]) {
    this.#error = error
    this.#message = message
    this.#place = place
  }
  get error() {
    return this.#error
  }
  get message() {
    return this.#message
  }
  get filename() {
    return this.#place[0]
  }
  get lineno() {
    return this.#place[1]
  }
  get colno() {
    return this.#place[2]
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
    new Function('window', 'console', 'document', 'location', 'EventTarget', 'CustomEvent', 'ErrorEvent', 'PromiseRejectionEvent', source('fremdev/hook.js'))(
      window, console, document, { origin: PAGE }, EventTarget, FakeCustomEvent, FakeErrorEvent, FakeRejectionEvent,
    )
  run()
  const events = () => dispatched.map((d) => (expect(d.type).toBe(EVENT), JSON.parse(d.detail as string)))
  return { run, window, console, original, listeners, dispatched, events, printed }
}

const block = (text: string, name = 'errorText') => {
  const m = new RegExp(`// <${name}>[\\s\\S]*?// </${name}>`).exec(text)
  return m ? m[0] : null
}

const PAGE = 'http://localhost:5173'
/**
 * Runs `fn` with `Error.prepareStackTrace` set by `define`, or absent as in Chrome (Node defines its
 * own), and puts Node's back afterwards.
 */
function withPrepare(fn: () => void, define?: PropertyDescriptor) {
  const saved = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')
  delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace
  try {
    if (define) Object.defineProperty(Error, 'prepareStackTrace', { configurable: true, ...define })
    fn()
  } finally {
    delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace
    if (saved) Object.defineProperty(Error, 'prepareStackTrace', saved)
  }
}

/** An error made by "page code" at a known URL, so its frames read like a dev page's. */
const pageError = (expr: string) => new Function(`return ${expr}\n//# sourceURL=${PAGE}/src/page.js`)() as Error

describe('fremdev/hook.js', () => {
  it('carries lib/devlog.js errorText block byte for byte', () => {
    const lib = block(source('lib/devlog.js'))
    expect(lib).not.toBeNull()
    expect(block(source('fremdev/hook.js'))).toBe(lib)
    // and the intrinsics it reads, taken the same way
    for (const line of source('lib/devlog.js').split('\n').filter((l) => /^const (gopd|getProto|isArray|ownKeys|quote|symbolDescription|domProto|domName|domMessage|Url|reflectApply|defineProp|strSlice|strIndexOf|strCharCodeAt|regexpExec|urlOrigin|urlHost|urlPathname|urlProtocol) = /.test(l))) {
      expect(source('fremdev/hook.js')).toContain(line)
    }
  })

  it('carries lib/devlog.js frames block byte for byte', () => {
    const lib = block(source('lib/devlog.js'), 'frames')
    expect(lib).not.toBeNull()
    expect(lib).toContain('function framePlace(')
    expect(lib).toContain('function parseStack(')
    expect(block(source('fremdev/hook.js'), 'frames')).toBe(lib)
  })

  it('sends the stack of an uncaught error, a logged one and a rejected one, its first frame as the origin', () => {
    const h = runHook()
    withPrepare(() => {
      h.listeners.error(new FakeErrorEvent(pageError("new TypeError('x')"), 'x', [`${PAGE}/src/page.js`, 3, 8]))
      h.console.error(pageError("new Error('y')"))
      h.console.error('context:', pageError("new Error('w')"))
      h.listeners.unhandledrejection(new FakeRejectionEvent(pageError("new Error('z')")))
    })
    const events = h.events()
    expect(events.map((e) => e.text)).toEqual(['Uncaught TypeError: x', 'Error: y', 'context: Error: w', 'Uncaught (in promise) Error: z'])
    for (const e of events) {
      expect(e.stack.length).toBeGreaterThan(0)
      expect(e.stack.length).toBeLessThanOrEqual(MAX_FRAMES)
      expect(e.stack.join('\n').length).toBeLessThanOrEqual(MAX_STACK)
      expect(e.origin).toBe(e.stack[0])
      expect(e.stack[0]).toMatch(/^\S+ \/src\/page\.js:3:\d+$/)
    }
  })

  it('sends no stack and no origin for what is not an error', () => {
    const h = runHook()
    h.console.error('plain', { stack: '    at f (http://localhost:5173/a.js:1:1)' })
    h.listeners.unhandledrejection(new FakeRejectionEvent('nope'))
    h.listeners.error(new FakeErrorEvent(null, 'Script error.'))
    expect(h.events()).toEqual([
      { kind: 'error', text: 'plain {"stack":"    at f (http://localhost:5173/a.js:1:1)"}' },
      { kind: 'error', text: 'Uncaught (in promise) nope' },
      { kind: 'error', text: 'Uncaught Script error.' },
    ])
  })

  it("reads no stack while the page set Error.prepareStackTrace, and takes the origin from the event's place", () => {
    const h = runHook()
    const spy = vi.fn(() => 'page')
    const errors = [pageError("new TypeError('x')"), pageError("new Error('y')"), pageError("new Error('z')")]
    withPrepare(
      () => {
        h.listeners.error(new FakeErrorEvent(errors[0], 'x', [`https://cdn.example.com/lib.js?v=abc#x`, 1, 2]))
        h.console.error(errors[1])
        h.listeners.unhandledrejection(new FakeRejectionEvent(errors[2]))
      },
      { value: spy, writable: true },
    )
    expect(spy).not.toHaveBeenCalled()
    const events = h.events()
    for (const e of events) expect(e).not.toHaveProperty('stack')
    expect(events[0].origin).toBe('cdn.example.com/lib.js:1:2')
    expect(events[1]).not.toHaveProperty('origin')
    expect(events[2]).not.toHaveProperty('origin')
  })

  it('reads no stack through an accessor the page put on Error.prepareStackTrace', () => {
    const h = runHook()
    const get = vi.fn(() => undefined)
    withPrepare(() => h.console.error(pageError("new Error('y')")), { get })
    expect(get).not.toHaveBeenCalled()
    expect(h.events()[0]).not.toHaveProperty('stack')
  })

  it("never calls a stack getter the page defined, nor a name or message getter V8's formatting would read", () => {
    const h = runHook()
    let ran = 0
    const own = pageError("new Error('a')")
    Object.defineProperty(own, 'stack', { get: () => (ran++, '    at f (http://localhost:5173/a.js:1:1)'), configurable: true })
    const message = pageError("new Error('b')")
    Object.defineProperty(message, 'message', { get: () => (ran++, 'm') })
    class Named extends Error {
      get name() {
        ran++
        return 'Named'
      }
    }
    const named = new Named('c')
    const boxed = pageError("new Error('d')")
    Object.defineProperty(boxed, 'message', { value: { toString: () => (ran++, 'boxed') } })
    withPrepare(() => {
      for (const e of [own, message, named, boxed]) h.console.error(e)
      // and the same error left alone still gives its stack: the checks are what stopped it
      h.console.error(pageError("new Error('e')"))
    })
    expect(ran).toBe(0)
    const events = h.events()
    expect(events).toHaveLength(5)
    for (const e of events.slice(0, 4)) expect(e).not.toHaveProperty('stack')
    expect(events[4]).toHaveProperty('stack')
  })

  it("writes and reads its frame lists without the page's Array.prototype accessors", () => {
    const h = runHook()
    // Fills index 0 of the harness's own lists, so their push does not reach the accessor.
    h.console.error('warm')
    const get = vi.fn(() => 'page')
    const set = vi.fn()
    withPrepare(() => {
      Object.defineProperty(Array.prototype, '0', { get, set, configurable: true })
      try {
        h.console.error(pageError("new Error('y')"))
      } finally {
        delete (Array.prototype as unknown as Record<string, unknown>)['0']
      }
    })
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    const e = h.events()[1]
    expect(e.stack.length).toBeGreaterThan(0)
    expect(e.stack[0]).toMatch(/\/src\/page\.js:3:\d+$/)
    expect(e.origin).toBe(e.stack[0])
  })

  it("calls the builtins it took at load, not the page's later ones", () => {
    const h = runHook()
    const ran = vi.fn()
    const saved = {
      slice: String.prototype.slice,
      indexOf: String.prototype.indexOf,
      exec: RegExp.prototype.exec,
      pathname: Object.getOwnPropertyDescriptor(URL.prototype, 'pathname')!,
    }
    withPrepare(() => {
      const err = pageError("new Error('y')")
      String.prototype.slice = function (...a: [number?, number?]) { ran(); return saved.slice.apply(this, a) }
      String.prototype.indexOf = function (...a: [string, number?]) { ran(); return saved.indexOf.apply(this, a) }
      RegExp.prototype.exec = function (s: string) { ran(); return saved.exec.call(this, s) }
      Object.defineProperty(URL.prototype, 'pathname', { get() { ran(); return '/page' }, configurable: true })
      try {
        h.console.error(err)
      } finally {
        String.prototype.slice = saved.slice
        String.prototype.indexOf = saved.indexOf
        RegExp.prototype.exec = saved.exec
        Object.defineProperty(URL.prototype, 'pathname', saved.pathname)
      }
    })
    const e = h.events()[0]
    expect(e.stack[0]).toMatch(/\/src\/page\.js:3:\d+$/)
    // The harness's own clip and errorText may call the live ones; the frames never do.
    expect(e.stack.join('\n')).not.toContain('/page:')
  })

  it('bounds the origin it takes from the event', () => {
    const h = runHook()
    h.listeners.error(new FakeErrorEvent(null, 'm', [`${PAGE}/${'p'.repeat(400)}.js`, 1, 1]))
    expect(h.events()[0].origin).toHaveLength(MAX_FRAME)
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
    r.raw(JSON.stringify({ kind: 'error', text: 'z'.repeat(20_000) }))
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

  it('forwards an error\'s origin and stack within bounds, and drops a stack that is not a list of strings', () => {
    const r = runRelay()
    r.post({ kind: 'error', text: 't', origin: 'Cart.setup /src/Cart.vue:1:2', stack: ['Cart.setup /src/Cart.vue:1:2', '/a.js:3:4'] })
    expect(r.sent.at(-1)).toEqual({
      target: 'worker', type: 'dev.event', kind: 'error', text: 't',
      origin: 'Cart.setup /src/Cart.vue:1:2', stack: ['Cart.setup /src/Cart.vue:1:2', '/a.js:3:4'],
    })
    for (const stack of ['a', ['a', 1], { 0: 'a', length: 1 }, [null]]) {
      r.post({ kind: 'error', text: 't', stack, origin: 7 })
      expect(r.sent.at(-1)).toEqual({ target: 'worker', type: 'dev.event', kind: 'error', text: 't' })
    }
    r.post({ kind: 'error', text: 't', origin: 'o'.repeat(400), stack: Array.from({ length: 15 }, () => 's'.repeat(400)) })
    const last = r.sent.at(-1) as { origin: string; stack: string[] }
    expect(last.origin).toHaveLength(300)
    expect(last.stack.length).toBeLessThanOrEqual(10)
    expect(last.stack.every((f) => f.length <= 300)).toBe(true)
    expect(last.stack.join('\n').length).toBeLessThanOrEqual(2000)
    expect(last.stack.length).toBe(6)
    r.post({ kind: 'hot', origin: 'o', stack: ['a'] })
    expect(r.sent.at(-1)).toEqual({ target: 'worker', type: 'dev.event', kind: 'hot' })
  })

  it("keeps the stack bounds of lib/devlog.js, and never splits a surrogate pair", () => {
    const relay = source('fremdev/relay.js')
    const value = (name: string) => Number(new RegExp(`const ${name} = (\\d+)`).exec(relay)?.[1])
    expect([value('MAX_FRAMES'), value('MAX_FRAME'), value('MAX_STACK'), value('MAX_TEXT')]).toEqual([MAX_FRAMES, MAX_FRAME, MAX_STACK, MAX_TEXT])
    const r = runRelay()
    const pair = '\u{1F600}'
    const odd = `${'a'.repeat(299)}${pair}`
    r.post({ kind: 'error', text: odd, origin: odd, stack: [odd] })
    expect(r.sent.at(-1)).toEqual({
      target: 'worker', type: 'dev.event', kind: 'error', text: 'a'.repeat(299), origin: 'a'.repeat(299), stack: ['a'.repeat(299)],
    })
  })

  it('writes nothing on the page', () => {
    const r = runRelay()
    expect(Object.keys(r.document)).toEqual(['addEventListener'])
    expect(source('fremdev/relay.js')).not.toMatch(/dataset|setAttribute|postMessage/)
    expect(source('fremdev/hook.js')).not.toMatch(/dataset|setAttribute|postMessage/)
  })
})
