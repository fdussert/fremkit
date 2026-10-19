import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { errorText, MAX_TEXT } from '../../companion/lib/devlog.js'
// @ts-expect-error plain JS module
import { createFremdev, pageEvent } from '../../companion/fremdev.js'

// fremdev/hook.js and fremdev/relay.js are classic content scripts (no import): they are run here
// in a sandbox of fakes, which is also what keeps their copies of lib/devlog.js honest.

const ROOT = join(import.meta.dirname, '..', '..', 'companion')
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8')

type Listener = (e: unknown) => void

function runHook(ch: string | null = 'chan') {
  const listeners: Record<string, Listener> = {}
  const posted: Array<{ msg: unknown; origin: string }> = []
  const printed: unknown[][] = []
  const window: Record<string, unknown> = {
    postMessage: (msg: unknown, origin: string) => posted.push({ msg, origin }),
    addEventListener: (type: string, fn: Listener) => {
      listeners[type] = fn
    },
  }
  const console = {
    error: (...args: unknown[]) => {
      printed.push(args)
      return 'printed'
    },
    log: (...args: unknown[]) => void printed.push(args),
    info: (...args: unknown[]) => void printed.push(args),
    debug: (...args: unknown[]) => void printed.push(args),
  }
  const document = { documentElement: { dataset: ch ? { fremdevCh: ch } : {} } }
  const location = { origin: 'http://localhost:5173' }
  const run = () => new Function('window', 'console', 'document', 'location', source('fremdev/hook.js'))(window, console, document, location)
  run()
  return { run, window, console, document, listeners, posted, printed }
}

