import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { linkAlarm, onlyFremdev, PROBE_MISSES, PROBE_SLOW_MS, ProbeBackoff, ReconnectGate } from '../../companion/lib/presence.js'
// @ts-expect-error plain JS module
import { createFremdev, pageEvent } from '../../companion/fremdev.js'
// @ts-expect-error plain JS module
import { BUILTIN_PERMISSION_ORIGINS } from '../../companion/lib/devhosts.js'
// @ts-expect-error plain JS module
import { reduce } from '../../companion/lib/devtabs.js'

// The reducer, watched: the events the worker hands it carry fields no row keeps yet.
vi.mock('../../companion/lib/devtabs.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, reduce: vi.fn(actual.reduce as (...a: unknown[]) => unknown) }
})

// companion/fremdev.js against a fake chrome.*, and the worker's reconnection policy for it.

const ROOT = join(import.meta.dirname, '..', '..', 'companion')
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8')

describe('the worker reconnection policy for Fremdev', () => {
  it('is quiet only when nothing but Fremdev wants the socket', () => {
    expect(onlyFremdev(null, 0, 1000)).toBe(true)
    expect(onlyFremdev({ sessionId: 's' }, 0, 1000)).toBe(false)
    expect(onlyFremdev(null, 2000, 1000)).toBe(false)
  })

  it('lets one reconnection through per window, however many events ask', () => {
    const gate = new ReconnectGate(15_000)
    const passed = [0, 1, 500, 14_999, 15_000, 15_001, 29_999, 30_000].map((t) => gate.allow(t))
    expect(passed).toEqual([true, false, false, false, true, false, false, true])
  })

  it('slows its probes to one per 5 minutes after 3 answers that Fremdev is unsupported or off', () => {
    expect(PROBE_MISSES).toBe(3)
    expect(PROBE_SLOW_MS).toBe(300_000)
    const b = new ProbeBackoff()
    let t = 0
    for (const answer of ['unsupported', 'disabled']) {
      expect(b.allow(t)).toBe(true)
      b.probed(t)
      b.heard(answer)
      t += 15_000
    }
    // A server that does not answer is no answer: still the third probe at the 15 s pace.
    b.heard(null)
    expect(b.allow(t)).toBe(true)
    b.probed(t)
    b.heard('unsupported')
    const third = t
    expect(b.allow(third + 15_000)).toBe(false)
    expect(b.allow(third + PROBE_SLOW_MS - 1)).toBe(false)
    expect(b.allow(third + PROBE_SLOW_MS)).toBe(true)
    b.probed(third + PROBE_SLOW_MS)
    b.heard('disabled')
    expect(b.allow(third + PROBE_SLOW_MS + 15_000)).toBe(false)
    // The popup opened: back to the fast pace.
    b.reset()
    expect(b.allow(third + PROBE_SLOW_MS + 15_000)).toBe(true)
    // A yes starts over too.
    for (let i = 0; i < 3; i++) {
      b.probed(third + PROBE_SLOW_MS + 30_000)
      b.heard('unsupported')
    }
    expect(b.allow(third + PROBE_SLOW_MS + 30_000)).toBe(false)
    b.heard('yes')
    expect(b.allow(third + PROBE_SLOW_MS + 30_000)).toBe(true)
  })

  it('worker.js probes through the backoff, and hears every ready', () => {
    const worker = source('worker.js')
    const wants = worker.slice(worker.indexOf('function fremdevWantsSocket('), worker.indexOf('const fremdev = createFremdev('))
    expect(wants).toMatch(/if \(probe && !fremdevProbe\.allow\(now\)\) return\n\s+if \(!fremdevGate\.allow\(now\)\) return\n\s+if \(probe\) fremdevProbe\.probed\(now\)\n\s+connect\(\)/)
    expect(worker).toContain('fremdevProbe.heard(fremdevSupport(msg))')
    const open = worker.slice(worker.indexOf("case 'open':"), worker.indexOf("case 'pair':"))
    expect(open).toContain('fremdevProbe.reset()')
  })

  it('worker.js tells Fremdev of a ready before any await, and of every socket that closes', () => {
    const worker = source('worker.js')
    const ready = worker.slice(worker.indexOf("case 'ready':"), worker.indexOf("case 'tab.accepted':"))
    expect(ready).toMatch(/^case 'ready':\n\s+greeted = true\n(\s+\/\/.*\n)+\s+fremdevProbe\.heard\(fremdevSupport\(msg\)\)\n\s+fremdev\.onReady\(msg\)\n/)
    expect(ready.match(/fremdev\.onReady/g)).toHaveLength(1)
    expect(ready.indexOf('fremdev.onReady')).toBeLessThan(ready.indexOf('if (local.revoked) await'))
    // Each place that lets go of a socket.
    const onclose = worker.slice(worker.indexOf('socket.onclose = '), worker.indexOf('function impostor('))
    expect(onclose).toContain('fremdev.socketClosed()')
    const impostor = worker.slice(worker.indexOf('function impostor('), worker.indexOf('function retry('))
    expect(impostor).toContain('fremdev.socketClosed()')
    const close = worker.slice(worker.indexOf('function closeSocket('), worker.indexOf('function reconnectNow('))
    expect(close).toContain('fremdev.socketClosed()')
  })

  it("keeps off the badge only an unreachable that Fremdev's own attempts met", () => {
    expect(linkAlarm({ link: 'unreachable', share: null, linkQuiet: false })).toBe(true)
    expect(linkAlarm({ link: 'unreachable', share: null, linkQuiet: true })).toBe(false)
    expect(linkAlarm({ link: 'unreachable', share: { sessionId: 's' }, linkQuiet: false })).toBe(false)
    // Facts always show, whoever met them.
    for (const link of ['revoked', 'refused', 'impostor']) expect(linkAlarm({ link, share: null, linkQuiet: true }), link).toBe(true)
    for (const link of ['ok', 'connecting', 'unpaired']) expect(linkAlarm({ link, share: null, linkQuiet: false }), link).toBe(false)
  })

  it("worker.js judges an attempt's quietness once, softens only connecting and unreachable", () => {
    const worker = source('worker.js')
    expect(worker).toMatch(/if \(!fremdevGate\.allow\(now\)\) return/)
    expect(worker).toMatch(/if \(!wanted\(\) \|\| quiet\(\)\) \{/)
    const connect = worker.slice(worker.indexOf('function connect() {'), worker.indexOf('function impostor('))
    expect(connect).toMatch(/const quietAttempt = quiet\(\)\n\s+if \(!quietAttempt && /)
    expect(connect).toContain("setLink('unreachable', { quietBadge: quietAttempt })")
    // Greeted, then gone, with only Fremdev holding on: the link says so at once, quietly.
    expect(connect).toContain("if (quiet()) setLink('unreachable', { quietBadge: true })")
    // The facts are recorded whoever asked: no quiet() guard left before them.
    for (const call of ["setLink('impostor')", "await setLink('refused')"]) {
      const at = worker.indexOf(call)
      expect(at, call).toBeGreaterThan(0)
      expect(worker.slice(at - 15, at), call).not.toContain('quiet()')
    }
    const removed = worker.slice(worker.indexOf('async function removed() {'), worker.indexOf('/** No server for a minute'))
    expect(removed).not.toContain('quiet()')
    expect(worker).toContain('const bang = linkAlarm(session)')
  })
})

/** A chrome.* just wide enough for fremdev.js. */
function fakeChrome({ on = true, granted = ['http://localhost/*'], webRequest = true } = {}) {
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
  const grants = { origins: [...granted], permissions: webRequest ? ['webRequest'] : ([] as string[]) }
  const api: Record<string, any> = {
    runtime: { id: 'ext' },
    storage: { local: area(store.local), session: area(store.session) },
    permissions: {
      contains: async ({ origins = [], permissions = [] }: { origins?: string[]; permissions?: string[] }) =>
        origins.every((o) => grants.origins.includes(o)) && permissions.every((p) => grants.permissions.includes(p)),
      onAdded: event(),
      onRemoved: event(),
    },
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
  }
  if (webRequest) api.webRequest = { onCompleted: event(), onErrorOccurred: event() }
  return { api, store, grants, event }
}

const devSender = (over: Record<string, unknown> = {}) => ({
  id: 'ext',
  frameId: 0,
  url: 'http://localhost:5173/',
  tab: { id: 7, url: 'http://localhost:5173/', title: 'App' },
  ...over,
})

async function makeFremdev(opts?: Parameters<typeof fakeChrome>[0]) {
  const { api, store, grants, event } = fakeChrome(opts)
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
  // Let the boot finish (a command for no tab waits for it and does nothing).
  await fremdev.onServer({ type: 'none' })
  const later = async () => {
    clock += 1_000
    await new Promise((r) => setTimeout(r, 0))
    while (timers.length) timers.shift()!()
    await Promise.resolve()
  }
  const rows = () => (f.store.session.devTabs ?? {}) as Record<string, any>
  const f = { fremdev, api, store, grants, event, sent, wantSocket, later, rows }
  return f
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

  it("keeps an error's origin and stack within bounds, and drops what is not one", () => {
    expect(pageEvent({ kind: 'error', text: 't', origin: 'o', stack: ['a'] })).toEqual({ kind: 'error', text: 't', origin: 'o', stack: ['a'] })
    expect(pageEvent({ kind: 'error', text: 't', origin: 7, stack: 'a' })).toEqual({ kind: 'error', text: 't' })
    expect(pageEvent({ kind: 'error', text: 't', stack: ['a', 1] })).toEqual({ kind: 'error', text: 't' })
    const big = pageEvent({ kind: 'error', text: 't', origin: 'o'.repeat(400), stack: Array.from({ length: 15 }, () => 's'.repeat(400)) })
    expect(big.origin).toHaveLength(300)
    expect(big.stack.length).toBeLessThanOrEqual(10)
    expect(big.stack.every((f: string) => f.length <= 300)).toBe(true)
    expect(big.stack.join('\n').length).toBeLessThanOrEqual(2000)
  })

  it('takes a dev event only from its own content script in the top frame of a granted dev tab', async () => {
    const f = await makeFremdev()
    const refused = [
      devSender({ id: 'other-extension' }),
      devSender({ frameId: 3 }),
      devSender({ tab: undefined }),
      devSender({ tab: { id: 7, url: 'https://www.example.com/' } }),
      devSender({ url: 'https://www.example.com/' }),
      devSender({ tab: { id: -1, url: 'http://localhost:5173/' } }),
      devSender({ tab: { id: 7, url: 'http://127.0.0.1:4242/admin' }, url: 'http://127.0.0.1:4242/admin' }),
      // A dev URL, but not inside what the user granted (http://localhost/* only).
      devSender({ tab: { id: 7, url: 'http://foo.test/' }, url: 'http://foo.test/' }),
    ]
    for (const sender of refused) await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, sender)
    await f.later()
    expect(f.rows()).toEqual({})
    await f.fremdev.onPageEvent({ kind: 'error', text: 'boom', tabId: 99 }, devSender())
    await f.fremdev.onPageEvent({ kind: 'count', n: 40 }, devSender())
    await f.later()
    expect(Object.keys(f.rows())).toEqual(['7'])
    expect(f.rows()['7'].errors.total).toBe(41)
    expect(f.rows()['7'].errors.last.text).toBe('boom')
  })

  it('drops the rows a taken-back permission leaves outside', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await f.later()
    expect(Object.keys(f.rows())).toEqual(['7'])
    f.grants.origins = []
    const [onRemoved] = f.api.permissions.onRemoved.addListener.mock.calls[0]
    await onRemoved({ origins: ['http://localhost/*'] })
    await f.later()
    expect(f.rows()).toEqual({})
  })

  it('sends nothing Fremdev until the server said it speaks it, then the module before the rows', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await f.later()
    expect(f.sent).toEqual([])
    expect(f.fremdev.active()).toBe(true)
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true } })
    await f.later()
    expect(f.sent).toEqual([])
    // An older Fremkit: Fremdev no longer wants the socket, and a dev event asks to look again.
    expect(f.fremdev.active()).toBe(false)
    expect(f.store.session.fremdevSupport).toBe('unsupported')
    f.wantSocket.mockClear()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'y' }, devSender())
    expect(f.wantSocket).toHaveBeenCalledWith({ relearn: true })
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.later()
    expect(f.sent.map((m) => m.type)).toEqual(['modules', 'dev.tabs'])
    expect(f.sent[0]).toEqual({ type: 'modules', modules: ['fremplay', 'fremdev'] })
    expect((f.sent[1].tabs as Array<{ tabId: number }>).map((t) => t.tabId)).toEqual([7])
    await f.fremdev.stop()
    expect(f.sent.at(-1)).toEqual({ type: 'modules', modules: ['fremplay'] })
    expect(f.store.session.devTabs).toEqual({})
    expect(f.fremdev.active()).toBe(false)
  })

  it('sends nothing Fremdev between a socket closing and the next ready, on the old answer', async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await f.later()
    expect(f.sent.map((m) => m.type)).toEqual(['modules', 'dev.tabs'])
    f.sent.length = 0
    f.fremdev.socketClosed()
    // Still wanted: the last answer was yes, a socket is worth opening again.
    expect(f.fremdev.active()).toBe(true)
    expect(f.store.session.fremdevSupport).toBe('yes')
    await f.fremdev.onPageEvent({ kind: 'error', text: 'y' }, devSender())
    await f.later()
    await f.fremdev.stop()
    await f.fremdev.start()
    await f.later()
    expect(f.sent).toEqual([])
    // The next socket's Fremkit was downgraded: still nothing.
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true } })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'z' }, devSender())
    await f.later()
    expect(f.sent).toEqual([])
    f.fremdev.socketClosed()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'w' }, devSender())
    await f.later()
    expect(f.sent.map((m) => m.type)).toEqual(['modules', 'dev.tabs'])
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
    // Marked seen, not zeroed: the error is still open.
    expect(f.rows()['7'].errors).toMatchObject({ total: 1, open: 1, seen: 1 })
  })

  it('counts a failed request of a watched tab by its path, and leaves the noise and other tabs out', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'hot' }, devSender())
    const [onCompleted] = f.api.webRequest.onCompleted.addListener.mock.calls.at(-1)
    const [onFailed] = f.api.webRequest.onErrorOccurred.addListener.mock.calls.at(-1)
    onCompleted({ tabId: 7, url: 'http://localhost:5173/api/x?token=secret#frag', statusCode: 500, type: 'xmlhttprequest' })
    onCompleted({ tabId: 7, url: 'http://localhost:5173/ok', statusCode: 200, type: 'xmlhttprequest' })
    onCompleted({ tabId: 8, url: 'http://localhost:5173/api/x', statusCode: 500, type: 'xmlhttprequest' })
    onCompleted({ tabId: 7, url: 'http://localhost:5173/favicon.ico', statusCode: 404, type: 'image' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/api/y', error: 'net::ERR_ABORTED', type: 'fetch' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/api/z', error: 'net::ERR_FAILED', type: 'fetch' })
    await f.later()
    const row = f.rows()['7']
    expect(row.requests.total).toBe(2)
    expect(row.requests.last).toMatchObject({ path: '/api/z', status: 0 })
  })

  it("names a failed request's method from the closed list", async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'hot' }, devSender())
    const [onCompleted] = f.api.webRequest.onCompleted.addListener.mock.calls.at(-1)
    const [onFailed] = f.api.webRequest.onErrorOccurred.addListener.mock.calls.at(-1)
    vi.mocked(reduce).mockClear()
    onCompleted({ tabId: 7, url: 'http://localhost:5173/api/x', method: 'POST', statusCode: 500, type: 'xmlhttprequest' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/api/y', method: 'PROPFIND', error: 'net::ERR_FAILED', type: 'fetch' })
    await f.later()
    const requests = vi.mocked(reduce).mock.calls.map((c: unknown[]) => c[1]).filter((e: { kind: string }) => e.kind === 'request')
    expect(requests).toEqual([
      { kind: 'request', method: 'POST', path: '/api/x', status: 500 },
      { kind: 'request', method: 'OTHER', path: '/api/y', status: 0 },
    ])
  })

  it('counts only requests to dev hosts: not Fremkit, not another domain', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'hot' }, devSender())
    const [onCompleted] = f.api.webRequest.onCompleted.addListener.mock.calls.at(-1)
    onCompleted({ tabId: 7, url: 'http://127.0.0.1:4242/api', statusCode: 500, type: 'xmlhttprequest' })
    onCompleted({ tabId: 7, url: 'https://cdn.example.org/x', statusCode: 500, type: 'xmlhttprequest' })
    await f.later()
    expect(f.rows()['7'].requests.total).toBe(0)
    onCompleted({ tabId: 7, url: 'http://localhost:3000/api/own', statusCode: 500, type: 'xmlhttprequest' })
    await f.later()
    expect(f.rows()['7'].requests.total).toBe(1)
  })

  it("tells the dev server's state from the top frame's own load", async () => {
    const f = await makeFremdev()
    const [onCompleted] = f.api.webRequest.onCompleted.addListener.mock.calls.at(-1)
    const [onFailed] = f.api.webRequest.onErrorOccurred.addListener.mock.calls.at(-1)
    onFailed({ tabId: 7, frameId: 0, url: 'http://localhost:5173/', error: 'net::ERR_CONNECTION_REFUSED', type: 'main_frame' })
    onFailed({ tabId: 9, frameId: 0, url: 'https://www.example.com/', error: 'net::ERR_CONNECTION_REFUSED', type: 'main_frame' })
    await f.later()
    expect(Object.keys(f.rows())).toEqual(['7'])
    expect(f.rows()['7']).toMatchObject({ server: 'down', requests: { total: 0 } })
    onCompleted({ tabId: 7, frameId: 0, url: 'http://localhost:5173/', statusCode: 200, type: 'main_frame' })
    await f.later()
    expect(f.rows()['7'].server).toBe('up')
  })

  it('follows navigations and titles through tabs.onUpdated', async () => {
    const f = await makeFremdev()
    const [onUpdated] = f.api.tabs.onUpdated.addListener.mock.calls.at(-1)
    await onUpdated(7, { status: 'loading', url: 'http://localhost:5173/' }, { id: 7, url: 'http://localhost:5173/', title: '' })
    await onUpdated(7, { title: 'My app' }, { id: 7, url: 'http://localhost:5173/', title: 'My app' })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await onUpdated(7, { status: 'loading' }, { id: 7, url: 'http://localhost:5173/', title: 'My app' })
    await f.later()
    expect(f.rows()['7']).toMatchObject({ title: 'My app', errors: { total: 1, open: 0, seen: 0 } })
    await onUpdated(7, { status: 'loading', url: 'https://www.example.com/' }, { id: 7, url: 'https://www.example.com/' })
    await f.later()
    expect(f.rows()).toEqual({})
  })

  it('adds the request listeners when webRequest is granted after the start', async () => {
    const f = await makeFremdev({ webRequest: false })
    f.api.webRequest = { onCompleted: f.event(), onErrorOccurred: f.event() }
    const [onAdded] = f.api.permissions.onAdded.addListener.mock.calls[0]
    await onAdded({ permissions: ['webRequest'] })
    expect(f.api.webRequest.onCompleted.addListener).toHaveBeenCalledTimes(1)
  })

  it('turns itself on when the grant the popup expected lands after the popup closed', async () => {
    const f = await makeFremdev({ on: false, granted: [] })
    const [onAdded] = f.api.permissions.onAdded.addListener.mock.calls[0]
    f.fremdev.expectGrant()
    // A partial grant (webRequest alone) is not the one asked for.
    f.grants.permissions = ['webRequest']
    await onAdded({ permissions: ['webRequest'] })
    expect(f.store.local.fremdev).toMatchObject({ on: false })
    f.grants.origins = [...BUILTIN_PERMISSION_ORIGINS]
    await onAdded({ permissions: ['webRequest'], origins: BUILTIN_PERMISSION_ORIGINS })
    expect(f.store.local.fremdev).toMatchObject({ on: true })
    expect(f.api.scripting.registerContentScripts).toHaveBeenCalledTimes(1)
    // The popup survived and sends fremdevOn too: nothing starts twice.
    await f.fremdev.start()
    expect(f.api.scripting.registerContentScripts).toHaveBeenCalledTimes(1)
  })

  it('does not turn on for a grant nobody expected, or one that came too late', async () => {
    const f = await makeFremdev({ on: false, granted: [...BUILTIN_PERMISSION_ORIGINS] })
    const [onAdded] = f.api.permissions.onAdded.addListener.mock.calls[0]
    await onAdded({ permissions: ['webRequest'] })
    expect(f.store.local.fremdev).toMatchObject({ on: false })
    f.fremdev.expectGrant()
    for (let i = 0; i < 61; i++) await f.later()
    await onAdded({ permissions: ['webRequest'] })
    expect(f.store.local.fremdev).toMatchObject({ on: false })
    expect(f.api.scripting.registerContentScripts).not.toHaveBeenCalled()
  })

  it('starts once when two starts race', async () => {
    const f = await makeFremdev({ on: false })
    await Promise.all([f.fremdev.start(), f.fremdev.start()])
    expect(f.api.scripting.registerContentScripts).toHaveBeenCalledTimes(1)
    expect(f.api.scripting.executeScript).toHaveBeenCalledTimes(2)
  })

  it('off, it registers nothing and keeps no row', async () => {
    const f = await makeFremdev({ on: false })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    expect(f.api.scripting.registerContentScripts).not.toHaveBeenCalled()
    expect(f.fremdev.active()).toBe(false)
    expect(f.fremdev.modules()).toEqual(['fremplay'])
    expect(f.api.webRequest.onCompleted.removeListener).toHaveBeenCalled()
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
