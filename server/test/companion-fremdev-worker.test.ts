import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { linkAlarm, onlyFremdev, PROBE_MISSES, PROBE_SLOW_MS, ProbeBackoff, ReconnectGate } from '../../companion/lib/presence.js'
// @ts-expect-error plain JS module
import { createFremdev, FEATURE_MODULES, ISOLATED_JS, pageEvent } from '../../companion/fremdev.js'
// @ts-expect-error plain JS module
import { BUILTIN_PERMISSION_ORIGINS } from '../../companion/lib/devhosts.js'

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
    runtime: { id: 'ext', onInstalled: event() },
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
      reload: vi.fn(async () => undefined),
      onRemoved: event(),
      onUpdated: event(),
    },
    windows: { update: vi.fn(async () => undefined) },
  }
  if (webRequest) api.webRequest = { onBeforeRequest: event(), onCompleted: event(), onErrorOccurred: event() }
  return { api, store, grants, event }
}

const devSender = (over: Record<string, unknown> = {}) => ({
  id: 'ext',
  frameId: 0,
  url: 'http://localhost:5173/',
  documentId: 'DOC0',
  tab: { id: 7, url: 'http://localhost:5173/', title: 'App' },
  ...over,
})

async function makeFremdev(opts?: Parameters<typeof fakeChrome>[0], extra: { fetch?: (...args: unknown[]) => Promise<unknown> } = {}) {
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
    ...(extra.fetch ? { fetch: extra.fetch } : {}),
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

  it('rebuilds a build event from bounded fields, and drops one with a field that is not one', () => {
    expect(pageEvent({ kind: 'build', text: 'x'.repeat(500), file: '/Users/example/app/src/App.vue', line: 12, col: 3, tabId: 3 }))
      .toEqual({ kind: 'build', text: 'x'.repeat(300), file: '/Users/example/app/src/App.vue', line: 12, col: 3 })
    expect(pageEvent({ kind: 'build', text: 'x' })).toEqual({ kind: 'build', text: 'x' })
    expect(pageEvent({ kind: 'build', text: 'x', file: './src/index.js', line: 10_000_000 })).toEqual({ kind: 'build', text: 'x', file: './src/index.js', line: 10_000_000 })
    for (const bad of [
      { file: 7 },
      { file: ['a'] },
      { file: 'a'.repeat(1025) },
      { line: 0 },
      { line: 1.5 },
      { col: 10_000_001 },
      { line: '12' },
      { text: 7 },
    ]) expect(pageEvent({ kind: 'build', text: 'x', ...bad }), JSON.stringify(bad)).toBeNull()
    expect(pageEvent({ kind: 'build-clear', text: 'ignored', tabId: 3 })).toEqual({ kind: 'build-clear' })
  })

  it("bounds a build event's code frame and stack, and drops one that is not a list of strings", () => {
    expect(pageEvent({ kind: 'build', text: 'x', frame: ['1 | a', '  | ^'], stack: ['at f (/a.js:1:2)'] }))
      .toEqual({ kind: 'build', text: 'x', frame: ['1 | a', '  | ^'], stack: ['at f (/a.js:1:2)'] })
    expect(pageEvent({ kind: 'build', text: 'x', frame: [], stack: [] })).toEqual({ kind: 'build', text: 'x' })
    const big = pageEvent({ kind: 'build', text: 'x', frame: Array.from({ length: 40 }, () => 'f'.repeat(400)), stack: Array.from({ length: 40 }, () => 's'.repeat(400)) })
    expect(big.frame.length).toBeLessThanOrEqual(20)
    expect([...big.frame, ...(big.stack ?? [])].every((l: string) => l.length <= 300)).toBe(true)
    expect([...big.frame, ...(big.stack ?? [])].join('\n').length).toBeLessThanOrEqual(6000)
    const long = pageEvent({ kind: 'build', text: 'x', stack: Array.from({ length: 40 }, (_, i) => `at f${i}`) })
    expect(long.stack).toHaveLength(30)
    for (const bad of [{ frame: 'a' }, { frame: ['a', 1] }, { stack: { 0: 'a', length: 1 } }, { stack: [null] }]) {
      expect(pageEvent({ kind: 'build', text: 'x', ...bad }), JSON.stringify(bad)).toBeNull()
    }
  })

  it('rebuilds a devserver event from a known kind and a bounded base', () => {
    expect(pageEvent({ kind: 'devserver', server: 'vite', base: '/app/', tabId: 3 })).toEqual({ kind: 'devserver', server: 'vite', base: '/app/' })
    expect(pageEvent({ kind: 'devserver', server: 'next', base: '/' })).toEqual({ kind: 'devserver', server: 'next', base: '/' })
    expect(pageEvent({ kind: 'devserver', server: 'webpack', base: '/' })).toEqual({ kind: 'devserver', server: 'webpack', base: '/' })
    // The page's kind is unknown (an unusable Vite base): rebuilt without a base, whatever came with it.
    expect(pageEvent({ kind: 'devserver', server: null })).toEqual({ kind: 'devserver', server: null })
    expect(pageEvent({ kind: 'devserver', server: null, base: '//evil/' })).toEqual({ kind: 'devserver', server: null })
    for (const bad of [
      { server: 'vite', base: '//evil' },
      { server: 'vite', base: '//evil/' },
      { server: 'vite', base: '/a//b/' },
      { server: 'vite', base: '/../' },
      { server: 'vite', base: '/app' },
      { server: 'vite', base: 'app/' },
      { server: 'vite', base: '/a?b/' },
      { server: 'vite', base: `/${'a'.repeat(100)}/` },
      { server: 'vite' },
      { server: 'next', base: '/app/' },
      { server: 'webpack', base: '/x/' },
      { server: 'parcel', base: '/' },
    ]) expect(pageEvent({ kind: 'devserver', ...bad }), JSON.stringify(bad)).toBeNull()
  })

  it("keeps an error's origin and stack within bounds, and drops what is not one", () => {
    expect(pageEvent({ kind: 'error', text: 't', origin: 'o', stack: ['a'] })).toEqual({ kind: 'error', text: 't', origin: 'o', stack: ['a'] })
    expect(pageEvent({ kind: 'error', text: 't', origin: 7, stack: 'a' })).toEqual({ kind: 'error', text: 't' })
    expect(pageEvent({ kind: 'error', text: 't', stack: ['a', 1] })).toEqual({ kind: 'error', text: 't' })
    const big = pageEvent({ kind: 'error', text: 't', origin: 'o'.repeat(400), stack: Array.from({ length: 40 }, () => 's'.repeat(400)) })
    expect(big.origin).toHaveLength(300)
    expect(big.stack.length).toBeLessThanOrEqual(30)
    expect(big.stack.every((f: string) => f.length <= 300)).toBe(true)
    expect(big.stack.join('\n').length).toBeLessThanOrEqual(6000)
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
    expect(f.sent[0]).toEqual({ type: 'modules', modules: ['fremplay', 'fremdev', 'fremdev.report', 'fremdev.build', 'fremdev.open', 'fremdev.reload', 'fremdev.slow', 'fremdev.perf', 'fremdev.shot', 'fremdev.shotview'] })
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

  it('reloads only a tab it has a row for, skipping the cache only when told to', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    await f.fremdev.onServer({ type: 'dev.reload', tabId: 8, bypassCache: true })
    expect(f.api.tabs.reload).not.toHaveBeenCalled()
    await f.fremdev.onServer({ type: 'dev.reload', tabId: 7, bypassCache: true })
    expect(f.api.tabs.reload).toHaveBeenLastCalledWith(7, { bypassCache: true })
    await f.fremdev.onServer({ type: 'dev.reload', tabId: 7, bypassCache: 'yes' })
    expect(f.api.tabs.reload).toHaveBeenLastCalledWith(7, { bypassCache: false })
    // A tab that went away between the ask and the reload is no error.
    f.api.tabs.reload.mockRejectedValueOnce(new Error('No tab with id: 7'))
    await expect(f.fremdev.onServer({ type: 'dev.reload', tabId: 7, bypassCache: false })).resolves.toBeUndefined()
  })

  it('announces its feature modules after fremdev.report, only while on', async () => {
    FEATURE_MODULES.push('fremdev.test')
    try {
      const f = await makeFremdev({ on: false })
      expect(f.fremdev.modules()).toEqual(['fremplay'])
      await f.fremdev.start()
      expect(f.fremdev.modules()).toEqual(['fremplay', 'fremdev', 'fremdev.report', 'fremdev.build', 'fremdev.open', 'fremdev.reload', 'fremdev.slow', 'fremdev.perf', 'fremdev.shot', 'fremdev.shotview', 'fremdev.test'])
    } finally {
      FEATURE_MODULES.pop()
    }
    expect(FEATURE_MODULES).toEqual(['fremdev.build', 'fremdev.open', 'fremdev.reload', 'fremdev.slow', 'fremdev.perf', 'fremdev.shot', 'fremdev.shotview'])
  })

  it('records the dev server a page reports, the latest replacing the last', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'devserver', server: 'vite', base: '//evil/' }, devSender())
    await f.later()
    expect(f.rows()).toEqual({})
    await f.fremdev.onPageEvent({ kind: 'devserver', server: 'vite', base: '/app/' }, devSender())
    await f.later()
    expect(f.rows()['7']).toMatchObject({ devServer: 'vite', serverBase: '/app/' })
    await f.fremdev.onPageEvent({ kind: 'devserver', server: 'next', base: '/' }, devSender())
    await f.later()
    expect(f.rows()['7']).toMatchObject({ devServer: 'next', serverBase: '/' })
    await f.fremdev.onPageEvent({ kind: 'devserver', server: 'vite', base: '/app/' }, devSender())
    await f.fremdev.onPageEvent({ kind: 'devserver', server: null }, devSender())
    await f.later()
    expect(f.rows()['7']).toMatchObject({ devServer: null, serverBase: '/' })
  })

  it('records a build error a page reports, and resolves it when the overlay goes', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'build', text: 'Invalid end tag.', file: '/Users/example/app/src/App.vue', line: 12, col: 3 }, devSender())
    await f.fremdev.onPageEvent({ kind: 'build', text: 'Invalid end tag.', file: '/Users/example/app/src/App.vue', line: 12, col: 3 }, devSender())
    await f.later()
    expect(f.rows()['7'].history).toEqual([expect.objectContaining({ kind: 'build', path: '/Users/example/app/src/App.vue', state: 'open' })])
    expect(f.rows()['7'].errors).toMatchObject({ total: 1, open: 1 })
    await f.fremdev.onPageEvent({ kind: 'build-clear' }, devSender())
    await f.later()
    expect(f.rows()['7'].history[0].state).toBe('resolved')
    expect(f.rows()['7'].errors).toMatchObject({ total: 1, open: 0 })
  })

  it("counts webpack-dev-server's console lines for a broken build as the one build entry, and drops its status lines", async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    // What the client logged on 18081 when the build broke with the page open, in that order.
    const logged = [
      '[webpack-dev-server] Errors while compiling. Reload prevented.',
      "[webpack-dev-server] ERROR in ./src/index.js 4:15\nModule parse failed: Unexpected token (4:15)\nFile was parsed as module type 'javascript/auto'.\nYou may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders\n  3 | mountPanel()\n> 4 | const broken = ;\n    |                ^\n  5 | ",
    ]
    // The page's event stays an error: the tab's reducer, which knows its dev server, tells.
    expect(pageEvent({ kind: 'error', text: logged[0] })).toEqual({ kind: 'error', text: logged[0] })
    // A page's own build event never says it came from the console.
    expect(pageEvent({ kind: 'build', text: 'x', fromConsole: true })).toEqual({ kind: 'build', text: 'x' })
    for (const text of logged) await f.fremdev.onPageEvent({ kind: 'error', text: text.slice(0, 300) }, devSender())
    await f.fremdev.onPageEvent({
      kind: 'build', file: './src/index.js', line: 4, col: 16, frame: ['> 4 | const broken = ;'],
      text: "Module parse failed: Unexpected token (4:15) File was parsed as module type 'javascript/auto'. You may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders",
    }, devSender())
    await f.later()
    const row = f.rows()['7']
    expect(row.history.map((e: { kind: string }) => e.kind)).toEqual(['build'])
    expect(row.errors).toMatchObject({ total: 1, open: 1 })
    const report = await f.fremdev.report(7, true) as string
    expect(report).toContain('### reportBuild')
    expect(report).not.toContain('### reportErrors')
    expect(report).not.toContain('Reload prevented')
    await f.fremdev.onPageEvent({ kind: 'build-clear' }, devSender())
    await f.later()
    expect(f.rows()['7'].history[0].state).toBe('resolved')
    expect(f.rows()['7'].errors).toMatchObject({ total: 1, open: 0 })
  })

  it("keeps a build entry's code frame and stack for the report with its stack, never in dev.tabs or the session copy", async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.fremdev.onPageEvent({
      kind: 'build', text: '[vue/compiler-sfc] Unexpected token (3:15)', file: '/Users/example/app/src/App.vue', line: 3, col: 15,
      frame: ['3  |  const broken = 1 +* 2', '   |                ^'], stack: ['at Parser.raise (/Users/example/app/node_modules/p.js:1:2)'],
    }, devSender())
    await f.later()
    expect(JSON.stringify(f.sent)).toContain('Unexpected token')
    expect(JSON.stringify(f.sent)).not.toContain('broken')
    expect(JSON.stringify(f.sent)).not.toContain('Parser.raise')
    expect(JSON.stringify(f.store.session)).not.toContain('broken')
    expect(JSON.stringify(f.store.session)).not.toContain('Parser.raise')
    const withStack = await f.fremdev.report(7, true)
    expect(withStack).toContain('  at ~/app/src/App.vue:3:15\n  ```\n  3  |  const broken = 1 +* 2\n     |                ^\n  at Parser.raise (~/app/node_modules/p.js:1:2)\n  ```')
    const plain = await f.fremdev.report(7, false)
    expect(plain).toContain('Unexpected token (3:15)')
    expect(plain).not.toContain('broken')
    // The same error with only its frame moved: no row goes out again, the report reads the new frame.
    const before = f.sent.length
    await f.fremdev.onPageEvent({
      kind: 'build', text: '[vue/compiler-sfc] Unexpected token (3:15)', file: '/Users/example/app/src/App.vue', line: 3, col: 15,
      frame: ['4  |  const broken = 1 +* 2'], stack: ['at Parser.raise (/Users/example/app/node_modules/p.js:1:2)'],
    }, devSender())
    await f.later()
    expect(f.sent.length).toBe(before)
    expect(await f.fremdev.report(7, true)).toContain('  4  |  const broken = 1 +* 2')
    // A moved line does go out.
    await f.fremdev.onPageEvent({ kind: 'build', text: '[vue/compiler-sfc] Unexpected token (3:15)', file: '/Users/example/app/src/App.vue', line: 4, col: 15 }, devSender())
    await f.later()
    expect(f.sent.length).toBeGreaterThan(before)
  })

  it('announces fremdev.report only while on', async () => {
    const f = await makeFremdev({ on: false })
    expect(f.fremdev.modules()).toEqual(['fremplay'])
    await f.fremdev.start()
    expect(f.fremdev.modules()).toEqual(['fremplay', 'fremdev', 'fremdev.report', 'fremdev.build', 'fremdev.open', 'fremdev.reload', 'fremdev.slow', 'fremdev.perf', 'fremdev.shot', 'fremdev.shotview'])
    await f.fremdev.stop()
    expect(f.fremdev.modules()).not.toContain('fremdev.report')
    expect(f.fremdev.modules()).not.toContain('fremdev.build')
    expect(f.fremdev.modules()).not.toContain('fremdev.open')
  })

  it('answers dev.report.ask with the report of a tab it has a row for, and nothing for another', async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'boom', origin: '/src/a.js:1:2', stack: ['f /src/a.js:1:2', 'g /src/b.js:3:4'] }, devSender())
    await f.later()
    f.sent.length = 0
    const id = '6f1c2a5e-8f0b-4c1d-9a3e-2b7d4e5f6a7b'
    await f.fremdev.onServer({ type: 'dev.report.ask', id, tabId: 8, stack: true })
    await f.fremdev.onServer({ type: 'dev.report.ask', id: 'not-an-id', tabId: 7, stack: true })
    expect(f.sent).toEqual([])
    await f.fremdev.onServer({ type: 'dev.report.ask', id, tabId: 7, stack: true })
    expect(f.sent).toEqual([{ type: 'dev.report', id, tabId: 7, text: expect.stringContaining('boom') }])
    const text = f.sent[0].text as string
    expect(text).toContain('/src/a.js:1:2')
    expect(text).toContain('g /src/b.js:3:4')
    await f.fremdev.onServer({ type: 'dev.report.ask', id, tabId: 7, stack: false })
    expect(f.sent[1].text).not.toContain('g /src/b.js:3:4')
    // The popup's copy: the same report, or nothing for a tab with no row.
    expect(await f.fremdev.report(7, true)).toBe(text)
    expect(await f.fremdev.report(8, true)).toBeNull()
  })

  it('keeps stacks out of the session copy, and a restarted worker gets its rows back without them', async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'boom', origin: '/src/a.js:1:2', stack: ['f /src/a.js:1:2', 'g /src/b.js:3:4'] }, devSender())
    await f.later()
    const saved = f.rows()['7']
    expect(saved.history).toHaveLength(1)
    expect(saved.history[0]).toMatchObject({ kind: 'error', text: 'boom', origin: '/src/a.js:1:2', stack: null })
    expect(JSON.stringify(f.store.session)).not.toContain('g /src/b.js')
    // The worker's own copy still has them, for a report.
    expect(await f.fremdev.report(7, true)).toContain('g /src/b.js:3:4')

    const again = createFremdev({
      send: () => true,
      wantSocket: vi.fn(),
      api: f.api,
      now: () => 5_000,
      setTimer: () => undefined,
      every: () => 1,
      stopEvery: () => undefined,
    })
    await again.onServer({ type: 'none' })
    const text = (await again.report(7, true)) as string
    expect(text).toContain('boom')
    expect(text).toContain('/src/a.js:1:2')
    expect(text).not.toContain('g /src/b.js:3:4')
  })

  it('restores only well-formed rows from the session copy', async () => {
    const { api, store } = fakeChrome()
    api.tabs.query = async () => [7, 8, 9, 10, 11].map((id) => ({ id, url: 'http://localhost:5173/', title: 'App', windowId: 1 }))
    const good = {
      tabId: 7, url: 'http://localhost:5173/', host: 'localhost:5173', title: 'App',
      errors: { total: 1, open: 1, seen: 0, last: { text: 'boom', at: 900 } },
      requests: { total: 0, open: 0, seen: 0, last: null },
      history: [{ kind: 'error', id: 1, text: 'boom', origin: '/src/a.js:1:2', stack: null, n: 1, at: 900, state: 'open' }],
      nextId: 2, devServer: null, serverBase: '/',
      server: 'up', activity: 900,
    }
    store.session.devTabs = {
      7: good,
      // keyed under another id
      8: { ...good, tabId: 80 },
      // no tallies: wireRow would throw on it
      9: { ...good, tabId: 9, errors: undefined },
      // a history entry that cannot travel
      10: { ...good, tabId: 10, history: [{ kind: 'error', id: 1, text: 'x', origin: null, stack: 'not frames', n: 1, at: 1, state: 'open' }] },
      // not even an object
      11: 'junk',
    }
    const fremdev = createFremdev({
      send: () => true, wantSocket: vi.fn(), api, now: () => 1_000,
      setTimer: () => undefined, every: () => 1, stopEvery: () => undefined,
    })
    await fremdev.onServer({ type: 'none' })
    expect(await fremdev.report(7, true)).toContain('boom')
    for (const id of [8, 9, 10, 11, 80]) expect(await fremdev.report(id, true)).toBeNull()
  })

  it('restores nothing from a session copy that is not an object of rows', async () => {
    for (const devTabs of [[{ tabId: 7 }], 'junk', 42]) {
      const { api, store } = fakeChrome()
      store.session.devTabs = devTabs
      const fremdev = createFremdev({
        send: () => true, wantSocket: vi.fn(), api, now: () => 1_000,
        setTimer: () => undefined, every: () => 1, stopEvery: () => undefined,
      })
      await fremdev.onServer({ type: 'none' })
      expect(await fremdev.report(7, true)).toBeNull()
    }
  })

  describe('dev.open.ask', () => {
    const id = '6f1c2a5e-8f0b-4c1d-9a3e-2b7d4e5f6a7b'
    const WANT = 'http://localhost:5173/__open-in-editor?file=src%2Fmain.ts%3A4%3A2'

    async function openable(res: { ok: boolean; body?: { cancel: () => Promise<void> } | null } | Error = { ok: true }) {
      const cancel = vi.fn(async () => undefined)
      const fetch = vi.fn(async () => {
        if (res instanceof Error) throw res
        return { body: { cancel }, ...res }
      })
      const f = await makeFremdev(undefined, { fetch })
      f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
      await f.fremdev.onPageEvent({ kind: 'devserver', server: 'vite', base: '/' }, devSender())
      await f.fremdev.onPageEvent({ kind: 'error', text: 'boom', origin: '/src/main.ts:4:2' }, devSender())
      await f.later()
      f.sent.length = 0
      const entryId = f.rows()['7'].history[0].id as number
      const answers = () => f.sent.filter((m) => m.type === 'dev.open.done')
      return { ...f, fetch, cancel, entryId, answers }
    }

    it('fetches exactly the editor URL, without credentials, cache or redirects, and answers ok', async () => {
      const f = await openable()
      const timeout = vi.spyOn(AbortSignal, 'timeout')
      try {
        await f.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 7, entryId: f.entryId })
        expect(f.fetch).toHaveBeenCalledTimes(1)
        // Given up after the server's own 5 s, not Chrome's network timeout minutes later.
        expect(timeout).toHaveBeenCalledWith(5_000)
        const signal = timeout.mock.results[0].value as AbortSignal
        expect(f.fetch).toHaveBeenCalledWith(WANT, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal })
      } finally {
        timeout.mockRestore()
      }
      expect(f.cancel).toHaveBeenCalled()
      expect(f.answers()).toEqual([{ type: 'dev.open.done', id, tabId: 7, ok: true }])
    })

    it('answers ok false on a 404, or a fetch that throws', async () => {
      const missing = await openable({ ok: false })
      await missing.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 7, entryId: missing.entryId })
      expect(missing.answers()).toEqual([{ type: 'dev.open.done', id, tabId: 7, ok: false }])
      const thrown = await openable(new TypeError('Failed to fetch'))
      await thrown.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 7, entryId: thrown.entryId })
      expect(thrown.answers()).toEqual([{ type: 'dev.open.done', id, tabId: 7, ok: false }])
    })

    it('answers ok false, fetching nothing, for an entry the ring no longer holds (Review Focus 3)', async () => {
      const f = await openable()
      for (let i = 0; i < 20; i++) await f.fremdev.onPageEvent({ kind: 'error', text: `boom ${i}` }, devSender())
      await f.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 7, entryId: f.entryId })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.answers()).toEqual([{ type: 'dev.open.done', id, tabId: 7, ok: false }])
    })

    it('answers ok false, fetching nothing, once the tab navigated to another origin (Review Focus 3)', async () => {
      const f = await openable()
      const [onUpdated] = f.api.tabs.onUpdated.addListener.mock.calls.at(-1)
      await onUpdated(7, { status: 'loading', url: 'http://localhost:3000/' }, { id: 7, url: 'http://localhost:3000/', title: 'Other' })
      await f.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 7, entryId: f.entryId })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.answers()).toEqual([{ type: 'dev.open.done', id, tabId: 7, ok: false }])
    })

    it('answers ok false, fetching nothing, for an entry with no editor URL', async () => {
      const f = await openable()
      await f.fremdev.onPageEvent({ kind: 'error', text: 'elsewhere', origin: 'cdn.example.com/lib.js:1:2' }, devSender())
      await f.later()
      f.sent.length = 0
      const other = f.rows()['7'].history[0].id as number
      expect(other).not.toBe(f.entryId)
      await f.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 7, entryId: other })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.answers()).toEqual([{ type: 'dev.open.done', id, tabId: 7, ok: false }])
    })

    it('answers nothing for a bad id or a tab it has no row for', async () => {
      const f = await openable()
      await f.fremdev.onServer({ type: 'dev.open.ask', id: 'not-an-id', tabId: 7, entryId: f.entryId })
      await f.fremdev.onServer({ type: 'dev.open.ask', id, tabId: 8, entryId: f.entryId })
      expect(f.fetch).not.toHaveBeenCalled()
      expect(f.sent).toEqual([])
    })
  })

  it('worker.js relays dev.open.ask to Fremdev', () => {
    const worker = source('worker.js')
    const relay = worker.slice(worker.indexOf("case 'dev.focus':"), worker.indexOf('return fremdev.onServer(msg)'))
    expect(relay).toContain("case 'dev.open.ask':")
  })

  it('worker.js relays dev.report.ask and answers the popup with the report', () => {
    const worker = source('worker.js')
    const relay = worker.slice(worker.indexOf("case 'dev.focus':"), worker.indexOf('return fremdev.onServer(msg)'))
    expect(relay).toContain("case 'dev.report.ask':")
    const popup = worker.slice(worker.indexOf("case 'fremdevReport':"))
    expect(popup).toMatch(/^case 'fremdevReport':\n\s+return reply\(fremdev\.report\(msg\.tabId, msg\.stack === true\)/)
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
    onCompleted({ tabId: 7, url: 'http://localhost:5173/api/x', method: 'POST', statusCode: 500, type: 'xmlhttprequest' })
    onFailed({ tabId: 7, url: 'http://localhost:5173/api/y', method: 'PROPFIND', error: 'net::ERR_FAILED', type: 'fetch' })
    await f.later()
    expect(f.rows()['7'].history).toEqual([
      { kind: 'request', id: 2, method: 'OTHER', path: '/api/y', status: 0, n: 1, at: expect.any(Number), state: 'open' },
      { kind: 'request', id: 1, method: 'POST', path: '/api/x', status: 500, n: 1, at: expect.any(Number), state: 'open' },
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
    f.api.webRequest = { onBeforeRequest: f.event(), onCompleted: f.event(), onErrorOccurred: f.event() }
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

  it('injects the open dev tabs and gives them rows when the extension is installed, updated or reloaded', async () => {
    // Added while the worker's first task runs, before any await, or Chrome would not deliver it.
    const { api } = fakeChrome()
    createFremdev({ send: () => true, wantSocket: () => undefined, api, every: () => 1, stopEvery: () => undefined })
    expect(api.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1)

    // The session copy is gone after a reload: the boot finds no row and injects nothing itself.
    const f = await makeFremdev()
    expect(f.api.scripting.executeScript).not.toHaveBeenCalled()
    const [onInstalled] = f.api.runtime.onInstalled.addListener.mock.calls[0]
    await onInstalled({ reason: 'update', previousVersion: '0.0.1' })
    const calls = f.api.scripting.executeScript.mock.calls as Array<[{ target: { tabId: number }; files: string[]; world?: string }]>
    expect(calls.map(([c]) => [c.target.tabId, c.files, c.world])).toEqual([
      [7, ['fremdev/relay.js', 'fremdev/kind.js', 'fremdev/build.js', 'fremdev/perf.js'], undefined],
      [7, ['fremdev/hook.js'], 'MAIN'],
    ])
    await f.later()
    expect(Object.keys(f.rows())).toEqual(['7'])
    expect(f.rows()['7']).toMatchObject({ url: 'http://localhost:5173/', title: 'App', server: 'up' })
  })

  it('swallows a registration that fails after an install', async () => {
    const f = await makeFremdev()
    f.api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('Duplicate script ID'))
    const [onInstalled] = f.api.runtime.onInstalled.addListener.mock.calls[0]
    await expect(onInstalled({ reason: 'update' })).resolves.toBeUndefined()
    expect(f.api.scripting.executeScript).not.toHaveBeenCalled()
  })

  it('injects nothing on a plain restart of the worker, nor on an install while off', async () => {
    const f = await makeFremdev()
    await f.later()
    expect(f.api.scripting.registerContentScripts).toHaveBeenCalledTimes(1)
    expect(f.api.scripting.executeScript).not.toHaveBeenCalled()
    expect(f.rows()).toEqual({})
    const off = await makeFremdev({ on: false })
    const [onInstalled] = off.api.runtime.onInstalled.addListener.mock.calls[0]
    await onInstalled({ reason: 'install' })
    expect(off.api.scripting.executeScript).not.toHaveBeenCalled()
    expect(off.api.scripting.registerContentScripts).not.toHaveBeenCalled()
  })

  it('off, it registers nothing and keeps no row', async () => {
    const f = await makeFremdev({ on: false })
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    expect(f.api.scripting.registerContentScripts).not.toHaveBeenCalled()
    expect(f.fremdev.active()).toBe(false)
    expect(f.fremdev.modules()).toEqual(['fremplay'])
    expect(f.api.webRequest.onCompleted.removeListener).toHaveBeenCalled()
    await f.fremdev.start()
    const scripts = f.api.scripting.registerContentScripts.mock.calls[0][0] as Array<{ id: string; world?: string; matches: string[]; js: string[] }>
    expect(scripts.map((s) => [s.id, s.world, s.matches, s.js])).toEqual([
      ['fremdev-relay', undefined, ['http://localhost/*'], ['fremdev/relay.js', 'fremdev/kind.js', 'fremdev/build.js', 'fremdev/perf.js']],
      ['fremdev-hook', 'MAIN', ['http://localhost/*'], ['fremdev/hook.js']],
    ])
    expect(ISOLATED_JS).toEqual(['fremdev/relay.js', 'fremdev/kind.js', 'fremdev/build.js', 'fremdev/perf.js'])
    expect(f.api.scripting.executeScript).toHaveBeenCalledTimes(2)
    expect(f.store.local.fremdev).toMatchObject({ on: true })
  })
})

describe('slow requests and requests in flight', () => {
  /** createFremdev on a clock the test moves, with timers that run when their time comes. */
  async function timed({ early = false } = {}) {
    const { api, store } = fakeChrome()
    const sent: Array<{ type: string; [k: string]: unknown }> = []
    const wantSocket = vi.fn()
    let clock = 1_000_000
    let timers: Array<{ at: number; fn: () => void }> = []
    const fremdev = createFremdev({
      send: (m: { type: string }) => (sent.push(m), true),
      wantSocket,
      api,
      now: () => clock,
      // `early`: a timer of more than 1 ms fires 1 ms before its time, as a real one may.
      setTimer: (fn: () => void, ms = 0) => void timers.push({ at: clock + ms - (early && ms > 1 ? 1 : 0), fn }),
      every: () => 1,
      stopEvery: () => undefined,
    })
    await fremdev.onServer({ type: 'none' })
    const settle = () => new Promise((r) => setTimeout(r, 0))
    /** Moves the clock by `ms`, running every timer due on the way. */
    const advance = async (ms: number) => {
      const end = clock + ms
      await settle()
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        clock = Math.max(clock, due.at)
        due.fn()
        await settle()
      }
      clock = end
      await settle()
    }
    const listener = (name: string) => api.webRequest[name].addListener.mock.calls.at(-1)[0]
    const rows = () => (store.session.devTabs ?? {}) as Record<string, any>
    // A row for tab 7, and a server that speaks Fremdev.
    await fremdev.onPageEvent({ kind: 'hot' }, devSender())
    fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await advance(1_000)
    const req = (id: string, over: Record<string, unknown> = {}) => ({
      requestId: id, tabId: 7, frameId: 0, method: 'GET', url: 'http://localhost:5173/api/items?token=x', type: 'xmlhttprequest', timeStamp: clock, ...over,
    })
    return {
      fremdev, api, store, sent, wantSocket, rows, advance, req,
      now: () => clock,
      before: listener('onBeforeRequest'),
      done: listener('onCompleted'),
      failed: listener('onErrorOccurred'),
    }
  }

  it('listens to onBeforeRequest beside the others, and lets go of it when turned off', async () => {
    const t = await timed()
    expect(t.api.webRequest.onBeforeRequest.addListener).toHaveBeenCalledWith(t.before, { urls: ['http://*/*', 'https://*/*'] })
    await t.fremdev.stop()
    expect(t.api.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledWith(t.before)
  })

  it('adds a slow entry for a request that succeeded after 1.5 s, and the light stays green', async () => {
    const t = await timed()
    t.before(t.req('1'))
    await t.advance(10)
    expect(t.rows()['7'].inFlight).toBe(1)
    await t.advance(1_490)
    t.done(t.req('1', { statusCode: 200, timeStamp: t.now() }))
    await t.advance(1_000)
    const row = t.rows()['7']
    expect(row.history).toEqual([{ kind: 'slow', id: 1, method: 'GET', path: '/api/items', ms: 1500, n: 1, at: expect.any(Number), state: 'open' }])
    expect(row).toMatchObject({ inFlight: 0, errors: { open: 0 }, requests: { total: 0, open: 0 } })
    const wire = (t.sent.filter((m) => m.type === 'dev.tabs').at(-1)!.tabs as Array<Record<string, any>>)[0]
    expect(wire.inFlight).toBe(0)
    expect(wire.history[0]).toMatchObject({ kind: 'slow', ms: 1500, path: '/api/items' })
  })

  it('adds a request entry and no slow one for a request that failed after 1.5 s', async () => {
    const t = await timed()
    t.before(t.req('1'))
    await t.advance(1_500)
    t.done(t.req('1', { statusCode: 500, timeStamp: t.now() }))
    t.before(t.req('2'))
    await t.advance(1_500)
    t.failed(t.req('2', { error: 'net::ERR_FAILED', timeStamp: t.now() }))
    await t.advance(1_000)
    const row = t.rows()['7']
    expect(row.history.map((e: { kind: string; status: number }) => [e.kind, e.status])).toEqual([['request', 0], ['request', 500]])
    expect(row.inFlight).toBe(0)
  })

  it('never times a websocket (Vite HMR), and stops counting a request pending past 30 s; neither is ever slow', async () => {
    const t = await timed()
    t.before(t.req('ws', { url: 'http://localhost:5173/', type: 'websocket' }))
    t.before(t.req('poll', { url: 'http://localhost:5173/api/poll' }))
    await t.advance(10)
    expect(t.rows()['7'].inFlight).toBe(1)
    await t.advance(29_980)
    expect(t.rows()['7'].inFlight).toBe(1)
    // Nothing else happens in the tab: the count still drops once 30 s are past.
    await t.advance(1_000)
    expect(t.rows()['7'].inFlight).toBe(0)
    // Both finish at last, a minute in: neither is slow.
    t.done(t.req('ws', { url: 'http://localhost:5173/', type: 'websocket', statusCode: 101, timeStamp: t.now() + 30_000 }))
    t.done(t.req('poll', { url: 'http://localhost:5173/api/poll', statusCode: 200, timeStamp: t.now() + 30_000 }))
    await t.advance(31_000)
    expect(t.rows()['7'].history).toEqual([])
    expect(t.rows()['7'].inFlight).toBe(0)
  })

  it('times only the requests of a tab with a row, to a dev host, and not the noise', async () => {
    const t = await timed()
    t.before(t.req('other-tab', { tabId: 8 }))
    t.before(t.req('fremkit', { url: 'http://127.0.0.1:4242/api' }))
    t.before(t.req('cdn', { url: 'https://cdn.example.org/x' }))
    t.before(t.req('noise', { url: 'http://localhost:5173/favicon.ico', type: 'image' }))
    await t.advance(10)
    expect(t.rows()['7'].inFlight).toBe(0)
    expect(Object.keys(t.rows())).toEqual(['7'])
  })

  it('applies the in-flight count quietly: 100 starts within 500 ms send at most 2 dev.tabs and never wake the socket', async () => {
    const t = await timed()
    t.sent.length = 0
    t.wantSocket.mockClear()
    for (let i = 0; i < 100; i++) {
      t.before(t.req(`r${i}`, { timeStamp: t.now() }))
      await t.advance(4)
    }
    expect(t.wantSocket).not.toHaveBeenCalled()
    await t.advance(500)
    expect(t.sent.filter((m) => m.type === 'dev.tabs').length).toBeLessThanOrEqual(2)
    expect(t.rows()['7'].inFlight).toBe(100)
    expect(t.wantSocket).not.toHaveBeenCalled()
  })

  it('forgets the timings of a tab that closes or goes to another origin', async () => {
    const t = await timed()
    const [onUpdated] = t.api.tabs.onUpdated.addListener.mock.calls.at(-1)
    t.before(t.req('1'))
    await t.advance(10)
    await onUpdated(7, { status: 'loading', url: 'http://localhost:3000/' }, { id: 7, url: 'http://localhost:3000/', title: '' })
    await t.advance(1_500)
    expect(t.rows()['7'].inFlight).toBe(0)
    t.done(t.req('1', { statusCode: 200, timeStamp: t.now() }))
    await t.advance(10)
    expect(t.rows()['7'].history).toEqual([])
    // Same origin: the requests still pending are still timed, and still counted.
    t.before(t.req('2', { url: 'http://localhost:3000/api' }))
    await t.advance(10)
    await onUpdated(7, { status: 'loading', url: 'http://localhost:3000/x' }, { id: 7, url: 'http://localhost:3000/x', title: '' })
    // The throttle's next send.
    await t.advance(500)
    expect(t.rows()['7'].inFlight).toBe(1)
    await t.advance(1_000)
    t.done(t.req('2', { url: 'http://localhost:3000/api', statusCode: 200, timeStamp: t.now() }))
    await t.advance(10)
    expect(t.rows()['7'].history[0]).toMatchObject({ kind: 'slow', path: '/api' })
  })

  it('still drops a pending request at 30 s when the stale timer fires early', async () => {
    const t = await timed({ early: true })
    t.before(t.req('poll', { url: 'http://localhost:5173/api/poll' }))
    await t.advance(10)
    expect(t.rows()['7'].inFlight).toBe(1)
    await t.advance(29_985)
    expect(t.rows()['7'].inFlight).toBe(1)
    await t.advance(600)
    expect(t.rows()['7'].inFlight).toBe(0)
  })

  it('drops a pending request a finish refuses (gone stale) from the count at once', async () => {
    const t = await timed()
    const start = t.now()
    t.before(t.req('1', { timeStamp: start }))
    await t.advance(10)
    expect(t.rows()['7'].inFlight).toBe(1)
    t.done(t.req('1', { statusCode: 200, timeStamp: start + 31_000 }))
    await t.advance(600)
    expect(t.rows()['7'].inFlight).toBe(0)
    expect(t.rows()['7'].history).toEqual([])
  })

  it('announces fremdev.slow only while on', async () => {
    expect(FEATURE_MODULES).toContain('fremdev.slow')
    const f = await makeFremdev({ on: false })
    expect(f.fremdev.modules()).not.toContain('fremdev.slow')
    await f.fremdev.start()
    expect(f.fremdev.modules()).toContain('fremdev.slow')
    await f.fremdev.stop()
    expect(f.fremdev.modules()).not.toContain('fremdev.slow')
  })
})

describe('performance and regressions', () => {
  const perfOf = (f: { rows: () => Record<string, any> }) => (f.rows()['7']?.history ?? []).filter((e: { kind: string }) => e.kind === 'perf')
  const stored = (f: { store: { session: Record<string, unknown> } }) => f.store.session.fremdevPerf as Array<{ key: string; samples: unknown[] }>

  it('rebuilds a perf event from bounded numbers, and drops one over its bounds', () => {
    expect(pageEvent({ kind: 'perf', load: 1234, lcp: 800, cls: 0.0234, longTasks: 1, heapMb: 45, tabId: 3, fps: 60 }))
      .toEqual({ kind: 'perf', values: { load: 1234, lcp: 800, cls: 0.023, longTasks: 1, heapMb: 45 } })
    expect(pageEvent({ kind: 'perf', lcp: 0 })).toEqual({ kind: 'perf', values: { lcp: 0 } })
    expect(pageEvent({ kind: 'perf', load: 600_000, cls: 100, longTasks: 100_000, heapMb: 65_536 }))
      .toEqual({ kind: 'perf', values: { load: 600_000, cls: 100, longTasks: 100_000, heapMb: 65_536 } })
    expect(pageEvent({ kind: 'perf' })).toBeNull()
    for (const bad of [
      { load: 600_001 }, { load: 1.5 }, { load: -1 }, { lcp: '800' }, { lcp: Number.NaN }, { cls: 100.5 }, { cls: -0.1 },
      { cls: Number.POSITIVE_INFINITY }, { longTasks: 100_001 }, { longTasks: 2.5 }, { heapMb: 65_537 }, { load: 1000, heapMb: null },
    ]) expect(pageEvent({ kind: 'perf', ...bad }), JSON.stringify(bad)).toBeNull()
  })

  it('judges the first event of a load that carries load against the stored samples, then pushes it', async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    for (const [i, lcp] of [1000, 1100, 1200].entries()) {
      await f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp }, devSender({ documentId: `D${i}` }))
    }
    await f.later()
    expect(perfOf(f)).toEqual([])
    expect(f.rows()['7'].requests.open).toBe(0)
    // Each sample with the document it came from (Chrome's documentId), so that document's can follow its LCP.
    expect(stored(f)).toEqual([{ key: 'http://localhost:5173/', samples: [{ load: 1000, lcp: 1000, doc: 'D0' }, { load: 1000, lcp: 1100, doc: 'D1' }, { load: 1000, lcp: 1200, doc: 'D2' }] }])
    // The next load: LCP first, judged on the bands alone; then load, judged against the three before it.
    await f.fremdev.onPageEvent({ kind: 'perf', lcp: 1800 }, devSender({ documentId: 'D9' }))
    await f.later()
    expect(perfOf(f)).toEqual([])
    await f.fremdev.onPageEvent({ kind: 'perf', lcp: 1800, load: 1100 }, devSender({ documentId: 'D9' }))
    await f.later()
    expect(perfOf(f)).toEqual([expect.objectContaining({ metric: 'lcp', value: 1800, ratio: 1.6, state: 'open' })])
    expect(f.rows()['7'].requests).toMatchObject({ total: 1, open: 1, last: null })
    expect(stored(f)[0].samples).toHaveLength(4)
    // A later event of that load: the bands only, and never pushed again. A poor CLS is weaker than
    // the LCP ratio: the entry stays as it is.
    await f.fremdev.onPageEvent({ kind: 'perf', lcp: 1800, load: 1100, cls: 0.4 }, devSender({ documentId: 'D9' }))
    await f.later()
    expect(perfOf(f)).toEqual([expect.objectContaining({ metric: 'lcp', value: 1800, ratio: 1.6 })])
    expect(f.rows()['7'].requests.open).toBe(1)
    expect(stored(f)[0].samples).toHaveLength(4)
    const wire = (f.sent.filter((m) => m.type === 'dev.tabs').at(-1)!.tabs as Array<Record<string, any>>)[0]
    expect(wire.perf).toEqual({ lcp: 1800, load: 1100, cls: 0.4 })
    // The LCP grows after the load: this document's sample follows it, still one sample.
    await f.fremdev.onPageEvent({ kind: 'perf', lcp: 2500, load: 1100, cls: 0.4 }, devSender({ documentId: 'D9' }))
    await f.later()
    expect(stored(f)[0].samples).toHaveLength(4)
    expect(stored(f)[0].samples.at(-1)).toEqual({ load: 1100, lcp: 2500, doc: 'D9' })
    expect(stored(f)[0].samples.slice(0, 3).map((x) => (x as { lcp: number }).lcp)).toEqual([1000, 1100, 1200])
    // Turned off, the samples go too.
    await f.fremdev.stop()
    expect(f.store.session.fremdevPerf).toEqual([])
  })

  it('stores the load\'s latest values when another event of it came in while the samples were read', async () => {
    const f = await makeFremdev()
    const first = f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp: 800 }, devSender({ documentId: 'D1' }))
    const second = f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp: 1500 }, devSender({ documentId: 'D1' }))
    await Promise.all([first, second])
    await f.later()
    expect(stored(f)).toEqual([{ key: 'http://localhost:5173/', samples: [{ load: 1000, lcp: 1500, doc: 'D1' }] }])
  })

  it('neither wakes the socket nor sends again when a verdict comes back unchanged', async () => {
    const f = await makeFremdev()
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    // A poor LCP: an entry on the bands alone.
    await f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp: 5000 }, devSender({ documentId: 'D1' }))
    await f.later()
    expect(perfOf(f)).toEqual([expect.objectContaining({ metric: 'lcp', value: 5000, ratio: null })])
    const sends = f.sent.filter((m) => m.type === 'dev.tabs').length
    f.wantSocket.mockClear()
    // perf.js re-sends the whole set as the heap moves; the verdict is the same one.
    for (const heapMb of [40, 41, 42]) {
      await f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp: 5000, heapMb }, devSender({ documentId: 'D1' }))
      await f.later()
    }
    expect(f.wantSocket).not.toHaveBeenCalled()
    expect(perfOf(f)).toEqual([expect.objectContaining({ metric: 'lcp', value: 5000 })])
    // The heap still reaches the row, on the quiet path.
    expect(f.sent.filter((m) => m.type === 'dev.tabs').length).toBeGreaterThan(sends)
    // A worse value is a change: it is taken and told.
    await f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp: 6000, heapMb: 42 }, devSender({ documentId: 'D1' }))
    await f.later()
    expect(perfOf(f)).toEqual([expect.objectContaining({ metric: 'lcp', value: 6000 })])
    expect(f.wantSocket).toHaveBeenCalled()
  })

  it('drops a perf event over its bounds', async () => {
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'perf', cls: 101 }, devSender())
    await f.fremdev.onPageEvent({ kind: 'perf', load: 1000, lcp: 700_000 }, devSender())
    await f.later()
    expect(f.rows()).toEqual({})
    expect(f.store.session.fremdevPerf).toBeUndefined()
  })

  it('announces fremdev.perf only while on', async () => {
    expect(FEATURE_MODULES).toContain('fremdev.perf')
    const f = await makeFremdev({ on: false })
    expect(f.fremdev.modules()).not.toContain('fremdev.perf')
    await f.fremdev.start()
    expect(f.fremdev.modules()).toContain('fremdev.perf')
    await f.fremdev.stop()
    expect(f.fremdev.modules()).not.toContain('fremdev.perf')
  })
})