describe('fremdev/hook.js', () => {
  it("prints first, then posts console.error's text exactly as errorText joins it", () => {
    const h = runHook()
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular
    const cases: unknown[][] = [
      ['plain'],
      [new TypeError('boom'), 'after'],
      [{ a: 1, b: [2] }],
      [circular],
      [Symbol('s')],
      [],
      [undefined, null, 42],
      ['x'.repeat(400)],
      [{ toJSON: () => { throw new Error('no') } }],
    ]
    for (const args of cases) {
      h.posted.length = 0
      h.printed.length = 0
      expect(h.console.error(...args)).toBe('printed')
      expect(h.printed).toEqual([args])
      expect(h.posted).toEqual([{ msg: { ch: 'chan', kind: 'error', text: errorText(args) }, origin: 'http://localhost:5173' }])
      expect((h.posted[0].msg as { text: string }).text.length).toBeLessThanOrEqual(MAX_TEXT)
    }
  })

  it('posts a dev server signal from log, info and debug, and nothing for an ordinary line', () => {
    const h = runHook()
    h.console.debug('[vite] connected.')
    h.console.log('[vite] server connection lost. Polling for restart...')
    h.console.info('[HMR] App is up to date.')
    h.console.log('hello')
    h.console.log({ not: 'a string' })
    expect(h.posted.map((p) => p.msg)).toEqual([
      { ch: 'chan', kind: 'up' },
      { ch: 'chan', kind: 'down' },
      { ch: 'chan', kind: 'hot' },
    ])
    expect(h.printed).toHaveLength(5)
  })

  it('reports uncaught errors and rejections without preventing them', () => {
    const h = runHook()
    const preventDefault = vi.fn()
    h.listeners.error({ error: new Error('bad'), message: 'ignored', preventDefault })
    h.listeners.unhandledrejection({ reason: 'nope', preventDefault })
    expect(h.posted.map((p) => (p.msg as { text: string }).text)).toEqual(['Uncaught Error: bad', 'Uncaught (in promise) nope'])
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('stays silent without a channel, and hooks a page only once', () => {
    const h = runHook(null)
    h.console.error('x')
    expect(h.posted).toEqual([])
    expect(h.printed).toEqual([['x']])
    const wrapped = h.console.error
    h.run()
    expect(h.console.error).toBe(wrapped)
  })
})

function runRelay() {
  let clock = 1_000_000
  const timers: Array<() => void> = []
  let onMessage: Listener = () => undefined
  const sent: unknown[] = []
  const window: Record<string, unknown> = {
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') onMessage = fn
    },
  }
  const document = { documentElement: { dataset: {} as Record<string, string> } }
  const chrome = { runtime: { id: 'ext', sendMessage: (m: unknown) => (sent.push(m), Promise.resolve()) } }
  const crypto = { randomUUID: () => 'chan-1' }
  const DateFake = { now: () => clock }
  const setTimeout = (fn: () => void) => void timers.push(fn)
  new Function('window', 'document', 'chrome', 'crypto', 'Date', 'setTimeout', source('fremdev/relay.js'))(
    window, document, chrome, crypto, DateFake, setTimeout,
  )
  const post = (data: unknown, source: unknown = window) => onMessage({ source, data })
  return {
    window, document, sent, timers, post,
    tick: (ms: number) => {
      clock += ms
    },
  }
}

describe('fremdev/relay.js', () => {
  it('puts the channel id on the page before anything else', () => {
    expect(runRelay().document.documentElement.dataset.fremdevCh).toBe('chan-1')
  })

  it('forwards 10 events a second and counts every error over that', () => {
    const r = runRelay()
    for (let i = 0; i < 1000; i++) r.post({ ch: 'chan-1', kind: 'error', text: `e${i}` })
    expect(r.sent).toHaveLength(10)
    expect(r.sent[0]).toEqual({ target: 'worker', type: 'dev.event', kind: 'error', text: 'e0' })
    expect(r.timers).toHaveLength(1)
    r.timers.shift()!()
    expect(r.sent[10]).toEqual({ target: 'worker', type: 'dev.event', kind: 'count', n: 990 })
    // A second later the window has room again.
    r.tick(1000)
    r.post({ ch: 'chan-1', kind: 'error', text: 'later' })
    expect(r.sent[11]).toEqual({ target: 'worker', type: 'dev.event', kind: 'error', text: 'later' })
  })

  it('forwards a known kind and a bounded text only, from this window on this channel', () => {
    const r = runRelay()
    r.post({ ch: 'other', kind: 'error', text: 'x' })
    r.post({ ch: 'chan-1', kind: 'error', text: 'x' }, {})
    r.post({ ch: 'chan-1', kind: 'navigate', tabId: 9 })
    r.post('chan-1')
    r.post(null)
    expect(r.sent).toEqual([])
    r.post({ ch: 'chan-1', kind: 'error', text: 'y'.repeat(1000), tabId: 9, n: 5 })
    r.post({ ch: 'chan-1', kind: 'hot', text: 'z', tabId: 9 })
    r.post({ ch: 'chan-1', kind: 'error', text: { no: 1 } })
    expect(r.sent).toEqual([
      { target: 'worker', type: 'dev.event', kind: 'error', text: 'y'.repeat(300) },
      { target: 'worker', type: 'dev.event', kind: 'hot' },
      { target: 'worker', type: 'dev.event', kind: 'error', text: '' },
    ])
  })
})

/** A chrome.* just wide enough for fremdev.js. */
function fakeChrome({ on = true, granted = ['http://localhost/*'] } = {}) {
  const store = {
    local: { fremdev: { on, patterns: [] as string[] } } as Record<string, unknown>,
    session: {} as Record<string, unknown>,
  }
  const area = (data: Record<string, unknown>) => ({
    get: async (keys: string | string[]) => Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (patch: Record<string, unknown>) => void Object.assign(data, structuredClone(patch)),
  })
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() })
  const registered: unknown[] = []
  const api = {
    runtime: { id: 'ext' },
    storage: { local: area(store.local), session: area(store.session) },
    permissions: { contains: async ({ origins }: { origins: string[] }) => granted.includes(origins[0]), onAdded: event(), onRemoved: event() },
    scripting: {
      getRegisteredContentScripts: async () => registered.splice(0) as Array<{ id: string }>,
      unregisterContentScripts: vi.fn(async () => undefined),
      registerContentScripts: vi.fn(async (list: unknown[]) => void registered.push(...list)),
      executeScript: vi.fn(async () => []),
    },
    tabs: {
      query: async () => [{ id: 7, url: 'http://localhost:5173/', title: 'App', windowId: 1 }],
      get: async (id: number) => ({ id, url: 'http://localhost:5173/', title: 'App', windowId: 1 }),
      update: vi.fn(async () => undefined),
      onRemoved: event(),
      onUpdated: event(),
    },
    windows: { update: vi.fn(async () => undefined) },
    webRequest: { onCompleted: event(), onErrorOccurred: event() },
    webNavigation: { onCommitted: event(), onErrorOccurred: event() },
  }
  return { api, store }
}

const devSender = (over: Record<string, unknown> = {}) => ({
  id: 'ext',
  frameId: 0,
  url: 'http://localhost:5173/',
  tab: { id: 7, url: 'http://localhost:5173/', title: 'App' },
  ...over,
})

async function makeFremdev(opts?: Parameters<typeof fakeChrome>[0]) {
  const { api, store } = fakeChrome(opts)
  const sent: Array<{ type: string; [k: string]: unknown }> = []
  const wantSocket = vi.fn()
  let clock = 1_000
  const timers: Array<() => void> = []
  const fremdev = createFremdev({
    send: (m: { type: string }) => (sent.push(m), true),
    wantSocket,
    api,
    now: () => clock,
    setTimer: (fn: () => void) => void timers.push(fn),
    every: () => 1,
    stopEvery: () => undefined,
  })
  // Let the boot finish.
  await fremdev.patternsChanged()
  const later = async () => {
    clock += 1_000
    while (timers.length) timers.shift()!()
    await Promise.resolve()
  }
  return { fremdev, api, store, sent, wantSocket, later }
}

describe('companion/fremdev.js', () => {
  it('rebuilds a page event from its kind and text alone', () => {
    expect(pageEvent({ kind: 'error', text: 'a'.repeat(500), tabId: 3 })).toEqual({ kind: 'error', text: 'a'.repeat(300) })
    expect(pageEvent({ kind: 'count', n: 5, tabId: 3 })).toEqual({ kind: 'count', n: 5 })
    expect(pageEvent({ kind: 'count', n: -1 })).toBeNull()
    expect(pageEvent({ kind: 'count', n: 1.5 })).toBeNull()
    expect(pageEvent({ kind: 'down' })).toEqual({ kind: 'server', state: 'down' })
    expect(pageEvent({ kind: 'navigated', url: 'http://evil.example.com/' })).toBeNull()
    expect(pageEvent({ kind: 'clear' })).toBeNull()
  })

  it('takes a dev event only from its own content script in the top frame of a dev tab', async () => {
    const f = await makeFremdev()
    const refused = [
      devSender({ id: 'other-extension' }),
      devSender({ frameId: 3 }),
      devSender({ tab: undefined }),
      devSender({ tab: { id: 7, url: 'https://www.example.com/' } }),
      devSender({ url: 'https://www.example.com/' }),
      devSender({ tab: { id: -1, url: 'http://localhost:5173/' } }),
      devSender({ tab: { id: 7, url: 'http://127.0.0.1:4242/admin' }, url: 'http://127.0.0.1:4242/admin' }),
    ]
    for (const sender of refused) await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, sender)
    expect(f.store.session.devTabs ?? {}).toEqual({})
    await f.fremdev.onPageEvent({ kind: 'error', text: 'boom', tabId: 99 }, devSender())
    await f.fremdev.onPageEvent({ kind: 'count', n: 40 }, devSender())
    await f.later()
    const rows = f.store.session.devTabs as Record<string, { tabId: number; errors: { total: number; last: { text: string } } }>
    expect(Object.keys(rows)).toEqual(['7'])
    expect(rows['7'].errors.total).toBe(41)
    expect(rows['7'].errors.last.text).toBe('boom')
  })

  it('sends nothing Fremdev until the server said it speaks it, then the rows and the module', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await f.later()
    expect(f.sent).toEqual([])
    expect(f.fremdev.active()).toBe(true)
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true } })
    await f.later()
    expect(f.sent).toEqual([])
    // An older Fremkit: Fremdev no longer wants the socket.
    expect(f.fremdev.active()).toBe(false)
    expect(f.store.session.fremdevSupport).toBe('unsupported')
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.later()
    expect(f.sent.map((m) => m.type)).toEqual(['dev.tabs'])
    expect((f.sent[0].tabs as Array<{ tabId: number }>).map((t) => t.tabId)).toEqual([7])
    expect(f.fremdev.modules()).toEqual(['fremplay', 'fremdev'])
    await f.fremdev.stop()
    expect(f.sent.at(-1)).toEqual({ type: 'modules', modules: ['fremplay'] })
    expect(f.store.session.devTabs).toEqual({})
    expect(f.fremdev.active()).toBe(false)
  })

  it('focuses and clears only a tab it has a row for', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await f.fremdev.onServer({ type: 'dev.focus', tabId: 8 })
    await f.fremdev.onServer({ type: 'dev.focus', tabId: -1 })
    expect(f.api.tabs.update).not.toHaveBeenCalled()
    await f.fremdev.onServer({ type: 'dev.focus', tabId: 7 })
    expect(f.api.tabs.update).toHaveBeenCalledWith(7, { active: true })
    expect(f.api.windows.update).toHaveBeenCalledWith(1, { focused: true })
    await f.fremdev.onServer({ type: 'dev.clear', tabId: 7 })
    await f.later()
    expect((f.store.session.devTabs as Record<string, { errors: { total: number } }>)['7'].errors.total).toBe(0)
  })

  it('counts a failed request of a watched tab by its path, and leaves the noise and other tabs out', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'hot' }, devSender())
    const [onCompleted] = f.api.webRequest.onCompleted.addListener.mock.calls[0]
    const [onFailed] = f.api.webRequest.onErrorOccurred.addListener.mock.calls[0]
    onCompleted({ tabId: 7, url: 'http://localhost:5173/api/x?token=secret#frag', statusCode: 500, type: 'xmlhttprequest' })
    onCompleted({ tabId: 7, url: 'http://localhost:5173/ok', statusCode: 200, type: 'xmlhttprequest' })
    onCompleted({ tabId: 8, url: 'http://localhost:5173/api/x', statusCode: 500, type: 'xmlhttprequest' })
    onCompleted({ tabId: 7, url: 'http://localhost:5173/favicon.ico', statusCode: 404, type: 'image' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/api/y', error: 'net::ERR_ABORTED', type: 'fetch' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/api/z', error: 'net::ERR_FAILED', type: 'fetch' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/', error: 'net::ERR_CONNECTION_REFUSED', type: 'main_frame' })
    await new Promise((r) => setTimeout(r, 0))
    await f.later()
    const row = (f.store.session.devTabs as Record<string, { requests: { total: number; last: { path: string; status: number } } }>)['7']
    expect(row.requests.total).toBe(2)
    expect(row.requests.last).toMatchObject({ path: '/api/z', status: 0 })
  })

  it('marks the dev server down when the top frame cannot reach it', async () => {
    const f = await makeFremdev()
    const [onNavError] = f.api.webNavigation.onErrorOccurred.addListener.mock.calls[0]
    await onNavError({ tabId: 7, frameId: 0, url: 'http://localhost:5173/', error: 'net::ERR_CONNECTION_REFUSED' })
    await onNavError({ tabId: 9, frameId: 0, url: 'https://www.example.com/', error: 'net::ERR_CONNECTION_REFUSED' })
    await f.later()
    const rows = f.store.session.devTabs as Record<string, { server: string }>
    expect(Object.keys(rows)).toEqual(['7'])
    expect(rows['7'].server).toBe('down')
  })

  it('off, it registers nothing and keeps no row', async () => {
    const f = await makeFremdev({ on: false })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    expect(f.api.scripting.registerContentScripts).not.toHaveBeenCalled()
    expect(f.fremdev.active()).toBe(false)
    expect(f.fremdev.modules()).toEqual(['fremplay'])
    await f.fremdev.start()
    const scripts = f.api.scripting.registerContentScripts.mock.calls[0][0] as Array<{ id: string; world?: string; matches: string[] }>
    expect(scripts.map((s) => [s.id, s.world, s.matches])).toEqual([
      ['fremdev-relay', undefined, ['http://localhost/*']],
      ['fremdev-hook', 'MAIN', ['http://localhost/*']],
    ])
    expect(f.api.scripting.executeScript).toHaveBeenCalledTimes(2)
    expect(f.store.local.fremdev).toMatchObject({ on: true })
  })
})