describe('the shot', () => {
  it('announces fremdev.shot only while on', async () => {
    expect(FEATURE_MODULES).toContain('fremdev.shot')
    const f = await makeFremdev({ on: false })
    expect(f.fremdev.modules()).not.toContain('fremdev.shot')
    await f.fremdev.start()
    expect(f.fremdev.modules()).toContain('fremdev.shot')
    await f.fremdev.stop()
    expect(f.fremdev.modules()).not.toContain('fremdev.shot')
  })

  it('isDevTab: a tab with a row, while on', async () => {
    const f = await makeFremdev()
    expect(await f.fremdev.isDevTab(7)).toBe(false)
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    expect(await f.fremdev.isDevTab(7)).toBe(true)
    expect(await f.fremdev.isDevTab(8)).toBe(false)
    expect(await f.fremdev.isDevTab(-1)).toBe(false)
    expect(await f.fremdev.isDevTab(undefined)).toBe(false)
    await f.fremdev.stop()
    expect(await f.fremdev.isDevTab(7)).toBe(false)
  })

  it('tellShot: dev.shot for a dev tab, only on a socket whose ready took Fremdev and dev.shot', async () => {
    const THUMB = 'data:image/jpeg;base64,/9j/4AAQ'
    const f = await makeFremdev()
    await f.fremdev.onPageEvent({ kind: 'error', text: 'x' }, devSender())
    // No socket greeted yet.
    expect(await f.fremdev.tellShot(7, THUMB, true)).toBe(false)
    // A server that speaks Fremdev but not dev.shot would close the socket on it.
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    await f.later()
    f.sent.length = 0
    expect(await f.fremdev.tellShot(7, THUMB, true)).toBe(false)
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true, shotView: true } })
    await f.later()
    f.sent.length = 0
    expect(await f.fremdev.tellShot(7, THUMB, true)).toBe(true)
    expect(await f.fremdev.tellShot(7, null, false)).toBe(true)
    // Not a dev tab: nothing.
    expect(await f.fremdev.tellShot(8, THUMB, false)).toBe(false)
    expect(f.sent).toEqual([
      { type: 'dev.shot', tabId: 7, thumb: THUMB, sound: true },
      { type: 'dev.shot', tabId: 7, thumb: null, sound: false },
    ])
    f.fremdev.socketClosed()
    expect(await f.fremdev.tellShot(7, THUMB, false)).toBe(false)
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: false, shotView: true } })
    expect(await f.fremdev.tellShot(7, THUMB, false)).toBe(false)
  })

  it('announces fremdev.shotview only while on', async () => {
    expect(FEATURE_MODULES).toContain('fremdev.shotview')
    const f = await makeFremdev({ on: false })
    expect(f.fremdev.modules()).not.toContain('fremdev.shotview')
    await f.fremdev.start()
    expect(f.fremdev.modules()).toContain('fremdev.shotview')
  })

  it('canSend: only once a greeted socket said yes, and not after it closed', async () => {
    const f = await makeFremdev()
    expect(f.fremdev.canSend()).toBe(false)
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: false } })
    expect(f.fremdev.canSend()).toBe(false)
    f.fremdev.onReady({ type: 'ready', protocol: 2, modules: { fremplay: true, fremdev: true } })
    expect(f.fremdev.canSend()).toBe(true)
    f.fremdev.socketClosed()
    expect(f.fremdev.canSend()).toBe(false)
  })
})
