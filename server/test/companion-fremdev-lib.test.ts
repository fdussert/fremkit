import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { BUILTIN_PERMISSION_ORIGINS, FREMKIT_EXCLUDES, inOrigins, isDevUrl, parsePattern, releasableOrigins } from '../../companion/lib/devhosts.js'
// @ts-expect-error plain JS module
import { boundBuildLines, boundFrames, consoleBuild, errorText, framePlace, homePath, hotReloadSignal, isNoise, MAX_BUILD_EXTRA, MAX_BUILD_LINE, MAX_FRAME, MAX_FRAME_LINES, MAX_FRAMES, MAX_STACK, MAX_STACK_LINES, MAX_TEXT, METHODS, methodOf, parseStack, pathOf, RateLimiter } from '../../companion/lib/devlog.js'
// @ts-expect-error plain JS module
import { emptyTab, fremdevSupport, HISTORY_MAX, reduce, SLOW_MAX, restoredTabs, sessionTabs, Throttle, validRow, wireTabs } from '../../companion/lib/devtabs.js'
// @ts-expect-error plain JS module
import { hello, devShot, devTabs, modulesMsg, ping } from '../../companion/lib/protocol.js'
// @ts-expect-error plain JS module
import { buildReport, REPORT_MAX, reportMessage } from '../../companion/lib/devreport.js'
// @ts-expect-error plain JS module
import { editorUrl, parsePlace } from '../../companion/lib/devopen.js'
// @ts-expect-error plain JS module
import { InFlight, MAX_IN_FLIGHT, MAX_TRACKED, SLOW_MS, STALE_MS } from '../../companion/lib/devflight.js'
// @ts-expect-error plain JS module
import { CLS_POOR, LCP_POOR_MS, median, PERF_KEYS, PERF_MIN_MS, PERF_RATIO, PERF_SAMPLES, PerfMemory, perfVerdict } from '../../companion/lib/devperf.js'
// @ts-expect-error plain JS module
import { blobDataUrl, clearBeforeCapture, CLEAR_WAIT_MS, dataUrlBlob, fitShot, isThumb, shootTab, shotFeedback, THUMB_MAX_CHARS, thumbOf } from '../../companion/lib/devshot.js'
import { DEV_METHODS, DevTabSchema } from '../src/companion/protocol.js'

const both = (host: string) => [`http://${host}/*`, `https://${host}/*`]

describe('devhosts', () => {
  it('lists the built-in permissions and the Fremkit excludes', () => {
    expect(BUILTIN_PERMISSION_ORIGINS).toHaveLength(10)
    for (const o of BUILTIN_PERMISSION_ORIGINS) expect(o, o).toMatch(/^https?:\/\//)
    // Each host on both ports, under both schemes: Chrome refuses a port under the `*` scheme
    // ("Invalid port" from registerContentScripts), so they are spelled out.
    const hosts = ['127.0.0.1', 'localhost', '[::1]', '*.localhost']
    const want = ['http', 'https'].flatMap((scheme) => ['4242', '4243'].flatMap((port) => hosts.map((h) => `${scheme}://${h}:${port}/*`)))
    expect([...FREMKIT_EXCLUDES].sort()).toEqual(want.sort())
    for (const p of FREMKIT_EXCLUDES) expect(p, p).not.toMatch(/^\*:\/\/[^/]*:\d/)
  })

  it('tells whether a URL is inside the granted origins', () => {
    const granted = ['http://localhost/*', '*://*.test/*', 'http://[::1]/*', '*://*.dev.example.com/*', '*://bo.example.com/*']
    const yes = ['http://localhost:5173/x', 'https://foo.test/', 'http://foo.test/', 'http://[::1]:3000/', 'https://a.dev.example.com/', 'https://dev.example.com/', 'http://bo.example.com/']
    const no = ['https://localhost:5173/', 'http://127.0.0.1:5173/', 'https://[::1]/', 'https://xdev.example.com/', 'http://a.bo.example.com/', 'ftp://foo.test/', 'nonsense']
    for (const u of yes) expect(inOrigins(u, granted), u).toBe(true)
    for (const u of no) expect(inOrigins(u, granted), u).toBe(false)
    expect(inOrigins('http://localhost/', [])).toBe(false)
  })

  it('recognises dev URLs', () => {
    const yes = ['http://localhost:5173/', 'http://foo.test/', 'http://[::1]:3000/', 'http://app.localhost:8080/x']
    const no = ['http://localhost.example.com/', 'http://127.0.0.1:4242/admin', 'http://localhost:4242/', 'chrome://extensions', 'file:///x', 'nonsense']
    for (const u of yes) expect(isDevUrl(u, []), u).toBe(true)
    for (const u of no) expect(isDevUrl(u, []), u).toBe(false)
    expect(isDevUrl('https://bo-dev.example.com/', ['bo-dev.example.com'])).toBe(true)
    expect(isDevUrl('https://api-dev.example.com/', ['*-dev.example.com'])).toBe(true)
    expect(isDevUrl('https://www.example.com/', ['*-dev.example.com'])).toBe(false)
    expect(isDevUrl('https://a.b.dev.example.com/', ['*.dev.example.com'])).toBe(true)
    expect(isDevUrl('https://dev.example.com/', ['*.dev.example.com'])).toBe(false)
    expect(isDevUrl('https://x.api-dev.example.com/', ['*-dev.example.com'])).toBe(false)
  })

  it('excludes both Fremkit ports on every loopback host, and only those', () => {
    for (const u of ['http://app.localhost:4242/', 'http://127.0.0.1:4243/', 'http://[::1]:4243/', 'https://x.localhost:4243/']) expect(isDevUrl(u, []), u).toBe(false)
    expect(isDevUrl('http://localhost:4301/', [])).toBe(true)
  })

  it('refuses wildcards over public suffixes and numeric labels', () => {
    for (const bad of ['*.co.uk', '*-dev.co.uk', '*.com.au', '*.0.2.1', '*-x.0.2.1']) expect(parsePattern(bad), bad).toBeNull()
    expect(parsePattern('*.example.co.uk')?.permissions).toEqual(['http://*.example.co.uk/*', 'https://*.example.co.uk/*'])
  })

  it('parses patterns', () => {
    expect(parsePattern('  BO-Dev.Example.com ')).toEqual({ pattern: 'bo-dev.example.com', permissions: both('bo-dev.example.com') })
    expect(parsePattern('*-dev.example.com')).toEqual({ pattern: '*-dev.example.com', permissions: both('*.example.com') })
    expect(parsePattern('*.dev.example.com')).toEqual({ pattern: '*.dev.example.com', permissions: both('*.dev.example.com') })
    for (const bad of ['', '  ', 'a b.example.com', 'https://x.example.com', 'x.example.com/path', 'a.*.example.com', '*.*.example.com', 'a-*.b-*.example.com', '*.com', '*-dev.com', 'localhost', '127.0.0.1', 'app.localhost', 'foo.test', '*.foo.test']) {
      expect(parsePattern(bad), bad).toBeNull()
    }
  })

  // Chrome refuses a whole permissions.request, with no prompt, when one origin is not covered by
  // the manifest's optional hosts; `*://` counts ws and wss, which `http://*/*` and `https://*/*` do not.
  it('requests only origins the manifest lets it ask for', () => {
    const optional: string[] = JSON.parse(readFileSync(new URL('../../companion/manifest.json', import.meta.url), 'utf8')).optional_host_permissions
    const schemes = optional.map((o) => /^([a-z]+):\/\/\*\/\*$/.exec(o)?.[1])
    const asked = [...BUILTIN_PERMISSION_ORIGINS, ...['bo.example.com', '*-dev.example.com'].flatMap((p) => parsePattern(p).permissions)]
    for (const origin of asked) expect(schemes, origin).toContain(/^([a-z]+):\/\//.exec(origin)?.[1])
  })
})

describe('releasableOrigins', () => {
  const held = (...extra: string[]) => [...BUILTIN_PERMISSION_ORIGINS, 'http://127.0.0.1:4242/*', ...extra]

  it("releases a removed pattern's own origins when nothing else needs them", () => {
    expect(releasableOrigins('bo-dev.example.com', [], held(...both('bo-dev.example.com')))).toEqual(both('bo-dev.example.com'))
    expect(releasableOrigins('*-dev.example.org', ['bo-dev.example.com'], held(...both('*.example.org'), ...both('bo-dev.example.com')))).toEqual(both('*.example.org'))
  })

  it('keeps origins another pattern shares or overlaps', () => {
    // Same permissions.
    expect(releasableOrigins('*-dev.example.org', ['*-qa.example.org'], held(...both('*.example.org')))).toBeNull()
    // The wildcard covers a narrower pattern still listed, and the other way round.
    expect(releasableOrigins('*-dev.example.org', ['bo.example.org'], held(...both('*.example.org'), ...both('bo.example.org')))).toBeNull()
    expect(releasableOrigins('bo.example.org', ['*-dev.example.org'], held(...both('*.example.org'), ...both('bo.example.org')))).toBeNull()
  })

  it('keeps origins that cover another grant, a Fremplay player say', () => {
    expect(releasableOrigins('*-dev.example.org', [], held(...both('*.example.org'), 'https://player.example.org/*'))).toBeNull()
    // A grant elsewhere does not hold them.
    expect(releasableOrigins('*-dev.example.org', [], held(...both('*.example.org'), 'https://www.example.net/*'))).toEqual(both('*.example.org'))
  })

  it('never releases what is not a pattern', () => {
    expect(releasableOrigins('localhost', [], held())).toBeNull()
    expect(releasableOrigins('not a host', [], held())).toBeNull()
  })
})

describe('devlog', () => {
  it('joins console arguments', () => {
    expect(errorText(['a', 1, { b: 2 }])).toBe('a 1 {"b":2}')
    expect(errorText([new Error('boom')])).toContain('Error: boom')
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(() => errorText([loop])).not.toThrow()
    expect(() => errorText([Symbol('s')])).not.toThrow()
    expect(errorText([])).toBe('')
    expect(errorText(['x'.repeat(1000)])).toHaveLength(300)
    expect(MAX_TEXT).toBe(300)
  })

  it('prints values without running any of their code', () => {
    let ran = 0
    const getter = { a: 1, get b() { ran += 1; return 2 } }
    const toJson = { a: 1, toJSON: () => { ran += 1; return 'x' } }
    const toStr = { toString: () => { ran += 1; return 'x' }, [Symbol.toPrimitive]: () => { ran += 1; return 'x' } }
    const gets: PropertyKey[] = []
    const proxy = new Proxy({ a: 1 }, { get: (t, k) => (gets.push(k), Reflect.get(t, k)) })
    class Thing { x = 1 }
    const err = new TypeError('boom')
    Object.defineProperty(err, 'message', { get: () => { ran += 1; return 'no' } })
    expect(errorText([getter])).toBe('{"a":1,"b":[Getter]}')
    expect(errorText([toJson])).toBe('{"a":1,"toJSON":[Function: toJSON]}')
    expect(errorText([toStr])).toBe('{"toString":[Function: toString]}')
    expect(errorText([proxy])).toBe('{"a":1}')
    expect(errorText([err])).toBe('TypeError')
    expect(errorText([new Error('boom'), 'x'])).toBe('Error: boom x')
    expect(errorText([new Thing(), new Map(), [1, 'a', [2, [3]]], 10n, Symbol('s'), null, undefined])).toBe(
      'Thing {"x":1} [object Map] [1,"a",[2,[Array]]] 10n Symbol(s) null undefined',
    )
    expect(ran).toBe(0)
    expect(gets).toEqual([])
  })

  it('prints a DOMException through its own getters', () => {
    expect(errorText([new DOMException('The user aborted a request.', 'AbortError')])).toBe('AbortError: The user aborted a request.')
    // Its prototype without being one: the native getters refuse it, nothing throws.
    const fake = Object.create(DOMException.prototype)
    expect(errorText([fake])).toBe('Error')
  })

  it('looks at a bounded number of keys, enumerable or not', () => {
    const hidden: Record<string, number> = {}
    for (let i = 0; i < 100_000; i++) Object.defineProperty(hidden, `h${i}`, { value: i, enumerable: false })
    hidden.shown = 1
    let descriptors = 0
    const counted = new Proxy(hidden, { getOwnPropertyDescriptor: (t, k) => (descriptors++, Reflect.getOwnPropertyDescriptor(t, k)) })
    expect(errorText([counted])).toBe('{…}')
    expect(descriptors).toBeLessThanOrEqual(60)
  })

  it('stays cheap on a huge or deep value', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 100_000; i++) wide[`k${i}`] = i
    let descriptors = 0
    const counted = new Proxy(wide, { getOwnPropertyDescriptor: (t, k) => (descriptors++, Reflect.getOwnPropertyDescriptor(t, k)) })
    const text = errorText([counted])
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT)
    expect(descriptors).toBeLessThanOrEqual(25)
    let deep: unknown = 'bottom'
    for (let i = 0; i < 10_000; i++) deep = [deep]
    expect(errorText([deep])).toBe('[[[Array]]]')
    const long = Array.from({ length: 1_000_000 }, (_, i) => i)
    expect(errorText([long])).toBe('[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,…]')
    const loop: Record<string, unknown> = { a: 1 }
    loop.self = loop
    expect(errorText([loop])).toBe('{"a":1,"self":{"a":1,"self":{…}}}')
  })

  it('reads hot reload signals', () => {
    for (const t of ['[vite] server connection lost. Polling', '[webpack-dev-server] Disconnected!', '[WDS] Disconnected!']) expect(hotReloadSignal(t)).toBe('down')
    for (const t of ['[vite] connected.', '[webpack-dev-server] Server started', '[webpack-dev-server] Hot Module Replacement enabled', '[webpack-dev-server] Live Reloading enabled']) expect(hotReloadSignal(t)).toBe('up')
    for (const t of ['[vite] hot updated: /src/a.ts', '[vite] css hot updated: /src/a.css', '[HMR] App is up to date', '[HMR] Updated modules', '[Fast Refresh] done in 136ms']) expect(hotReloadSignal(t)).toBe('hot')
    expect(hotReloadSignal('[Fast Refresh] rebuilding')).toBeNull()
    expect(hotReloadSignal('[vite] connecting...')).toBeNull()
  })

  it("reads Vite's logger, which passes the prefix as its own argument", () => {
    expect(hotReloadSignal('[vite]', 'hot updated: /src/App.vue')).toBe('hot')
    expect(hotReloadSignal('[vite]', 'connected.')).toBe('up')
    expect(hotReloadSignal('[vite]', 'connecting...')).toBeNull()
    // Only two strings are joined: anything else leaves the first argument alone.
    expect(hotReloadSignal('[vite]', { toString: () => 'hot updated: x' })).toBeNull()
    expect(hotReloadSignal('[vite] hot updated: /src/a.ts', 42)).toBe('hot')
    expect(hotReloadSignal(undefined, 'hot updated: x')).toBeNull()
  })

  it('keeps the path only', () => {
    expect(pathOf('http://localhost:5173/api/items/4?token=abc#x')).toBe('/api/items/4')
    expect(pathOf('nonsense')).toBe('/')
    expect(pathOf('data:text/plain,secret')).toBe('/')
    expect(pathOf('wss://localhost:5173/ws?x=1')).toBe('/ws')
  })

  it('knows the noise', () => {
    for (const u of ['http://localhost/favicon.ico', 'http://localhost/@vite/client', 'http://localhost/__webpack_hmr', 'http://localhost/sockjs-node/info', 'http://localhost/main.abc.hot-update.json']) expect(isNoise(u, 'net::ERR_FAILED'), u).toBe(true)
    expect(isNoise('http://localhost/api/items', 'net::ERR_ABORTED')).toBe(true)
    expect(isNoise('http://localhost/api/items', 500)).toBe(false)
  })

  it('slides the window instead of resetting it', () => {
    let t = 1_000_000
    const limiter = new RateLimiter(10, () => t)
    t += 990
    expect(Array.from({ length: 10 }, () => limiter.allow()).every(Boolean)).toBe(true)
    t += 20
    expect(limiter.allow()).toBe(false)
    t += 981
    expect(limiter.allow()).toBe(true)
  })

  it('limits to ten a second', () => {
    let t = 1_000_000
    const limiter = new RateLimiter(10, () => t)
    const run = () => Array.from({ length: 1000 }, () => limiter.allow()).filter(Boolean).length
    expect(run()).toBe(10)
    t += 1000
    expect(run()).toBe(10)
  })
})

describe('devlog frames', () => {
  const PAGE = 'http://localhost:5173'

  it('names a frame by its path on the page origin, by host and path elsewhere, never with a query', () => {
    expect(framePlace('http://localhost:5173/src/App.vue?t=1#a', PAGE)).toBe('/src/App.vue')
    expect(framePlace('https://cdn.example.com/lib.js?v=abc#x', PAGE)).toBe('cdn.example.com/lib.js')
    expect(framePlace('http://localhost:3000/a.js', PAGE)).toBe('localhost:3000/a.js')
    expect(framePlace('not a url', PAGE)).toBe('')
    expect(framePlace('', PAGE)).toBe('')
    expect(framePlace('data:text/javascript,alert(1)', PAGE)).toBe('')
    expect(framePlace(undefined as unknown as string, PAGE)).toBe('')
  })

  it("reads V8's frames into fn place:line:col, skipping the header and what it cannot parse", () => {
    const stack =
      'TypeError: x\n    at Cart.setup (http://localhost:5173/src/components/Cart.vue?t=9:42:17)\n    at http://localhost:5173/node_modules/.vite/deps/vue.js?v=1:100:5'
    expect(parseStack(stack, PAGE)).toEqual(['Cart.setup /src/components/Cart.vue:42:17', '/node_modules/.vite/deps/vue.js:100:5'])
    expect(parseStack('Error: y\n    at Array.map (<anonymous>)\n    at async load (https://cdn.example.com/lib.js?v=abc#x:1:2)', PAGE)).toEqual([
      'async load cdn.example.com/lib.js:1:2',
    ])
    expect(parseStack('Error: z\n    at async http://localhost:5173/src/main.js?t=2:1:2\n    at async https://cdn.example.com/x.js:3:4', PAGE)).toEqual([
      'async /src/main.js:1:2',
      'async cdn.example.com/x.js:3:4',
    ])
    expect(parseStack('', PAGE)).toEqual([])
    expect(parseStack(undefined as unknown as string, PAGE)).toEqual([])
  })

  it('keeps at most 30 frames of 300 characters, 6000 in all', () => {
    const frames = Array.from({ length: 35 }, (_, i) => `    at f${i} (http://localhost:5173/a.js:${i + 1}:1)`)
    expect(parseStack(`Error: e\n${frames.join('\n')}`, PAGE)).toHaveLength(MAX_FRAMES)
    const long = parseStack(`Error: e\n    at ${'f'.repeat(400)} (http://localhost:5173/a.js:1:1)`, PAGE)
    expect(long).toHaveLength(1)
    expect(long[0]).toHaveLength(MAX_FRAME)
    const wide = Array.from({ length: 25 }, (_, i) => `    at ${String(i % 10).repeat(290)} (http://localhost:5173/a.js:1:1)`)
    const kept = parseStack(`Error: e\n${wide.join('\n')}`, PAGE)
    // Each frame is 300 long: 19 of them and 18 newlines make 5718, a twentieth would make 6019.
    expect(kept.every((f: string) => f.length === 300)).toBe(true)
    expect(kept).toHaveLength(19)
    expect(kept.join('\n').length).toBeLessThanOrEqual(MAX_STACK)
    expect([MAX_FRAMES, MAX_FRAME, MAX_STACK]).toEqual([30, 300, 6000])
    expect(boundFrames(['a', 'b'.repeat(400)])).toEqual(['a', 'b'.repeat(300)])
  })

  it('names a method from a closed list', () => {
    expect(methodOf('post')).toBe('POST')
    expect(methodOf('GET')).toBe('GET')
    expect(methodOf('PROPFIND')).toBe('OTHER')
    expect(methodOf(undefined)).toBe('OTHER')
    expect(methodOf({ toString: () => 'GET' })).toBe('OTHER')
    // The extension's one list, plus OTHER, is the server's.
    expect([...METHODS, 'OTHER']).toEqual([...DEV_METHODS])
  })
})

describe('devtabs', () => {
  const base = () => emptyTab(1, 'http://localhost:5173/', 'App', 100)

  it('reduces events', () => {
    let tab = base()
    for (const text of ['a', 'b', 'c']) tab = reduce(tab, { kind: 'error', text }, 200)
    expect(tab.errors).toMatchObject({ total: 3, open: 3, last: { text: 'c', at: 200 } })
    expect(tab.activity).toBe(200)
    tab = reduce(tab, { kind: 'request', path: '/api', status: 500 }, 210)
    expect(tab.requests).toMatchObject({ total: 1, open: 1 })
    const same = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/x', title: 'X' }, 300)
    expect(same.errors).toMatchObject({ total: 3, open: 0 })
    expect(same.requests.open).toBe(0)
    const other = reduce(same, { kind: 'navigated', url: 'http://localhost:3000/', title: 'Y' }, 400)
    expect(other.errors.total).toBe(0)
    expect(other.host).toBe('localhost:3000')
    expect(reduce(tab, { kind: 'hot' }, 500).errors.open).toBe(0)
    const down = reduce(tab, { kind: 'server', state: 'down' }, 600)
    expect(down.server).toBe('down')
    expect(reduce(down, { kind: 'server', state: 'up' }, 700).server).toBe('up')
    const cleared = reduce(tab, { kind: 'clear' }, 800)
    expect(cleared.errors).toMatchObject({ total: 3, open: 3, seen: 3 })
    expect(cleared.requests).toMatchObject({ total: 1, open: 1, seen: 1 })
    expect(cleared.activity).toBe(800)
    const titled = reduce(tab, { kind: 'title', title: 'New' }, 900)
    expect(titled.title).toBe('New')
    expect(titled.activity).toBe(tab.activity)
  })

  it('adds the errors the relay counted over its limit, keeping the last text', () => {
    let tab = reduce(base(), { kind: 'error', text: 'first' }, 200)
    tab = reduce(tab, { kind: 'count', n: 990 }, 300)
    expect(tab.errors).toMatchObject({ total: 991, open: 991, last: { text: 'first', at: 200 } })
    expect(tab.activity).toBe(300)
    expect(reduce(tab, { kind: 'count', n: 5_000_000 }, 400).errors).toMatchObject({ total: 1_000_000, open: 1_000_000 })
    expect(reduce(tab, { kind: 'count', n: -3 }, 500)).toBe(tab)
  })

  it('puts the latest 32 first, in the server shape', () => {
    const tabs = Array.from({ length: 40 }, (_, i) => reduce(emptyTab(i, `http://localhost:${3000 + i}/`, `App ${i}`, i), { kind: 'error', text: 'x' }, 1000 + i))
    const rows = wireTabs(tabs)
    expect(rows).toHaveLength(32)
    expect(rows[0].tabId).toBe(39)
    expect(rows[31].tabId).toBe(8)
    expect(Object.keys(rows[0]).sort()).toEqual(['activity', 'app', 'devServer', 'errors', 'history', 'host', 'inFlight', 'perf', 'requests', 'server', 'tabId'])
    for (const r of rows) expect(DevTabSchema.safeParse(r).success).toBe(true)
  })

  it('sends a tab whose host carries an underscore, in the server shape', () => {
    const url = 'http://my_app.localhost:3000/'
    expect(isDevUrl(url)).toBe(true)
    const [row] = wireTabs([reduce(emptyTab(1, url, '', 1), { kind: 'error', text: 'x' }, 2)])
    expect(row.host).toBe('my_app.localhost:3000')
    expect(DevTabSchema.safeParse(row).success).toBe(true)
  })

  it('leaves out a row outside the server\'s bounds, and keeps the others', () => {
    const good = reduce(emptyTab(1, 'http://localhost:5173/', 'A', 1), { kind: 'error', text: 'x' }, 5)
    const badId = { ...good, tabId: -1, activity: 9 }
    const badStamp = { ...good, tabId: 2, activity: Number.NaN }
    const badHost = { ...good, tabId: 3, host: 'bad host/', activity: 8 }
    const rows = wireTabs([good, badId, badStamp, badHost])
    expect(rows.map((r: { tabId: number }) => r.tabId)).toEqual([1])
    // validRow and DevTabSchema agree on each of them.
    for (const t of [good, badId, badStamp, badHost]) {
      const shaped = { tabId: t.tabId, app: t.title, host: t.host, errors: t.errors, requests: t.requests, history: [], devServer: null, server: t.server, activity: t.activity }
      expect(validRow(shaped), String(t.tabId)).toBe(DevTabSchema.safeParse(shaped).success)
    }
    expect(validRow(null)).toBe(false)
    expect(validRow({ ...rows[0], requests: { total: 1, open: 0, seen: 0, last: { path: '/a?b', status: 500, at: 1 } } })).toBe(false)
    expect(validRow({ ...rows[0], errors: { total: 1, open: 2, seen: 0, last: null } })).toBe(false)
    expect(validRow({ ...rows[0], errors: { total: 2, open: 1, seen: 2, last: null } })).toBe(false)
    expect(validRow({ ...rows[0], errors: { total: 1, open: 1, last: null } })).toBe(false)
    expect(validRow({ ...rows[0], errors: { total: 2, open: 2, seen: 1, last: null } })).toBe(true)
    expect(validRow({ ...rows[0], server: 'sideways' })).toBe(false)
  })

  it('clamps and strips what leaves the tab', () => {
    let tab = emptyTab(1, 'http://localhost:5173/', 'T'.repeat(500), 1)
    tab = reduce(tab, { kind: 'error', text: 'e'.repeat(900) }, 2)
    tab = reduce(tab, { kind: 'request', path: `/api/${'p'.repeat(900)}?token=abc#frag`, status: 502 }, 3)
    const [row] = wireTabs([tab])
    expect(row.app).toHaveLength(120)
    expect(row.errors.last.text).toHaveLength(300)
    expect(row.requests.last.path).not.toMatch(/[?#]/)
    expect(row.requests.last.path.length).toBeLessThanOrEqual(300)
    expect(DevTabSchema.safeParse(row).success).toBe(true)
  })

  it('keeps multibyte messages under the size cap, latest rows kept', () => {
    const tabs = Array.from({ length: 32 }, (_, i) => {
      let t = emptyTab(i, `http://localhost:${3000 + i}/`, '€'.repeat(120), 1)
      t = reduce(t, { kind: 'error', text: '€'.repeat(300) }, 10 + i)
      return reduce(t, { kind: 'request', path: `/${'€'.repeat(299)}`, status: 500 }, 10 + i)
    })
    const rows = wireTabs(tabs)
    const size = new TextEncoder().encode(JSON.stringify({ type: 'dev.tabs', tabs: rows })).length
    expect(size).toBeLessThanOrEqual(60_000)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(32)
    expect(rows[0].tabId).toBe(31)
    expect(rows.map((r: { tabId: number }) => r.tabId)).toEqual(Array.from({ length: rows.length }, (_, i) => 31 - i))
  })

  it('never ends a truncated text on half an emoji', () => {
    let tab = emptyTab(1, 'http://localhost:5173/', `${'a'.repeat(119)}😀`, 1)
    tab = reduce(tab, { kind: 'error', text: `${'a'.repeat(299)}😀` }, 2)
    tab = reduce(tab, { kind: 'request', path: `/${'a'.repeat(298)}😀`, status: 500 }, 3)
    const [row] = wireTabs([tab])
    for (const s of [row.app, row.errors.last.text, row.requests.last.path]) expect(s).not.toMatch(/[\ud800-\udbff]$/)
    expect(row.app).toHaveLength(119)
    expect(row.errors.last.text).toHaveLength(299)
  })

  it('clear marks the open errors and requests seen, keeping counts and the last of each', () => {
    let tab = reduce(emptyTab(1, 'http://localhost:5173/', 'A', 1), { kind: 'error', text: 'x' }, 2)
    tab = reduce(tab, { kind: 'request', path: '/a', status: 500 }, 3)
    const cleared = reduce(tab, { kind: 'clear' }, 4)
    expect(cleared.errors).toEqual({ total: 1, open: 1, seen: 1, last: { text: 'x', at: 2 } })
    expect(cleared.requests).toEqual({ total: 1, open: 1, seen: 1, last: { path: '/a', status: 500, at: 3 } })
    const [row] = wireTabs([cleared])
    expect(row.errors.seen).toBe(1)
    expect(DevTabSchema.safeParse(row).success).toBe(true)
  })

  it('a new error or request after clear is unseen again, and the relay count too', () => {
    let tab = reduce(emptyTab(1, 'http://localhost:5173/', 'A', 1), { kind: 'error', text: 'x' }, 2)
    tab = reduce(tab, { kind: 'request', path: '/a', status: 500 }, 3)
    tab = reduce(tab, { kind: 'clear' }, 4)
    const again = reduce(tab, { kind: 'error', text: 'y' }, 5)
    expect(again.errors).toEqual({ total: 2, open: 2, seen: 1, last: { text: 'y', at: 5 } })
    expect(reduce(tab, { kind: 'request', path: '/b', status: 404 }, 5).requests).toMatchObject({ total: 2, open: 2, seen: 1 })
    expect(reduce(tab, { kind: 'count', n: 4 }, 5).errors).toMatchObject({ total: 5, open: 5, seen: 1 })
  })

  it('a reload or a hot update resets seen with open; another origin starts afresh', () => {
    let tab = reduce(emptyTab(1, 'http://localhost:5173/', 'A', 1), { kind: 'error', text: 'x' }, 2)
    tab = reduce(tab, { kind: 'request', path: '/a', status: 500 }, 3)
    tab = reduce(tab, { kind: 'clear' }, 4)
    const reloaded = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/', title: 'A' }, 5)
    expect(reloaded.errors).toMatchObject({ total: 1, open: 0, seen: 0 })
    expect(reloaded.requests).toMatchObject({ total: 1, open: 0, seen: 0 })
    expect(reduce(tab, { kind: 'hot' }, 5).errors).toMatchObject({ total: 1, open: 0, seen: 0 })
    const other = reduce(tab, { kind: 'navigated', url: 'http://localhost:3000/', title: 'B' }, 5)
    expect(other.errors).toEqual({ total: 0, open: 0, seen: 0, last: null })
  })

  it('clamps seen to open on the wire', () => {
    const tab = { ...emptyTab(1, 'http://localhost:5173/', 'A', 1), errors: { total: 3, open: 2, seen: 9, last: null } }
    const [row] = wireTabs([tab])
    expect(row.errors).toEqual({ total: 3, open: 2, seen: 2, last: null })
    const legacy = { ...emptyTab(2, 'http://localhost:5173/', 'A', 1), errors: { total: 1, open: 1, last: null } }
    expect(wireTabs([legacy])[0].errors.seen).toBe(0)
  })

  it('tells what the server supports', () => {
    expect(fremdevSupport({ modules: { fremplay: true } })).toBe('unsupported')
    expect(fremdevSupport({ modules: { fremplay: true, fremdev: false } })).toBe('disabled')
    expect(fremdevSupport({ modules: { fremplay: true, fremdev: true } })).toBe('yes')
    expect(fremdevSupport({})).toBe('unsupported')
  })

  it('throttles to a first run and one trailing run', () => {
    vi.useFakeTimers()
    try {
      const throttle = new Throttle(500, Date.now, setTimeout)
      const calls: number[] = []
      for (let i = 0; i < 10; i++) throttle.push(() => calls.push(i))
      expect(calls).toEqual([0])
      vi.advanceTimersByTime(500)
      expect(calls).toEqual([0, 9])
      vi.advanceTimersByTime(2000)
      expect(calls).toEqual([0, 9])
    } finally {
      vi.useRealTimers()
    }
  })

  it('calls its timer as a plain function, as a browser\'s setTimeout demands', () => {
    // A browser's setTimeout throws "Illegal invocation" when called as a method of another object.
    const timers: Array<() => void> = []
    const strictTimer = function (this: unknown, fn: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
      timers.push(fn)
    }
    let t = 0
    const throttle = new Throttle(500, () => t, strictTimer)
    const calls: number[] = []
    throttle.push(() => calls.push(1))
    expect(() => throttle.push(() => calls.push(2))).not.toThrow()
    t = 500
    timers.shift()!()
    expect(calls).toEqual([1, 2])
  })
})

describe('devtabs history', () => {
  const base = () => emptyTab(1, 'http://localhost:5173/', 'App', 100)
  const err = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'error', text, ...extra })
  const bytes = (rows: unknown) => new TextEncoder().encode(JSON.stringify({ type: 'dev.tabs', tabs: rows })).length

  it('starts empty, and folds two identical errors into one entry', () => {
    expect(HISTORY_MAX).toBe(20)
    expect(base().history).toEqual([])
    let tab = reduce(base(), err('boom', { origin: '/src/a.js:1:2', stack: ['f /src/a.js:1:2'] }), 200)
    tab = reduce(tab, err('boom', { origin: '/src/a.js:1:2', stack: ['g /src/a.js:1:2'] }), 300)
    expect(tab.history).toEqual([
      { kind: 'error', id: 1, text: 'boom', origin: '/src/a.js:1:2', stack: ['g /src/a.js:1:2'], n: 2, at: 300, state: 'open' },
    ])
    // Another origin is another entry; no origin or stack reads null.
    tab = reduce(tab, err('boom', { origin: '/src/b.js:3:4' }), 400)
    tab = reduce(tab, err('plain'), 500)
    expect(tab.history.map((e: { origin: unknown; n: number }) => [e.origin, e.n])).toEqual([[null, 1], ['/src/b.js:3:4', 1], ['/src/a.js:1:2', 2]])
    expect(tab.history[0].stack).toBeNull()
  })

  it('opens a new entry above a seen one after clear', () => {
    let tab = reduce(base(), err('boom'), 200)
    tab = reduce(tab, { kind: 'clear' }, 250)
    expect(tab.history[0].state).toBe('seen')
    tab = reduce(tab, err('boom'), 300)
    expect(tab.history.map((e: { state: string; n: number }) => [e.state, e.n])).toEqual([['open', 1], ['seen', 1]])
  })

  it('folds the relay overflow into one limited entry, and keeps the totals', () => {
    let tab = reduce(base(), { kind: 'count', n: 40 }, 200)
    tab = reduce(tab, { kind: 'count', n: 40 }, 300)
    expect(tab.history).toEqual([{ kind: 'limited', id: 1, n: 80, at: 300, state: 'open' }])
    expect(tab.errors.total).toBe(80)
    expect(reduce(tab, { kind: 'count', n: 0 }, 400)).toBe(tab)
  })

  it('a page throwing hundreds of errors a second keeps a ring of 20 and its totals (Review Focus 2)', () => {
    let tab = base()
    let total = 0
    for (let s = 0; s < 30; s++) {
      for (let i = 0; i < 10; i++) { tab = reduce(tab, err(`e${s}-${i}`), 1000 * s + i); total++ }
      tab = reduce(tab, { kind: 'count', n: 490 }, 1000 * s + 500)
      total += 490
    }
    expect(tab.history).toHaveLength(20)
    expect(tab.history[0]).toMatchObject({ kind: 'limited', n: 490 })
    expect(tab.errors.total).toBe(total)
  })

  it('keeps the 20 newest of 25 distinct errors, newest first', () => {
    let tab = base()
    for (let i = 0; i < 25; i++) tab = reduce(tab, err(`e${i}`), 200 + i)
    expect(tab.history).toHaveLength(20)
    expect(tab.history.map((e: { text: string }) => e.text)).toEqual(Array.from({ length: 20 }, (_, i) => `e${24 - i}`))
  })

  it('a reload or a hot update resolves; another origin empties', () => {
    let tab = reduce(base(), err('a'), 200)
    tab = reduce(tab, { kind: 'clear' }, 210)
    tab = reduce(tab, err('b'), 220)
    const reloaded = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/x', title: 'X' }, 300)
    expect(reloaded.history.map((e: { state: string }) => e.state)).toEqual(['resolved', 'resolved'])
    expect(reduce(tab, { kind: 'hot' }, 300).history.map((e: { state: string }) => e.state)).toEqual(['resolved', 'resolved'])
    // A resolved entry is never merged into: the same error after a reload is a new one.
    expect(reduce(reloaded, err('b'), 400).history.map((e: { state: string }) => e.state)).toEqual(['open', 'resolved', 'resolved'])
    expect(reduce(tab, { kind: 'navigated', url: 'http://localhost:3000/', title: 'Y' }, 300).history).toEqual([])
  })

  it('keeps a request with its method, and folds the same one', () => {
    let tab = reduce(base(), { kind: 'request', method: 'POST', path: '/api', status: 500 }, 200)
    tab = reduce(tab, { kind: 'request', method: 'POST', path: '/api', status: 500 }, 300)
    tab = reduce(tab, { kind: 'request', method: 'GET', path: '/api', status: 500 }, 400)
    expect(tab.history).toEqual([
      { kind: 'request', id: 2, method: 'GET', path: '/api', status: 500, n: 1, at: 400, state: 'open' },
      { kind: 'request', id: 1, method: 'POST', path: '/api', status: 500, n: 2, at: 300, state: 'open' },
    ])
  })

  it('sends the history without stacks, clamped, in the server shape', () => {
    let tab = reduce(base(), err('e'.repeat(900), { origin: `/${'o'.repeat(900)}`, stack: ['f /a.js:1:2'] }), 200)
    tab = reduce(tab, { kind: 'request', method: 'PROPFIND', path: '/api?token=x#y', status: 502 }, 300)
    tab = reduce(tab, { kind: 'count', n: 3 }, 400)
    const [row] = wireTabs([tab])
    expect(row.history).toHaveLength(3)
    for (const e of row.history) expect(e).not.toHaveProperty('stack')
    expect(row.history[0]).toEqual({ kind: 'limited', id: 3, n: 3, at: 400, state: 'open' })
    expect(row.history[1]).toEqual({ kind: 'request', id: 2, method: 'OTHER', path: '/api', status: 502, n: 1, at: 300, state: 'open' })
    expect(row.history[2].text).toHaveLength(300)
    expect(row.history[2].origin).toHaveLength(300)
    expect(tab.history[2].stack).toEqual(['f /a.js:1:2'])
    expect(validRow(row)).toBe(true)
    expect(DevTabSchema.safeParse(row).success).toBe(true)
  })

  it('validRow and DevTabSchema refuse a bad history alike', () => {
    const tab = reduce(reduce(base(), err('x', { origin: '/a.js:1:2' }), 200), { kind: 'request', method: 'GET', path: '/a', status: 404 }, 300)
    const [row] = wireTabs([tab])
    const entry = { kind: 'error', id: 1, text: 'x', origin: null, n: 1, at: 1, state: 'open' }
    const cases: Array<[string, unknown, boolean]> = [
      ['ok', row.history, true],
      ['empty', [], true],
      ['20 entries', Array.from({ length: 20 }, () => entry), true],
      ['21 entries', Array.from({ length: 21 }, () => entry), false],
      ['unknown kind', [{ ...entry, kind: 'warning' }], false],
      ['unknown state', [{ ...entry, state: 'gone' }], false],
      ['method FOO', [{ ...row.history[0], method: 'FOO' }], false],
      ['n 0', [{ ...entry, n: 0 }], false],
      ['n too big', [{ ...entry, n: 1_000_001 }], false],
      ['a stack', [{ ...entry, stack: ['f /a.js:1:2'] }], false],
      ['long text', [{ ...entry, text: 'x'.repeat(301) }], false],
      ['long origin', [{ ...entry, origin: 'x'.repeat(301) }], false],
      ['path with a query', [{ ...row.history[0], path: '/a?b' }], false],
      ['status 600', [{ ...row.history[0], status: 600 }], false],
      ['limited with text', [{ kind: 'limited', id: 1, n: 2, at: 1, state: 'open', text: 'x' }], false],
      ['limited', [{ kind: 'limited', id: 1, n: 2, at: 1, state: 'seen' }], true],
      ['no id', [{ kind: 'limited', n: 2, at: 1, state: 'seen' }], false],
      ['id 0', [{ ...entry, id: 0 }], false],
      ['not an array', 'all', false],
    ]
    expect(row.history[0].kind).toBe('request')
    for (const [name, history, ok] of cases) {
      const r = { ...row, history }
      expect(validRow(r), name).toBe(ok)
      expect(DevTabSchema.safeParse(r).success, name).toBe(ok)
    }
  })

  it('32 tabs of 20 multibyte entries stay under the cap and keep every row, green history first (Review Focus 6)', () => {
    const tabs = Array.from({ length: 32 }, (_, i) => {
      let t = emptyTab(i, `http://localhost:${3000 + i}/`, `App ${i}`, 1)
      for (let k = 0; k < 20; k++) t = reduce(t, err(`${k}${'é'.repeat(299)}`, { origin: `/${'é'.repeat(299)}` }), 10 + i * 100 + k)
      // Even tabs reload: their entries are resolved and they go green.
      return i % 2 === 0 ? reduce(t, { kind: 'navigated', url: `http://localhost:${3000 + i}/`, title: `App ${i}` }, 10 + i * 100 + 50) : t
    })
    const rows = wireTabs(tabs)
    expect(bytes(rows)).toBeLessThanOrEqual(60_000)
    expect(rows).toHaveLength(32)
    const green = rows.filter((r: { tabId: number }) => r.tabId % 2 === 0)
    const red = rows.filter((r: { tabId: number }) => r.tabId % 2 === 1)
    expect(green.every((r: { history: unknown[] }) => r.history.length === 0)).toBe(true)
    // The red rows keep exactly the newest entries across them, each row a newest-first prefix of
    // its own history, and the next one dropped would not have fitted.
    const fullAts = (id: number) => tabs[id].history.map((e: { at: number }) => e.at)
    const kept = red.flatMap((r: { history: Array<{ at: number }> }) => r.history.map((e) => e.at))
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(16 * 20)
    const cut = Math.min(...kept)
    const allRed = red.flatMap((r: { tabId: number }) => fullAts(r.tabId))
    expect(allRed.filter((at: number) => at >= cut).length).toBe(kept.length)
    for (const r of red) expect(r.history.map((e: { at: number }) => e.at)).toEqual(fullAts(r.tabId).slice(0, r.history.length))
    const next = Math.max(...allRed.filter((at: number) => at < cut))
    const owner = red.find((r: { tabId: number }) => fullAts(r.tabId).includes(next))
    const grown = rows.map((r: { tabId: number; history: unknown[] }) =>
      r === owner ? { ...r, history: [...r.history, wireTabs([tabs[r.tabId]])[0].history[r.history.length]] } : r)
    expect(bytes(grown)).toBeGreaterThan(60_000)
    for (const r of rows) expect(DevTabSchema.safeParse(r).success).toBe(true)
  })

  it('32 tabs full of the cockpit kinds stay under the cap, and perf, inFlight and devServer are never trimmed', () => {
    const PERF = { load: 600_000, lcp: 600_000, cls: 99.999, longTasks: 99_999, heapMb: 65_535 }
    const tabs = Array.from({ length: 32 }, (_, i) => {
      const url = `http://localhost:${3000 + i}/`
      let t = emptyTab(i, url, `${'é'.repeat(119)}${i}`, 1)
      t = reduce(t, { kind: 'devserver', server: 'vite', base: `/${'b'.repeat(98)}/` }, 2)
      t = reduce(t, { kind: 'perf', values: PERF, doc: `D${i}` }, 3)
      t = reduce(t, { kind: 'perf-regression', metric: 'lcp', value: 600_000, ratio: 99.9 }, 4)
      // Fourteen builds, each replacing the last: the newest open, the others resolved.
      for (let k = 0; k < 14; k++) {
        t = reduce(t, { kind: 'build', text: `${k}${'é'.repeat(299)}`, file: `/src/${'é'.repeat(290)}${k}.vue`, line: 9_999_999, col: 9_999_999 }, 10 + k)
      }
      for (let k = 0; k < 5; k++) t = reduce(t, { kind: 'slow', method: 'OPTIONS', path: `/${k}${'é'.repeat(298)}`, ms: 3_600_000 }, 30 + k)
      return reduce(t, { kind: 'inflight', n: 999 }, 40)
    })
    for (const t of tabs) {
      expect(t.history).toHaveLength(HISTORY_MAX)
      expect(new Set(t.history.map((e: { kind: string }) => e.kind))).toEqual(new Set(['build', 'slow', 'perf']))
    }
    const rows = wireTabs(tabs)
    expect(bytes(rows)).toBeLessThanOrEqual(60_000)
    expect(rows).toHaveLength(32)
    // The history gave way; what tells the row's state did not.
    expect(rows.some((r: { history: unknown[] }) => r.history.length < HISTORY_MAX)).toBe(true)
    for (const r of rows) {
      expect(r.perf).toEqual(PERF)
      expect(r.inFlight).toBe(999)
      expect(r.devServer).toBe('vite')
      expect(DevTabSchema.safeParse(r).success).toBe(true)
    }
  })

  it('trims green history before touching a red one, and the oldest entries of the others next', () => {
    const fill = (i: number, at: number) => {
      let t = emptyTab(i, `http://localhost:${3000 + i}/`, `App ${i}`, 1)
      for (let k = 0; k < 20; k++) t = reduce(t, err(`${k}${'é'.repeat(299)}`, { origin: `/${'é'.repeat(299)}` }), at + k)
      return t
    }
    // Tab 0 is green (reloaded), with the newest activity; tabs 1-4 are red.
    const tabs = [1, 2, 3, 4].map((i) => fill(i, i * 100))
    const green = reduce(fill(0, 900), { kind: 'navigated', url: 'http://localhost:3000/', title: 'App 0' }, 1000)
    const rows = wireTabs([green, ...tabs])
    expect(bytes(rows)).toBeLessThanOrEqual(60_000)
    const byId = Object.fromEntries(rows.map((r: { tabId: number }) => [r.tabId, r]))
    expect(byId[0].history).toEqual([])
    // Red tabs lose their oldest entries first: tab 1's (the oldest) go before tab 4's.
    expect(byId[1].history.length).toBeLessThan(byId[4].history.length)
    expect(byId[4].history).toHaveLength(20)
    // What a row keeps is its newest entries.
    for (const r of rows) {
      const ats = r.history.map((e: { at: number }) => e.at)
      expect(ats).toEqual([...ats].sort((a, b) => b - a))
    }
    // Small enough, nothing is trimmed.
    const small = wireTabs([reduce(reduce(base(), err('x'), 2), { kind: 'navigated', url: 'http://localhost:5173/', title: 'A' }, 3)])
    expect(small[0].history).toHaveLength(1)
  })
})

describe('devtabs entry ids and the dev server kind', () => {
  const base = () => emptyTab(1, 'http://localhost:5173/', 'App', 100)
  const err = (text: string) => ({ kind: 'error', text })
  const ids = (tab: { history: Array<{ id: number }> }) => tab.history.map((e) => e.id)

  it('gives two distinct errors ids 1 and 2, and a merge keeps the id', () => {
    expect(base()).toMatchObject({ nextId: 1, devServer: null, serverBase: '/' })
    let tab = reduce(base(), err('a'), 200)
    tab = reduce(tab, err('b'), 300)
    expect(ids(tab)).toEqual([2, 1])
    expect(tab.nextId).toBe(3)
    const merged = reduce(reduce(base(), err('a'), 200), err('a'), 300)
    expect(merged.history).toHaveLength(1)
    expect(merged.history[0]).toMatchObject({ id: 1, n: 2 })
    expect(merged.nextId).toBe(2)
    // A request and a limited entry are stamped too.
    tab = reduce(tab, { kind: 'request', path: '/a', status: 500 }, 400)
    tab = reduce(tab, { kind: 'count', n: 3 }, 500)
    expect(ids(tab)).toEqual([4, 3, 2, 1])
  })

  it('wraps to 1 after 2 147 483 647', () => {
    let tab = { ...base(), nextId: 2_147_483_647 }
    tab = reduce(tab, err('a'), 200)
    expect(tab.history[0].id).toBe(2_147_483_647)
    expect(tab.nextId).toBe(1)
    tab = reduce(tab, err('b'), 300)
    expect(tab.history[0].id).toBe(1)
  })

  it('a cross-origin navigation empties the ring and keeps counting', () => {
    let tab = reduce(reduce(base(), err('a'), 200), err('b'), 300)
    tab = reduce(tab, { kind: 'navigated', url: 'http://localhost:3000/', title: 'Other' }, 400)
    expect(tab.history).toEqual([])
    expect(tab.nextId).toBe(3)
    tab = reduce(tab, err('c'), 500)
    expect(ids(tab)).toEqual([3])
  })

  it('takes the latest dev server detected: same-origin navigations keep it, a fresh detection replaces it, another origin forgets it', () => {
    let tab = reduce(base(), { kind: 'devserver', server: 'vite', base: '/app/' }, 200)
    expect(tab).toMatchObject({ devServer: 'vite', serverBase: '/app/' })
    // A fresh load of the page detects again: Next now listens where Vite did.
    const replaced = reduce(tab, { kind: 'devserver', server: 'next', base: '/' }, 300)
    expect(replaced).toMatchObject({ devServer: 'next', serverBase: '/' })
    // Refused even then: a bad base or kind leaves the kind as it was.
    expect(reduce(tab, { kind: 'devserver', server: 'vite', base: '//evil/' }, 300)).toBe(tab)
    expect(reduce(tab, { kind: 'devserver', server: 'parcel', base: '/' }, 300)).toBe(tab)
    // A fresh load whose kind is unknown (an unusable Vite base): the stale kind goes.
    expect(reduce(tab, { kind: 'devserver', server: null }, 300)).toMatchObject({ devServer: null, serverBase: '/' })
    // A reload, a pushState route change, a hot update: the same origin, the same dev server.
    for (const url of ['http://localhost:5173/', 'http://localhost:5173/x']) {
      expect(reduce(tab, { kind: 'navigated', url, title: 'A' }, 400)).toMatchObject({ devServer: 'vite', serverBase: '/app/' })
    }
    expect(reduce(tab, { kind: 'hot' }, 400)).toMatchObject({ devServer: 'vite', serverBase: '/app/' })
    const other = reduce(tab, { kind: 'navigated', url: 'http://localhost:3000/', title: 'B' }, 400)
    expect(other).toMatchObject({ devServer: null, serverBase: '/' })
    expect(reduce(other, { kind: 'devserver', server: 'next', base: '/' }, 500)).toMatchObject({ devServer: 'next', serverBase: '/' })
  })

  it('sends devServer and each entry id, never serverBase nor nextId', () => {
    let tab = reduce(base(), { kind: 'devserver', server: 'vite', base: '/app/' }, 200)
    tab = reduce(tab, err('a'), 300)
    const [row] = wireTabs([tab])
    expect(row.devServer).toBe('vite')
    expect(row.history[0].id).toBe(1)
    expect(row).not.toHaveProperty('serverBase')
    expect(row).not.toHaveProperty('nextId')
    expect(JSON.stringify(row)).not.toContain('/app/')
    expect(validRow(row)).toBe(true)
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    expect(wireTabs([base()])[0].devServer).toBeNull()
  })

  it('validRow refuses an entry without an id or with id 0, and a dev server outside the list', () => {
    const [row] = wireTabs([reduce(base(), err('a'), 200)])
    const { id: _, ...noId } = row.history[0]
    for (const [name, r] of [
      ['no id', { ...row, history: [noId] }],
      ['id 0', { ...row, history: [{ ...row.history[0], id: 0 }] }],
      ['id 1.5', { ...row, history: [{ ...row.history[0], id: 1.5 }] }],
      ['id too big', { ...row, history: [{ ...row.history[0], id: 2_147_483_648 }] }],
      ['parcel', { ...row, devServer: 'parcel' }],
      ['no devServer', (({ devServer: _d, ...rest }) => rest)(row)],
    ] as Array<[string, unknown]>) expect(validRow(r), name).toBe(false)
    expect(validRow({ ...row, devServer: 'webpack' })).toBe(true)
  })

  it('restoredTabs drops a tab whose nextId is not above every id in its history', () => {
    const good = reduce(reduce(base(), err('a'), 200), err('b'), 300)
    const raw = {
      1: good,
      2: { ...good, tabId: 2, nextId: 1, history: [{ ...good.history[0], id: 3 }] },
      3: { ...good, tabId: 3, nextId: 1.5 },
      4: { ...good, tabId: 4, nextId: undefined },
      5: { ...good, tabId: 5, devServer: 'parcel' },
      6: { ...good, tabId: 6, serverBase: '//evil/' },
      7: { ...good, tabId: 7, history: [{ ...good.history[0], id: undefined }] },
    }
    expect(Object.keys(restoredTabs(raw))).toEqual(['1'])
  })
})

describe('protocol builders', () => {
  it('adds modules to hello only when given', () => {
    expect(hello('t', 'i', undefined, ['fremplay', 'fremdev']).modules).toEqual(['fremplay', 'fremdev'])
    expect('modules' in hello('t', 'i')).toBe(false)
    expect(modulesMsg(['fremdev'])).toEqual({ type: 'modules', modules: ['fremdev'] })
    expect(devTabs([])).toEqual({ type: 'dev.tabs', tabs: [] })
    expect(ping()).toEqual({ type: 'ping' })
    expect(devShot(7, 'data:image/jpeg;base64,/9j/4A==', true)).toEqual({ type: 'dev.shot', tabId: 7, thumb: 'data:image/jpeg;base64,/9j/4A==', sound: true })
    expect(devShot(7, undefined, 'yes')).toEqual({ type: 'dev.shot', tabId: 7, thumb: null, sound: false })
  })
})

describe('devreport', () => {
  const WORDS: Record<string, (...s: unknown[]) => string> = {
    reportTitle: () => 'Bug report',
    reportServer: () => 'dev server',
    reportLines: () => 'Line numbers are those of the code the dev server sent.',
    reportErrors: (open, total) => `Errors (${open} open, ${total} total)`,
    reportRequests: () => 'Failed requests',
    reportLimited: () => 'errors over the rate limit',
    stateSeen: () => 'seen',
    stateResolved: () => 'resolved',
    noAnswer: () => 'no answer',
  }
  const fmt = (stack = false) => ({
    stack,
    now: 9_000,
    t: (key: string, ...subs: unknown[]) => WORDS[key](...subs),
    time: (ms: number) => `T${ms}`,
    date: (ms: number) => `D${ms}`,
  })
  const err = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'error', text, ...extra })

  function sample() {
    let tab = emptyTab(7, 'http://localhost:5173/cart?token=x#y', 'Shop', 0)
    tab = reduce(tab, err('TypeError: boom', { origin: '/src/Cart.vue:42:17', stack: ['setup /src/Cart.vue:42:17', 'run /src/main.js:3:1'] }), 1_000)
    tab = reduce(tab, { kind: 'clear' }, 1_500)
    tab = reduce(tab, err('ReferenceError: x', { origin: '/src/a.js:1:2' }), 2_000)
    tab = reduce(tab, err('ReferenceError: x', { origin: '/src/a.js:1:2' }), 2_500)
    tab = reduce(tab, { kind: 'request', method: 'POST', path: '/api/cart', status: 500 }, 3_000)
    tab = reduce(tab, { kind: 'request', method: 'GET', path: '/api/me', status: 0 }, 3_200)
    return reduce(tab, { kind: 'server', state: 'down' }, 3_500)
  }

  it('writes the report of a tab: its errors, its failed requests and its server', () => {
    expect(REPORT_MAX).toBe(48_000)
    expect(buildReport(sample(), fmt())).toBe(
      [
        '## Bug report: Shop (localhost:5173/cart)',
        'D9000 · dev server: down',
        'Line numbers are those of the code the dev server sent.',
        '',
        '### Errors (3 open, 3 total)',
        '- T2500 ×2 ReferenceError: x',
        '  at /src/a.js:1:2',
        '- T1000 TypeError: boom (seen)',
        '  at /src/Cart.vue:42:17',
        '',
        '### Failed requests',
        '- T3200 GET /api/me no answer',
        '- T3000 POST /api/cart 500',
      ].join('\n'),
    )
  })

  it('adds the frames after the first with the stack, and tags resolved entries and the overflow', () => {
    let tab = sample()
    tab = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/cart', title: 'Shop' }, 4_000)
    tab = reduce(tab, { kind: 'count', n: 40 }, 5_000)
    const text = buildReport(tab, fmt(true))
    expect(text).toContain('- T1000 TypeError: boom (resolved)\n  at /src/Cart.vue:42:17\n  ```\n  run /src/main.js:3:1\n  ```\n')
    expect(text).not.toContain('  setup ')
    expect(text).toContain('- T5000 +40 errors over the rate limit\n')
    expect(buildReport(tab, fmt(false))).not.toContain('run /src/main.js')
  })

  it('leaves out a section with no entry, and keeps text on one line', () => {
    let tab = emptyTab(7, 'http://localhost:5173/', '', 0)
    tab = reduce(tab, err('line one\nline two'), 1_000)
    const text = buildReport(tab, fmt())
    expect(text).not.toContain('Failed requests')
    expect(text).toContain('## Bug report: localhost:5173 (localhost:5173/)')
    expect(text).toContain('- T1000 line one line two')
    expect(buildReport(emptyTab(7, 'http://localhost:5173/', 'App', 0), fmt())).not.toContain('###')
  })

  it('never shows the query or the fragment of the tab URL', () => {
    const text = buildReport(sample(), fmt(true))
    expect(text).not.toContain('token')
    expect(text).not.toContain('#y')
  })

  it('stays within 48 000 characters, dropping the oldest entries first', () => {
    let tab = emptyTab(7, 'http://localhost:5173/', 'App', 0)
    const frames = (i: number) => Array.from({ length: 10 }, (_, f) => `f${f} /src/${String(i).padStart(2, '0')}.js:${'9'.repeat(270)}`)
    for (let i = 0; i < 20; i++) tab = reduce(tab, err(`E${String(i).padStart(2, '0')} ${'x'.repeat(290)}`, { origin: `/src/${i}.js:1:1`, stack: frames(i) }), 1_000 + i)
    const full = buildReport(tab, { ...fmt(true), max: Infinity })
    expect(full.length).toBeGreaterThan(REPORT_MAX)
    const text = buildReport(tab, fmt(true))
    expect(text.length).toBeLessThanOrEqual(REPORT_MAX)
    // The newest are kept, with their stacks; the oldest went.
    expect(text).toContain('E19 ')
    expect(text).toContain('f9 /src/19.js')
    expect(text).not.toContain('E00 ')
  })

  it('drops the stacks once the oldest entries are gone', () => {
    let tab = emptyTab(7, 'http://localhost:5173/', 'App', 0)
    tab = reduce(tab, err('old one'), 1_000)
    tab = reduce(tab, err('new one', { origin: '/src/a.js:1:1', stack: ['top /src/a.js:1:1', 'deep ' + 'y'.repeat(60_000)] }), 2_000)
    const text = buildReport(tab, fmt(true))
    expect(text.length).toBeLessThanOrEqual(REPORT_MAX)
    expect(text).toContain('- T2000 new one\n  at /src/a.js:1:1')
    expect(text).not.toContain('old one')
    expect(text).not.toContain('deep ')
  })

  it('keeps the whole dev.report message within 60 000 bytes when the text is multibyte', () => {
    let tab = emptyTab(7, 'http://localhost:5173/', '日本語のアプリ', 0)
    const frames = Array.from({ length: 10 }, (_, f) => `f${f} /src/${'漢'.repeat(180)}.js:1:1`)
    for (let i = 0; i < 20; i++) tab = reduce(tab, err(`E${i} ${'錯'.repeat(290)}`, { origin: `/src/${'字'.repeat(250)}.js:1:1`, stack: frames }), 1_000 + i)
    for (const stack of [false, true]) {
      const msg = reportMessage('6f1c2a5e-8f0b-4c1d-9a3e-2b7d4e5f6a7b', 7, tab, fmt(stack))
      expect(Object.keys(msg).sort()).toEqual(['id', 'tabId', 'text', 'type'])
      expect(msg.type).toBe('dev.report')
      expect(msg.text.length).toBeLessThanOrEqual(REPORT_MAX)
      expect(new TextEncoder().encode(JSON.stringify(msg)).length).toBeLessThanOrEqual(60_000)
      expect(msg.text).toContain('E19 ')
    }
  })

  it('keeps the dev.report message within 60 000 bytes with 20 entries of the largest stacks', () => {
    let tab = emptyTab(7, 'http://localhost:5173/', 'App', 0)
    // MAX_FRAMES frames of 199 characters, multibyte: 5999 joined, as much as MAX_STACK allows.
    const frames = (i: number) => boundFrames(Array.from({ length: MAX_FRAMES }, (_, f) =>
      `f${String(f).padStart(2, '0')} /src/${String(i).padStart(2, '0')}/${'é'.repeat(187)}`))
    for (let i = 0; i < 20; i++) {
      const stack = frames(i)
      expect(stack).toHaveLength(MAX_FRAMES)
      expect(stack.join('\n').length).toBe(MAX_STACK - 1)
      tab = reduce(tab, err(`E${String(i).padStart(2, '0')} ${'x'.repeat(290)}`, { origin: stack[0], stack }), 1_000 + i)
    }
    const msg = reportMessage('6f1c2a5e-8f0b-4c1d-9a3e-2b7d4e5f6a7b', 7, tab, fmt(true))
    expect(msg.text.length).toBeLessThanOrEqual(REPORT_MAX)
    expect(new TextEncoder().encode(JSON.stringify(msg)).length).toBeLessThanOrEqual(60_000)
    // The newest entry keeps its stack; the oldest went first.
    expect(msg.text).toContain('E19 ')
    expect(msg.text).toContain('\n  f29 /src/19/')
    expect(msg.text).not.toContain('E00 ')
  })
})

describe('build entries', () => {
  const base = () => emptyTab(1, 'http://localhost:5173/', 'App', 100)
  const build = (text: string, extra: Record<string, unknown> = {}) => ({ kind: 'build', text, file: '/Users/example/app/src/App.vue', line: 12, col: 3, ...extra })
  const builds = (tab: { history: Array<{ kind: string; state: string }> }) => tab.history.filter((e) => e.kind === 'build')

  it('homePath writes every home folder as ~/ and leaves anything else', () => {
    expect(homePath('/Users/example/app/x.ts')).toBe('~/app/x.ts')
    expect(homePath('at /Users/Jane Example/a.js and /Users/b/c')).toBe('at ~/a.js and ~/c')
    expect(homePath('/var/tmp/x')).toBe('/var/tmp/x')
    // A line break ends the name: the next line is not swallowed.
    expect(homePath('/Users/a\n/Users/b/c')).toBe('~\n~/c')
    // A name cut by the end of the text (a clipped message) goes too.
    expect(homePath('failed in /Users/Jane Ex')).toBe('failed in ~')
    expect(homePath('from /Users/jane')).toBe('from ~')
    // Inside a path the slash before it stays.
    expect(homePath('/@fs/Users/Jane Example/a.js')).toBe('/@fs/~/a.js')
    expect(homePath('http://localhost:5173/@fs/Users/jane/a.js:1:2')).toBe('http://localhost:5173/@fs/~/a.js:1:2')
    expect(homePath('at f (/Users/jane/a.js:1:2)')).toBe('at f (~/a.js:1:2)')
    // Percent-encoded inside a URL, in either case of %2F.
    expect(homePath('/files/%2FUsers%2Fjane%2Fa.js')).toBe('/files/%2F~%2Fa.js')
    expect(homePath('/files/%2fUsers%2fJane%20Example%2fa.js')).toBe('/files/%2F~%2fa.js')
    expect(homePath('GET /f/%2FUsers%2Fjane/a.js')).toBe('GET /f/%2F~/a.js')
    expect(homePath('/f?p=%2FUsers%2FJane%20Ex')).toBe('/f?p=%2F~')
    expect(homePath('/files/%2Fvar%2Ftmp%2Fa.js')).toBe('/files/%2Fvar%2Ftmp%2Fa.js')
  })

  it('never lets a name out when the text was cut inside it', () => {
    // build.js and the worker clip to 300 before the wire: the cut can land inside the name.
    const text = `${'x'.repeat(285)} /Users/Jane Ex`
    expect(text).toHaveLength(300)
    const tab = reduce(base(), build(text), 200)
    const [row] = wireTabs([tab])
    expect(row.history[0].text).toBe(`${'x'.repeat(285)} ~`)
    expect(row.errors.last.text).toBe(`${'x'.repeat(285)} ~`)
    const err = wireTabs([reduce(base(), { kind: 'error', text }, 200)])[0]
    expect(JSON.stringify(err)).not.toContain('Jane')
    // A file whose cut lands in the name, and one whose home folder only fits after homePath.
    const cut = wireTabs([reduce(base(), build('x', { file: `/a/${'d'.repeat(285)}/Users/Jane Ex` }), 200)])[0]
    expect(cut.history[0].file).not.toContain('Jane')
    const long = wireTabs([reduce(base(), build('x', { file: `/Users/Jane Example/${'d'.repeat(285)}.vue` }), 200)])[0]
    expect(long.history[0].file).toBe(`~/${'d'.repeat(285)}.vue`)
  })

  it('writes a home folder ~ in error origins, request paths and the report\'s frames, the extension keeping the full value', () => {
    let tab = reduce(base(), {
      kind: 'error',
      text: 'TypeError: x',
      origin: '/@fs/Users/Jane Example/pkg/a.js:1:2',
      stack: ['f /@fs/Users/Jane Example/pkg/a.js:1:2', 'g http://localhost:5173/@fs/Users/Jane Example/pkg/b.js:3:4'],
    }, 200)
    tab = reduce(tab, { kind: 'request', method: 'GET', path: '/@fs/Users/Jane Example/pkg/c.js', status: 404 }, 300)
    tab = reduce(tab, { kind: 'request', method: 'GET', path: '/Users/Jane Example/d.js', status: 500 }, 400)
    expect(tab.history[2].origin).toBe('/@fs/Users/Jane Example/pkg/a.js:1:2')
    expect(tab.history[1].path).toBe('/@fs/Users/Jane Example/pkg/c.js')
    const [row] = wireTabs([tab])
    expect(row.history[2].origin).toBe('/@fs/~/pkg/a.js:1:2')
    expect(row.history[1].path).toBe('/@fs/~/pkg/c.js')
    // A bare leading home folder: `~/`, and a request path keeps its leading slash.
    expect(row.history[0].path).toBe('/~/d.js')
    expect(row.requests.last.path).toBe('/~/d.js')
    expect(JSON.stringify(row)).not.toContain('/Users/')
    expect(validRow(row)).toBe(true)
    expect(DevTabSchema.safeParse(row).success).toBe(true)

    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report', reportServer: () => 'dev server', reportLines: () => 'Lines.',
      reportErrors: (open, total) => `Errors (${open} open, ${total} total)`, reportRequests: () => 'Failed requests',
      noAnswer: () => 'no answer', stateSeen: () => 'seen', stateResolved: () => 'resolved',
    }
    const fmt = { stack: true, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` }
    const text = buildReport({ ...tab, title: 'App in /Users/Jane Example/app' }, fmt)
    expect(text).toContain('## Bug report: App in ~/app (localhost:5173/)')
    expect(text).toContain('  at /@fs/~/pkg/a.js:1:2\n  ```\n  g http://localhost:5173/@fs/~/pkg/b.js:3:4\n  ```')
    expect(text).toContain('- T300 GET /@fs/~/pkg/c.js 404')
    expect(text).not.toContain('/Users/')
    expect(wireTabs([{ ...tab, title: 'App in /Users/Jane Example/app' }])[0].app).toBe('App in ~/app')
  })

  it('uncounts an open or seen build entry the ring pushed out', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    tab = reduce(tab, { kind: 'clear' }, 210)
    for (let i = 0; i < HISTORY_MAX; i++) tab = reduce(tab, { kind: 'error', text: `E${i}` }, 300 + i)
    expect(builds(tab)).toEqual([])
    // 21 errors counted, the build gone from the ring: 20 open, the seen build off `seen`.
    expect(tab.errors).toMatchObject({ total: 21, open: 20, seen: 0 })
    expect(tab.errors.seen).toBeLessThanOrEqual(tab.errors.open)
    expect(reduce(tab, { kind: 'build-clear' }, 400).errors.open).toBe(20)
    // A resolved one pushed out was uncounted already.
    let done = reduce(reduce(base(), build('x'), 200), { kind: 'build-clear' }, 250)
    for (let i = 0; i < HISTORY_MAX; i++) done = reduce(done, { kind: 'request', path: `/r${i}`, status: 500 }, 300 + i)
    expect(done.errors).toMatchObject({ total: 1, open: 0, seen: 0 })
    expect(validRow(wireTabs([tab])[0])).toBe(true)
  })

  it('a build error that moved takes the newest line and column, with its id and the tally', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    tab = reduce(tab, build('Invalid end tag.', { line: 14, col: 5 }), 300)
    expect(builds(tab)).toHaveLength(1)
    expect(tab.history[0]).toMatchObject({ id: 1, line: 14, col: 5, n: 1, state: 'open', path: '/Users/example/app/src/App.vue' })
    expect(tab.errors).toMatchObject({ total: 1, open: 1 })
    expect(wireTabs([tab])[0].history[0]).toMatchObject({ file: '~/app/src/App.vue', line: 14, col: 5 })
    tab = reduce(tab, build('Invalid end tag.', { line: undefined, col: undefined }), 400)
    expect(tab.history[0]).toMatchObject({ id: 1, line: null, col: null })
  })

  it('records a build error once however often the overlay says it again', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    const same = reduce(tab, build('Invalid end tag.'), 300)
    expect(same).toBe(tab)
    tab = same
    expect(builds(tab)).toHaveLength(1)
    expect(tab.history[0]).toEqual({ kind: 'build', id: 1, text: 'Invalid end tag.', path: '/Users/example/app/src/App.vue', line: 12, col: 3, frame: null, stack: null, fromConsole: false, folding: false, n: 1, at: 200, state: 'open' })
    expect(tab.errors).toMatchObject({ total: 1, open: 1, seen: 0, last: { text: 'Invalid end tag.', at: 200 } })
  })

  it('a different build error resolves the last one and keeps one open', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    tab = reduce(tab, build('Invalid end tag.', { line: 13 }), 300)
    // Same text and path, another line: the same error, moved.
    expect(builds(tab)).toHaveLength(1)
    expect(tab.errors.open).toBe(1)
    tab = reduce(tab, build('Element is missing end tag.'), 400)
    expect(builds(tab).map((e) => e.state)).toEqual(['open', 'resolved'])
    expect(tab.errors).toMatchObject({ total: 2, open: 1, last: { text: 'Element is missing end tag.' } })
  })

  it('build-clear resolves it, and keeps seen within open after a clear', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    const cleared = reduce(tab, { kind: 'build-clear' }, 300)
    expect(cleared.errors).toMatchObject({ total: 1, open: 0, seen: 0 })
    expect(cleared.history[0].state).toBe('resolved')

    tab = reduce(tab, { kind: 'error', text: 'TypeError: x' }, 250)
    tab = reduce(tab, { kind: 'clear' }, 260)
    expect(tab.errors).toMatchObject({ open: 2, seen: 2 })
    tab = reduce(tab, { kind: 'build-clear' }, 300)
    expect(tab.errors).toMatchObject({ total: 2, open: 1, seen: 1 })
    expect(tab.errors.seen).toBeLessThanOrEqual(tab.errors.open)
    expect(validRow(wireTabs([tab])[0])).toBe(true)
    // Nothing open: build-clear changes nothing.
    expect(reduce(base(), { kind: 'build-clear' }, 300).errors).toMatchObject({ total: 0, open: 0, seen: 0 })
  })

  it('a reload or a hot update resolves a build entry', () => {
    const tab = reduce(base(), build('Invalid end tag.'), 200)
    expect(reduce(tab, { kind: 'hot' }, 300).history[0].state).toBe('resolved')
    expect(reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 300).history[0].state).toBe('resolved')
  })

  it('sends the home folder as ~/ while the extension keeps the full path', () => {
    const tab = reduce(base(), build('Failed at /Users/Jane Example/app/src/App.vue', { file: '/Users/Jane Example/app/src/App.vue' }), 200)
    expect(tab.history[0].path).toBe('/Users/Jane Example/app/src/App.vue')
    const [row] = wireTabs([tab])
    expect(row.history[0]).toEqual({ kind: 'build', id: 1, text: 'Failed at ~/app/src/App.vue', file: '~/app/src/App.vue', line: 12, col: 3, n: 1, at: 200, state: 'open' })
    expect(row.errors.last.text).toBe('Failed at ~/app/src/App.vue')
    expect(JSON.stringify(row)).not.toContain('/Users/')
    expect(validRow(row)).toBe(true)
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    // No file: null, and no line or column either way.
    const bare = wireTabs([reduce(base(), { kind: 'build', text: 'x' }, 200)])[0]
    expect(bare.history[0]).toMatchObject({ file: null, line: null, col: null })
    expect(DevTabSchema.safeParse(bare).success).toBe(true)
  })

  it('validRow and DevTabSchema refuse a build entry with line 0 or an extra key', () => {
    const [row] = wireTabs([reduce(base(), build('x'), 200)])
    const entry = row.history[0]
    for (const [name, bad] of [
      ['line 0', { ...entry, line: 0 }],
      ['col 0', { ...entry, col: 0 }],
      ['line too big', { ...entry, line: 10_000_001 }],
      ['extra key', { ...entry, path: '/Users/example/app/src/App.vue' }],
      ['long file', { ...entry, file: 'x'.repeat(301) }],
    ] as Array<[string, unknown]>) {
      expect(validRow({ ...row, history: [bad] }), name).toBe(false)
      expect(DevTabSchema.safeParse({ ...row, history: [bad] }).success, name).toBe(false)
    }
  })

  it('restores a build entry from the session copy', () => {
    const tab = reduce(base(), build('x'), 200)
    expect(Object.keys(restoredTabs({ 1: tab }))).toEqual(['1'])
  })

  // The Vite overlay of `[vue/compiler-sfc] Unexpected token (3:15)`, as build.js reads it.
  const FRAME = [
    '1  |  <script setup>',
    "2  |  const title = 'Scratch Vite'",
    '3  |  const broken = 1 +* 2',
    '   |                ^',
    '4  |  const other = 3',
  ]
  const STACK = [
    'at constructor (/Users/Jane Example/app/node_modules/@babel/parser/lib/index.js:369:19)',
    'at Parser.raise (/Users/Jane Example/app/node_modules/@babel/parser/lib/index.js:6622:19)',
  ]
  const framed = (extra: Record<string, unknown> = {}) =>
    build('[vue/compiler-sfc] Unexpected token (3:15)', { file: '/Users/Jane Example/app/src/App.vue', line: 3, col: 15, frame: FRAME, stack: STACK, ...extra })

  // What the dev servers' clients log through console.error for a broken build (webpack-dev-server 5,
  // Next 15.5), as the hook and the relay pass them on: clipped to 300.
  const WDS_ERROR = '[webpack-dev-server] ERROR in ./src/index.js 4:15\nModule parse failed: Unexpected token (4:15)\nFile was parsed as module type \'javascript/auto\'.\nYou may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders\n  3 | mountPanel()\n> 4 | const broken = ;\n    |                ^\n  5 | '.slice(0, 300)
  const NEXT_ERROR = './app/page.js\nError:   x Expression expected\n   ,-[/Users/example/app/app/page.js:5:1]\n 2 | import { useEffect } from \'react\'\n 3 | import { mountPanel } from \'./panel.js\'\n 4 | export default function Page() {\n 5 |   const broken = ;\n   :                  ^\n 6 |   useEffect(() => { mountPanel() }, [])\n 7 |   return <main><h1>Scratch Next</h1></main>\n 8 | }\n   `----\n\nCaused by:\n    Syntax Error\n\nImport trace for requested module:\n./app/page.js'.slice(0, 300)
  const WDS_TEXT = "Module parse failed: Unexpected token (4:15) File was parsed as module type 'javascript/auto'. You may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders"

  it('consoleBuild reads a compile error the dev server logs as a build event, drops its status lines, and leaves the rest', () => {
    expect(consoleBuild('[webpack-dev-server] ERROR in ./src/index.js 4:15\nModule parse failed: Unexpected token (4:15)\nFile was parsed as module type \'javascript/auto\'.\nYou may need an appropriate loader to handle this file type, currently no loaders are configured to process this file. See https://webpack.js.org/concepts#loaders\n  3 | mountPanel()\n> 4 | const broken = ;\n    |                ^\n  5 | ')).toEqual({ kind: 'build', text: WDS_TEXT, file: './src/index.js', line: 4, col: 16, fromConsole: true })
    // Clipped by the hook: the same file and place, a shorter text.
    const clipped = consoleBuild(WDS_ERROR)
    expect(clipped).toMatchObject({ kind: 'build', file: './src/index.js', line: 4, col: 16, fromConsole: true })
    expect(WDS_TEXT.startsWith(clipped.text)).toBe(true)
    expect(consoleBuild('[webpack-dev-server] ERROR\nModule not found')).toEqual({ kind: 'build', text: 'Module not found', fromConsole: true })
    expect(consoleBuild('[webpack-dev-server] ERROR in ./src/a.css')).toEqual({ kind: 'build', text: 'ERROR', file: './src/a.css', fromConsole: true })
    expect(consoleBuild(NEXT_ERROR)).toEqual({ kind: 'build', text: 'Expression expected', file: './app/page.js', line: 5, col: 1, fromConsole: true })
    for (const status of [
      '[webpack-dev-server] Errors while compiling. Reload prevented.',
      '[webpack-dev-server] Warnings while compiling.',
      '[webpack-dev-server] Disconnected!',
      '[HMR] Update failed: ChunkLoadError',
    ]) expect(consoleBuild(status), status).toBe('drop')
    for (const runtime of ['TypeError: x', 'Uncaught Error: boom', 'Error: ./app/page.js', './a.js said hi', '[vite] x', '']) {
      expect(consoleBuild(runtime), runtime).toBeNull()
    }
  })

  it("reads a console line by the tab's dev server, and Next's only in SWC's shape", () => {
    const tabOf = (devServer: string | null) => ({ ...base(), devServer })
    const kinds = (devServer: string | null, text: string) => reduce(tabOf(devServer), { kind: 'error', text }, 200).history.map((e: { kind: string }) => e.kind)
    // webpack's rules on a webpack tab or an unknown one, never on Next or Vite.
    expect(kinds('webpack', WDS_ERROR)).toEqual(['build'])
    expect(kinds(null, WDS_ERROR)).toEqual(['build'])
    expect(kinds('next', WDS_ERROR)).toEqual(['error'])
    expect(kinds('vite', WDS_ERROR)).toEqual(['error'])
    expect(kinds('webpack', '[HMR] Update failed: ChunkLoadError')).toEqual([])
    expect(kinds('vite', '[HMR] Update failed: ChunkLoadError')).toEqual(['error'])
    // Next's on a Next tab or an unknown one.
    expect(kinds('next', NEXT_ERROR)).toEqual(['build'])
    expect(kinds(null, NEXT_ERROR)).toEqual(['build'])
    expect(kinds('webpack', NEXT_ERROR)).toEqual(['error'])
    expect(kinds('vite', NEXT_ERROR)).toEqual(['error'])
    // A page's own error that starts with a path is no build error.
    expect(kinds('next', '/api/users\nError: Request failed with status code 500')).toEqual(['error'])
    expect(kinds('next', './a.js\nError:   x Bad')).toEqual(['error'])
    expect(kinds('next', './a.js\nError: Bad\n   ,-[/a.js:1:1]')).toEqual(['error'])
    // The `,-[` line cut by the clip before its place: a build entry with no line.
    expect(consoleBuild('./app/page.js\nError:   x Expression expected\n   ,-[/Users/example/a', 'next')).toEqual({ kind: 'build', text: 'Expression expected', file: './app/page.js', fromConsole: true })
  })

  it('folds the console-born and the overlay-read build error into one entry, which resolves', () => {
    const overlay = { kind: 'build', text: WDS_TEXT, file: './src/index.js', line: 4, col: 16, frame: ['> 4 | const broken = ;', '    |                ^'] }
    // The console first (the client logs before build.js's debounce reads the overlay).
    let tab = reduce(base(), consoleBuild(WDS_ERROR), 200)
    expect(builds(tab)).toHaveLength(1)
    tab = reduce(tab, overlay, 300)
    expect(builds(tab)).toEqual([expect.objectContaining({ id: 1, text: WDS_TEXT, frame: overlay.frame, fromConsole: false, state: 'open' })])
    expect(tab.errors).toMatchObject({ total: 1, open: 1, last: { text: WDS_TEXT } })
    expect(tab.buildTotal).toBe(1)
    // The console says it again on the next compile: nothing new, the frame stays.
    expect(reduce(tab, consoleBuild(WDS_ERROR), 400)).toBe(tab)
    // Fixed: the overlay goes, the one entry resolves.
    const fixed = reduce(tab, { kind: 'build-clear' }, 500)
    expect(builds(fixed).map((e) => e.state)).toEqual(['resolved'])
    expect(fixed.errors).toMatchObject({ total: 1, open: 0 })
    // The overlay first, then the console: still one.
    const other = reduce(reduce(base(), overlay, 200), consoleBuild(WDS_ERROR), 250)
    expect(builds(other)).toHaveLength(1)
    expect(other.errors.total).toBe(1)
    // The overlay off: the console's entry alone, resolved by the hot update or reload that follows a fix.
    const alone = reduce(base(), consoleBuild(NEXT_ERROR), 200)
    expect(builds(alone)).toEqual([expect.objectContaining({ text: 'Expression expected', path: './app/page.js', line: 5, col: 1, state: 'open' })])
    expect(builds(reduce(alone, { kind: 'hot' }, 300))[0].state).toBe('resolved')
    expect(builds(reduce(alone, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 300))[0].state).toBe('resolved')
    // A compile with two errors: webpack-dev-server 5.2.7's client logs one `ERROR in` line each
    // (client/index.js, `errors`), then the overlay shows the first. One entry, counted once.
    const second = "[webpack-dev-server] ERROR in ./src/panel.js 2:3\nModule parse failed: Unexpected token (2:3)\nFile was parsed as module type 'javascript/auto'."
    let two = reduce(base(), consoleBuild(WDS_ERROR), 200)
    two = reduce(two, consoleBuild(second), 201)
    expect(builds(two)).toEqual([expect.objectContaining({ id: 1, path: './src/index.js', state: 'open' })])
    two = reduce(two, overlay, 400)
    expect(builds(two)).toEqual([expect.objectContaining({ id: 1, text: WDS_TEXT, fromConsole: false, state: 'open' })])
    expect(two.errors).toMatchObject({ total: 1, open: 1 })
    expect(two.buildTotal).toBe(1)
    expect(consoleBuild('[webpack-dev-server] ERROR in ./src/a.js (./src/a.js) 3:4\nBad')).toMatchObject({ file: './src/a.js', line: 3, col: 5 })
    // Overlay off, no good compile between two failed ones: each compile's first error line counts.
    const STATUS = '[webpack-dev-server] Errors while compiling. Reload prevented.'
    const err = (text: string) => ({ kind: 'error', text })
    const errB = "[webpack-dev-server] ERROR in ./src/panel.js 2:3\nModule parse failed: Unexpected token (2:3)"
    let next = reduce(reduce(base(), err(STATUS), 100), err(WDS_ERROR), 110)
    next = reduce(reduce(next, err(STATUS), 200), err(errB), 210)
    expect(builds(next).map((e) => [e.state, (e as unknown as { path: string }).path])).toEqual([['open', './src/panel.js'], ['resolved', './src/index.js']])
    expect(next.buildTotal).toBe(2)
    expect(next.errors).toMatchObject({ total: 2, open: 1 })
    // The same error moved: one entry, at its new line.
    const moved = (l: number) => `[webpack-dev-server] ERROR in ./src/index.js ${l}:15\nModule not found: Error: Can't resolve './x'`
    let same = reduce(reduce(base(), err(STATUS), 100), err(moved(4)), 110)
    same = reduce(reduce(same, err(STATUS), 200), err(moved(5)), 210)
    expect(builds(same)).toEqual([expect.objectContaining({ id: 1, line: 5, col: 16, state: 'open', folding: true })])
    expect(same.buildTotal).toBe(1)
    // Within one compile, the second error line still folds; a status line with no console-born entry changes nothing.
    let one = reduce(reduce(reduce(base(), err(STATUS), 100), err(WDS_ERROR), 110), err(errB), 111)
    expect(builds(one)).toHaveLength(1)
    const quiet = reduce(base(), err(STATUS), 100)
    expect(quiet.history).toEqual([])
    // An overlay-read entry is left alone by the status line.
    one = reduce(base(), overlay, 100)
    expect(reduce(one, err(STATUS), 200)).toBe(one)
    // A runtime error logged after the console's build line keeps the tally's last through the takeover.
    let mixed = reduce(base(), consoleBuild(WDS_ERROR), 200)
    mixed = reduce(mixed, { kind: 'error', text: 'TypeError: later' }, 250)
    mixed = reduce(mixed, overlay, 300)
    expect(mixed.errors.last).toEqual({ text: 'TypeError: later', at: 250 })
    expect(builds(mixed)[0]).toMatchObject({ text: WDS_TEXT, fromConsole: false })
    // A session copy with a fromConsole that is no boolean is not ours.
    const kept = reduce(base(), consoleBuild(WDS_ERROR), 200)
    expect(Object.keys(restoredTabs({ 1: kept }))).toEqual(['1'])
    expect(Object.keys(restoredTabs({ 1: { ...kept, history: [{ ...kept.history[0], fromConsole: 'yes' }] } }))).toEqual([])
    // A wire row never says where an entry came from.
    expect(JSON.stringify(wireTabs([alone]))).not.toContain('fromConsole')
    expect(JSON.stringify(wireTabs([alone]))).not.toContain('folding')
    expect(Object.keys(restoredTabs({ 1: { ...alone, history: [{ ...alone.history[0], folding: 1 }] } }))).toEqual([])
  })

  it('boundBuildLines keeps 20 frame lines, 30 stack lines, 300 characters each, 6000 in all', () => {
    expect([MAX_FRAME_LINES, MAX_STACK_LINES, MAX_BUILD_LINE, MAX_BUILD_EXTRA]).toEqual([20, 30, 300, 6_000])
    const many = (n: number, len: number) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(len, 'x'))
    expect(boundBuildLines(many(25, 10), many(35, 10))).toEqual({ frame: many(20, 10), stack: many(30, 10) })
    // The frame first, then as much of the stack as fits: 20 × 301 = 6020 > 6000.
    const wide = boundBuildLines(many(20, 400), many(30, 400))
    expect(wide.frame).toHaveLength(19)
    expect(wide.frame.every((l: string) => l.length === 300)).toBe(true)
    expect(wide.stack).toBeUndefined()
    expect([...wide.frame].join('\n').length).toBeLessThanOrEqual(6_000)
    const mixed = boundBuildLines(many(10, 300), many(30, 300))
    expect(mixed.frame).toHaveLength(10)
    expect(mixed.stack).toHaveLength(9)
    expect(boundBuildLines([], undefined)).toEqual({})
    // Never half of a surrogate pair.
    expect(boundBuildLines(['a'.repeat(299) + '\u{1F600}'], [])).toEqual({ frame: ['a'.repeat(299)] })
  })

  it('keeps a build entry\'s code frame and stack in the worker, never in dev.tabs nor the session copy', () => {
    const tab = reduce(base(), framed(), 200)
    expect(tab.history[0]).toMatchObject({ frame: FRAME, stack: STACK })
    const [row] = wireTabs([tab])
    expect(Object.keys(row.history[0]).sort()).toEqual(['at', 'col', 'file', 'id', 'kind', 'line', 'n', 'state', 'text'])
    expect(JSON.stringify(row)).not.toContain('broken')
    expect(JSON.stringify(row)).not.toContain('Parser')
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    const session = sessionTabs({ 1: tab })[1]
    expect(session.history[0]).toMatchObject({ kind: 'build', frame: null, stack: null, line: 3 })
    expect(JSON.stringify(session)).not.toContain('broken')
    // The session copy comes back, and so does a row from before frames (no such keys).
    expect(Object.keys(restoredTabs({ 1: session }))).toEqual(['1'])
    const { frame: _f, stack: _s, ...older } = tab.history[0]
    expect(Object.keys(restoredTabs({ 1: { ...tab, history: [older] } }))).toEqual(['1'])
    expect(Object.keys(restoredTabs({ 1: { ...tab, history: [{ ...older, frame: 'x' }] } }))).toEqual([])
  })

  it('a folded build entry takes the newest code frame and stack', () => {
    let tab = reduce(base(), framed(), 200)
    expect(reduce(tab, framed(), 250)).toBe(tab)
    const moved = ['5  |  const broken = 1 +* 2', '   |                ^']
    tab = reduce(tab, framed({ frame: moved, stack: undefined }), 300)
    expect(builds(tab)).toHaveLength(1)
    expect(tab.history[0]).toMatchObject({ id: 1, n: 1, frame: moved, stack: null, line: 3 })
    expect(tab.errors).toMatchObject({ total: 1, open: 1 })
  })

  it('reports a build entry\'s code frame and stack only with the stack, its home folder as ~', () => {
    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report', reportServer: () => 'dev server', reportLines: () => 'Lines.',
      reportErrors: (open, total) => `Errors (${open} open, ${total} total)`, reportBuild: () => 'Build',
      stateSeen: () => 'seen', stateResolved: () => 'resolved',
    }
    const fmt = (stack: boolean) => ({ stack, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` })
    const tab = reduce(base(), framed({
      frame: [...FRAME, '   ,-[/Users/Jane Example/app/src/App.vue:3:15]'],
      stack: [...STACK, 'at load (http://localhost:5173/@fs/Users/Jane Example/app/x.js:1:2)', 'at get (/files/%2FUsers%2FJane%20Example%2Fy.js:3:4)'],
    }), 200)
    // GitHub's shape: a fenced block nested in the list item, every line verbatim, two spaces in.
    expect(buildReport(tab, fmt(true))).toContain([
      '### Build',
      '- T200 [vue/compiler-sfc] Unexpected token (3:15)',
      '  at ~/app/src/App.vue:3:15',
      '  ```',
      '  1  |  <script setup>',
      "  2  |  const title = 'Scratch Vite'",
      '  3  |  const broken = 1 +* 2',
      '     |                ^',
      '  4  |  const other = 3',
      '     ,-[~/app/src/App.vue:3:15]',
      '  at constructor (~/app/node_modules/@babel/parser/lib/index.js:369:19)',
      '  at Parser.raise (~/app/node_modules/@babel/parser/lib/index.js:6622:19)',
      '  at load (http://localhost:5173/@fs/~/app/x.js:1:2)',
      '  at get (/files/%2F~%2Fy.js:3:4)',
      '  ```',
    ].join('\n'))
    expect(buildReport(tab, fmt(true))).not.toContain('Users')
    expect(buildReport(tab, fmt(true))).not.toContain('Jane')
    const plain = buildReport(tab, fmt(false))
    expect(plain).toContain('- T200 [vue/compiler-sfc] Unexpected token (3:15)\n  at ~/app/src/App.vue:3:15')
    expect(plain).not.toContain('broken')
    expect(plain).not.toContain('Parser.raise')
  })

  it('writes a build entry with no file as `at L:C`, or with no `at` line, never `unknown file`', () => {
    const fmt = { stack: false, now: 9_000, t: (key: string) => key, time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` }
    const at = (extra: Record<string, unknown>) => buildReport(reduce(base(), build('Bad', extra), 200), fmt).split('\n').slice(-2)
    expect(at({ file: undefined, line: 3, col: 15 })).toEqual(['- T200 Bad', '  at 3:15'])
    expect(at({ file: undefined, line: 3, col: undefined })).toEqual(['- T200 Bad', '  at 3'])
    expect(at({ file: 'unknown file', line: 3, col: 15 })).toEqual(['- T200 Bad', '  at 3:15'])
    expect(at({ file: undefined, line: undefined, col: undefined }).at(-1)).toBe('- T200 Bad')
    expect(at({ file: './src/a.js', line: undefined, col: undefined }).at(-1)).toBe('  at ./src/a.js')
  })

  it("fences webpack's frame with its `> 2 |` line and caret as they are, longer than any backtick run inside", () => {
    const fmt = { stack: true, now: 9_000, t: (key: string) => key, time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` }
    const frame = ["  1 | const a = 1", "> 2 | const b = 1 +* 2", '    |               ^', '  3 | const c = 3']
    const tab = reduce(base(), build('Module parse failed: Unexpected token (2:14)', { file: './src/index.js', line: 2, col: 15, frame }), 200)
    expect(buildReport(tab, fmt)).toContain(
      '  at ./src/index.js:2:15\n  ```\n    1 | const a = 1\n  > 2 | const b = 1 +* 2\n      |               ^\n    3 | const c = 3\n  ```')
    // A line holding a fence of its own: the block's fence is one longer than the longest run.
    const ticks = reduce(base(), build('x', { frame: ['  1 | const md = `a ``` b ````` c`'] }), 200)
    const text = buildReport(ticks, fmt)
    expect(text).toContain('\n  ``````\n    1 | const md = `a ``` b ````` c`\n  ``````')
    // Nothing to show: no empty block.
    expect(buildReport(reduce(base(), build('x'), 200), fmt)).not.toContain('```')
  })

  it('keeps the dev.report message within 60 000 bytes with 20 build entries of the largest frames and stacks', () => {
    let tab = base()
    const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(2, '0')} ${'é'.repeat(196)}`)
    for (let i = 0; i < 20; i++) {
      const ev = { kind: 'build', text: `B${String(i).padStart(2, '0')} ${'x'.repeat(290)}`, file: `/Users/example/app/src/${i}.vue`, ...boundBuildLines(lines(MAX_FRAME_LINES + 5, 'F'), lines(MAX_STACK_LINES + 5, 'S')) }
      expect(ev.frame).toHaveLength(MAX_FRAME_LINES)
      expect([...ev.frame, ...ev.stack].join('\n').length).toBeLessThanOrEqual(MAX_BUILD_EXTRA)
      tab = reduce(tab, ev, 1_000 + i)
    }
    expect(builds(tab)).toHaveLength(20)
    const msg = reportMessage('6f1c2a5e-8f0b-4c1d-9a3e-2b7d4e5f6a7b', 1, tab, {
      stack: true, now: 9_000, t: (key: string) => key, time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}`,
    })
    expect(msg.text.length).toBeLessThanOrEqual(REPORT_MAX)
    expect(new TextEncoder().encode(JSON.stringify(msg)).length).toBeLessThanOrEqual(60_000)
    expect(msg.text).toContain('B19 ')
    expect(msg.text).toContain('\n  F19 ')
    expect(msg.text).not.toContain('B00 ')
  })

  it('reports a Build section with ~/ paths', () => {
    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report',
      reportServer: () => 'dev server',
      reportLines: () => 'Line numbers are those of the code the dev server sent.',
      reportErrors: (open, total) => `Errors (${open} open, ${total} total)`,
      reportBuild: (open, total) => `Build (${open} open, ${total} total)`,
      stateSeen: () => 'seen',
      stateResolved: () => 'resolved',
    }
    const fmt = { stack: false, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` }
    let tab = reduce(base(), { kind: 'error', text: 'TypeError: x', origin: '/src/a.js:1:2' }, 150)
    tab = reduce(tab, build('Invalid end tag in /Users/Jane Example/app/src/App.vue', { file: '/Users/Jane Example/app/src/App.vue' }), 200)
    const text = buildReport(tab, fmt)
    // Each section counts its own entries: the tab's tally (2 open, 2 total) holds both.
    expect(tab.errors).toMatchObject({ open: 2, total: 2 })
    expect(text).toContain('### Build (1 open, 1 total)\n- T200 Invalid end tag in ~/app/src/App.vue\n  at ~/app/src/App.vue:12:3\n\n### Errors (1 open, 1 total)\n- T150 TypeError: x\n')
    expect(text).not.toContain('/Users/')

    // The owner's case: an old build resolved, a new one open, three runtime errors (one seen).
    tab = reduce(tab, build('Unexpected token (3:15)'), 300)
    tab = reduce(tab, { kind: 'error', text: 'Uncaught TypeError: y' }, 400)
    tab = reduce(tab, { kind: 'clear' }, 450)
    tab = reduce(tab, { kind: 'error', text: 'Uncaught (in promise) Error: z' }, 500)
    expect(tab.errors).toMatchObject({ open: 4, total: 5 })
    expect(tab.buildTotal).toBe(2)
    const again = buildReport(tab, fmt)
    expect(again).toContain('### Build (1 open, 2 total)\n')
    expect(again).toContain('### Errors (3 open, 3 total)\n')
    // A build-clear: none open; the errors keep theirs.
    const cleared = buildReport(reduce(tab, { kind: 'build-clear' }, 600), fmt)
    expect(cleared).toContain('### Build (0 open, 2 total)\n')
    expect(cleared).toContain('### Errors (3 open, 3 total)\n')
    // The count stays in the extension, and a row from before it restores with none.
    expect(JSON.stringify(wireTabs([tab]))).not.toContain('buildTotal')
    const { buildTotal: _b, ...older } = tab
    expect(restoredTabs({ 1: older })[1].buildTotal).toBe(0)
    expect(restoredTabs({ 1: tab })[1].buildTotal).toBe(2)

    // Another origin starts the counts again, the build count with them.
    let moved = reduce(tab, { kind: 'navigated', url: 'http://localhost:5174/', title: 'Other' }, 700)
    expect(moved.buildTotal).toBe(0)
    moved = reduce(moved, build('Unexpected token (1:1)'), 800)
    moved = reduce(moved, { kind: 'error', text: 'E1' }, 900)
    moved = reduce(moved, { kind: 'error', text: 'E2' }, 950)
    const fresh = buildReport(moved, fmt)
    expect(fresh).toContain('### Build (1 open, 1 total)\n')
    expect(fresh).toContain('### Errors (2 open, 2 total)\n')
    // A stale count is never more than the errors total it is part of.
    expect(buildReport({ ...moved, buildTotal: 99 }, fmt)).toContain('### Build (1 open, 3 total)\n')
  })
})

describe('devopen', () => {
  const tabAt = (url: string, devServer: string | null, serverBase = '/') => ({ ...emptyTab(7, url, 'App', 1_000), devServer, serverBase })
  const vite = (base = '/') => tabAt('http://localhost:5173/', 'vite', base)
  const error = (origin: string | null) => ({ kind: 'error', id: 1, text: 'TypeError', origin, stack: null, n: 1, at: 1, state: 'open' })
  const build = (path: string | null, line: number | null, col: number | null) =>
    ({ kind: 'build', id: 2, text: 'Unexpected token', path, line, col, n: 1, at: 1, state: 'open' })

  it('reads a place as path, line and column', () => {
    expect(parsePlace('/src/a.js:42:17')).toEqual({ path: '/src/a.js', line: 42, col: 17 })
    expect(parsePlace('/a:b.js:1:2')).toEqual({ path: '/a:b.js', line: 1, col: 2 })
    expect(parsePlace('/src/a.js:42')).toBeNull()
    expect(parsePlace('/src/a.js')).toBeNull()
  })

  it('opens a Vite error through __open-in-editor, its path relative to the root', () => {
    expect(editorUrl(vite(), error('/src/components/Cart.vue:42:17')))
      .toBe('http://localhost:5173/__open-in-editor?file=src%2Fcomponents%2FCart.vue%3A42%3A17')
  })

  it('turns a Vite /@fs/ path back into the absolute one', () => {
    expect(editorUrl(vite(), error('/@fs/Users/example/lib/x.js:3:1')))
      .toBe('http://localhost:5173/__open-in-editor?file=%2FUsers%2Fexample%2Flib%2Fx.js%3A3%3A1')
  })

  it('decodes the URL path an origin carries, so a folder with a space opens', () => {
    expect(editorUrl(vite(), error('/@fs/Users/Jane%20Example/lib/x.js:3:1')))
      .toBe('http://localhost:5173/__open-in-editor?file=%2FUsers%2FJane%20Example%2Flib%2Fx.js%3A3%3A1')
    expect(editorUrl(vite(), error('/src/%E0%A4%A.js:1:1'))).toBeNull()
  })

  it('strips the Vite base, and asks the endpoint under it', () => {
    expect(editorUrl(vite('/app/'), error('/app/src/main.ts:1:1')))
      .toBe('http://localhost:5173/app/__open-in-editor?file=src%2Fmain.ts%3A1%3A1')
    expect(editorUrl(vite('/app/'), error('/app/@fs/Users/example/lib/x.js:3:1')))
      .toBe('http://localhost:5173/app/__open-in-editor?file=%2FUsers%2Fexample%2Flib%2Fx.js%3A3%3A1')
  })

  it('opens nothing for an error from another origin, or none', () => {
    expect(editorUrl(vite(), error('cdn.example.com/lib.js:1:2'))).toBeNull()
    expect(editorUrl(vite(), error('//evil.example/x.js:1:1'))).toBeNull()
    expect(editorUrl(vite(), error(null))).toBeNull()
    expect(editorUrl(vite(), error('/src/a.js'))).toBeNull()
  })

  it('checks a Vite error path again once decoded: no //, NUL, .. segment or scheme', () => {
    for (const origin of [
      '/%2F/evil.example/x.js:1:1',
      '/%2Fevil.example/x.js:1:1',
      '/@fs/%2Fevil.example/x.js:1:1',
      '/src/%00x.js:1:1',
      '/src/%2E%2E/%2E%2E/etc/x.js:1:1',
      '/src/..%5C..%5Cx.js:1:1',
      '/file:%2F%2F%2Fetc/x.js:1:1',
      '/@fs/file:///etc/x.js:1:1',
      '/http:%2F%2Fevil.example/x.js:1:1',
    ]) expect(editorUrl(vite(), error(origin)), origin).toBeNull()
    // A colon further in is a file name, not a scheme.
    expect(editorUrl(vite(), error('/src/a%3Ab.js:1:1'))).toBe('http://localhost:5173/__open-in-editor?file=src%2Fa%3Ab.js%3A1%3A1')
  })

  it('opens nothing under a Vite base that is not a valid one, whatever the tab holds', () => {
    for (const base of ['//evil.example/', '/a/../', '/app', 'app/', '/a?b/', '', null]) {
      expect(editorUrl(vite(base as string), error('/src/a.js:1:1')), String(base)).toBeNull()
      expect(editorUrl(vite(base as string), build('/Users/example/a.js', 1, 1)), String(base)).toBeNull()
    }
  })

  it('opens a Vite build entry by its full path, a home folder with a space included (Review Focus 4)', () => {
    expect(editorUrl(vite(), build('/Users/Jane Example/app/src/App.vue', 12, 3)))
      .toBe('http://localhost:5173/__open-in-editor?file=%2FUsers%2FJane%20Example%2Fapp%2Fsrc%2FApp.vue%3A12%3A3')
    expect(editorUrl(vite(), build('/Users/example/app/src/App.vue', 12, null)))
      .toBe('http://localhost:5173/__open-in-editor?file=%2FUsers%2Fexample%2Fapp%2Fsrc%2FApp.vue')
    expect(editorUrl(vite('/app/'), build('/Users/example/app/src/App.vue', 1, 1)))
      .toBe('http://localhost:5173/app/__open-in-editor?file=%2FUsers%2Fexample%2Fapp%2Fsrc%2FApp.vue%3A1%3A1')
    expect(editorUrl(vite(), build(null, 1, 1))).toBeNull()
  })

  it('opens a Next build entry through __nextjs_launch-editor, and no runtime error', () => {
    const next = tabAt('http://localhost:3000/', 'next')
    // Next 15.5 reads line1 and column1 (checked against a real 15.5 server: without them it opens
    // line 1); earlier releases read lineNumber and column. Both pairs go.
    expect(editorUrl(next, build('./src/app/page.tsx', 3, 5)))
      .toBe('http://localhost:3000/__nextjs_launch-editor?file=.%2Fsrc%2Fapp%2Fpage.tsx&lineNumber=3&column=5&line1=3&column1=5')
    expect(editorUrl(next, build('./src/app/page.tsx', null, null)))
      .toBe('http://localhost:3000/__nextjs_launch-editor?file=.%2Fsrc%2Fapp%2Fpage.tsx')
    expect(editorUrl(next, error('/_next/static/chunks/app/page.js:1:2'))).toBeNull()
  })

  it('opens a webpack build entry through webpack-dev-server/open-editor, and no runtime error', () => {
    const webpack = tabAt('http://localhost:8080/', 'webpack')
    expect(editorUrl(webpack, build('./src/index.js', 10, 2)))
      .toBe('http://localhost:8080/webpack-dev-server/open-editor?fileName=.%2Fsrc%2Findex.js%3A10%3A2')
    expect(editorUrl(webpack, build('./src/index.js', null, null)))
      .toBe('http://localhost:8080/webpack-dev-server/open-editor?fileName=.%2Fsrc%2Findex.js')
    expect(editorUrl(webpack, error('/main.js:1:2'))).toBeNull()
  })

  it('opens nothing for an unknown dev server, a request, or a tab URL that does not parse', () => {
    expect(editorUrl(tabAt('http://localhost:5173/', null), build('./src/index.js', 1, 1))).toBeNull()
    expect(editorUrl(vite(), { kind: 'request', id: 3, method: 'GET', path: '/api', status: 500, n: 1, at: 1, state: 'open' })).toBeNull()
    expect(editorUrl(vite(), { kind: 'limited', id: 4, n: 1, at: 1, state: 'open' })).toBeNull()
    expect(editorUrl({ ...vite(), url: 'not a url' }, error('/src/a.js:1:1'))).toBeNull()
  })

  it('always asks the tab\'s own origin, whatever the entry says', () => {
    const cases: Array<[ReturnType<typeof tabAt>, unknown]> = [
      [vite(), error('/src/a.js:1:1')],
      [vite('/app/'), error('/app/@fs/Users/example/x.js:1:1')],
      [vite(), build('http://evil.example/x.js', 1, 1)],
      [tabAt('http://app.localhost:3000/x', 'next'), build('//evil.example/x', 1, 1)],
      [tabAt('https://localhost:8443/a/b', 'webpack'), build('@evil.example/x', 1, 1)],
    ]
    for (const [tab, entry] of cases) {
      const url = editorUrl(tab, entry)
      expect(url, JSON.stringify(entry)).not.toBeNull()
      expect(new URL(url!).origin).toBe(new URL(tab.url).origin)
    }
  })
})

describe('slow requests and requests in flight', () => {
  const base = () => emptyTab(1, 'http://localhost:5173/', 'App', 100)
  const slow = (ms: number, path = '/api/items', method = 'GET') => ({ kind: 'slow', method, path, ms })

  it('InFlight times a request from its start to its finish', () => {
    expect(SLOW_MS).toBe(1000)
    expect(STALE_MS).toBe(30_000)
    expect(MAX_IN_FLIGHT).toBe(999)
    expect(MAX_TRACKED).toBe(4096)
    const f = new InFlight()
    f.start('r1', 7, 10_000)
    expect(f.finish('r1', 11_200)).toEqual({ tabId: 7, ms: 1200 })
    // Finished once: a second finish (onErrorOccurred after onCompleted) finds nothing.
    expect(f.finish('r1', 11_300)).toBeNull()
    expect(f.finish('never', 11_300)).toBeNull()
  })

  it('InFlight counts the pending requests of a tab, forgetting those started over 30 s ago', () => {
    const f = new InFlight()
    f.start('a', 7, 1_000)
    f.start('b', 7, 1_000)
    f.start('c', 8, 1_000)
    expect(f.count(7, 2_000)).toBe(2)
    expect(f.count(7, 31_000)).toBe(2)
    expect(f.count(7, 31_001)).toBe(0)
    // Forgotten: finishing it later times nothing.
    expect(f.finish('a', 40_000)).toBeNull()
    // A long poll that finishes past 30 s without a count in between is not timed either.
    expect(f.finish('c', 31_002)).toBeNull()
    // prune forgets every stale request, whatever its tab.
    f.start('d', 7, 40_000)
    f.start('e', 8, 50_000)
    f.prune(70_001)
    expect(f.size).toBe(1)
    expect(f.nextStale()).toBe(80_000)
  })

  it('InFlight caps the count at 999 and keeps at most 4096 requests, dropping the oldest', () => {
    const f = new InFlight()
    for (let i = 0; i < 1000; i++) f.start(`r${i}`, 7, 1_000)
    expect(f.count(7, 1_000)).toBe(999)
    const g = new InFlight()
    // start says whose request it dropped for room, for that tab's count.
    const evicted = Array.from({ length: 4097 }, (_, i) => g.start(`r${i}`, i % 2, 1_000 + i))
    expect(evicted.slice(0, 4096).every((e) => e === null)).toBe(true)
    expect(evicted[4096]).toBe(0)
    expect(g.size).toBe(4096)
    expect(g.finish('r0', 5_000)).toBeNull()
    expect(g.finish('r1', 5_000)).toEqual({ tabId: 1, ms: 5_000 - 1_001 })
    g.forgetTab(0)
    expect(g.count(0, 5_000)).toBe(0)
    expect(g.size).toBe(2047)
    expect(g.count(1, 5_000)).toBe(999)
  })

  it('reduce folds two slow requests for the same method and path into one, with the latest ms', () => {
    let tab = reduce(base(), slow(1500), 200)
    tab = reduce(tab, slow(1200), 300)
    expect(tab.history).toEqual([{ kind: 'slow', id: 1, method: 'GET', path: '/api/items', ms: 1200, n: 2, at: 300, state: 'open' }])
    // Folded into the newest open slow entry, even with another entry since.
    tab = reduce(tab, { kind: 'error', text: 'x' }, 400)
    tab = reduce(tab, slow(2000), 500)
    expect(tab.history.map((e: { kind: string; n: number; id: number }) => [e.kind, e.n, e.id])).toEqual([['slow', 3, 1], ['error', 1, 2]])
    // Another path, or a resolved one, makes a new entry.
    tab = reduce(tab, slow(1000, '/api/other'), 600)
    expect(tab.history[0]).toMatchObject({ kind: 'slow', id: 3, path: '/api/other', n: 1 })
    tab = reduce(reduce(tab, { kind: 'hot' }, 700), slow(1000, '/api/other'), 800)
    expect(tab.history[0]).toMatchObject({ kind: 'slow', id: 4, n: 1, state: 'open' })
  })

  it('reduce leaves the tallies and the activity alone for a slow request', () => {
    let tab = reduce(base(), { kind: 'error', text: 'x' }, 150)
    tab = reduce(tab, { kind: 'request', path: '/api', status: 500 }, 160)
    const next = reduce(tab, slow(1500), 900)
    expect(next.errors).toEqual(tab.errors)
    expect(next.requests).toEqual(tab.requests)
    expect(next.activity).toBe(160)
    // Slow entries make room among themselves: at most SLOW_MAX, the counted entries kept.
    expect(SLOW_MAX).toBe(5)
    let full = tab
    for (let i = 0; i < HISTORY_MAX + 3; i++) full = reduce(full, slow(1500, `/api/${i}`), 1_000 + i)
    expect(full.history).toHaveLength(SLOW_MAX + 2)
    expect(full.history.filter((e: { kind: string }) => e.kind === 'slow').map((e: { path: string }) => e.path))
      .toEqual(['/api/22', '/api/21', '/api/20', '/api/19', '/api/18'])
    expect(full.errors).toEqual(tab.errors)
    expect(full.requests).toEqual(tab.requests)
  })

  it('never lets slow entries push a live build entry out: A/B/A/B keeps the light red', () => {
    let tab = reduce(base(), { kind: 'build', text: 'Invalid end tag.', file: '/Users/example/app/src/App.vue', line: 1, col: 1 }, 150)
    for (let i = 0; i < 18; i++) tab = reduce(tab, { kind: 'error', text: `e${i}` }, 160 + i)
    const before = tab.errors
    expect(tab.history).toHaveLength(19)
    for (let i = 0; i < 40; i++) tab = reduce(tab, slow(1500, i % 2 === 0 ? '/api/a' : '/api/b'), 200 + i)
    expect(tab.errors).toEqual(before)
    expect(tab.errors.open).toBe(19)
    expect(tab.history.some((e: { kind: string; state: string }) => e.kind === 'build' && e.state === 'open')).toBe(true)
    // The ring was full but for one slot: one slow entry, the latest, has it.
    expect(tab.history.filter((e: { kind: string }) => e.kind === 'slow')).toEqual([expect.objectContaining({ path: '/api/b', at: 239 })])
    expect(tab.history).toHaveLength(HISTORY_MAX)
  })

  it('makes room for a fault with a slow entry first, then a resolved one: slow entries never crowd out the faults', () => {
    let tab = base()
    for (let i = 0; i < 15; i++) tab = reduce(tab, { kind: 'error', text: `e${i}` }, 100 + i)
    for (let i = 0; i < SLOW_MAX; i++) tab = reduce(tab, slow(1500, `/api/${i}`), 200 + i)
    expect(tab.history).toHaveLength(HISTORY_MAX)
    tab = reduce(tab, { kind: 'error', text: 'e15' }, 300)
    const texts = tab.history.filter((e: { kind: string }) => e.kind === 'error').map((e: { text: string }) => e.text)
    expect(texts).toHaveLength(16)
    expect(texts.at(-1)).toBe('e0')
    // The oldest slow entry made the room.
    expect(tab.history.filter((e: { kind: string }) => e.kind === 'slow').map((e: { path: string }) => e.path))
      .toEqual(['/api/4', '/api/3', '/api/2', '/api/1'])
    // No slow entry left: a resolved one goes before an open one.
    let mixed = base()
    for (let i = 0; i < 10; i++) mixed = reduce(mixed, { kind: 'error', text: `old${i}` }, 100 + i)
    mixed = reduce(mixed, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 150)
    for (let i = 0; i < 10; i++) mixed = reduce(mixed, { kind: 'error', text: `new${i}` }, 200 + i)
    mixed = reduce(mixed, { kind: 'error', text: 'new10' }, 300)
    const kept = mixed.history.map((e: { text: string }) => e.text)
    expect(kept).not.toContain('old0')
    expect(kept).toContain('new0')
    expect(mixed.errors.open).toBe(11)
  })

  it('drops a slow entry when the ring is full of open entries, and takes the oldest resolved slot otherwise', () => {
    let tab = base()
    for (let i = 0; i < HISTORY_MAX; i++) tab = reduce(tab, { kind: 'error', text: `e${i}` }, 100 + i)
    const full = tab
    expect(reduce(full, slow(1500), 500)).toBe(full)
    // A reload resolves them all: the slow entry takes the oldest one's place.
    tab = reduce(full, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 600)
    tab = reduce(tab, slow(1500), 700)
    expect(tab.history).toHaveLength(HISTORY_MAX)
    expect(tab.history[0]).toMatchObject({ kind: 'slow', state: 'open' })
    expect(tab.history.map((e: { text?: string }) => e.text)).not.toContain('e0')
    expect(tab.history.at(-1)).toMatchObject({ text: 'e1' })
  })

  it('reduce sets inFlight without stamping the activity, and a navigation to another origin sets it to 0', () => {
    expect(base().inFlight).toBe(0)
    const tab = reduce(base(), { kind: 'inflight', n: 3 }, 900)
    expect(tab.inFlight).toBe(3)
    expect(tab.activity).toBe(100)
    expect(reduce(tab, { kind: 'inflight', n: 5000 }, 900).inFlight).toBe(999)
    // The same origin keeps it (the worker still times those requests); another starts at 0.
    expect(reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/x', title: '' }, 950).inFlight).toBe(3)
    expect(reduce(tab, { kind: 'navigated', url: 'http://localhost:3000/', title: '' }, 950).inFlight).toBe(0)
  })

  it('wireRow carries inFlight and the slow entry, a home folder written ~, and trimHistory never touches inFlight', () => {
    let tab = reduce(base(), { kind: 'inflight', n: 4 }, 200)
    tab = reduce(tab, slow(1234, '/@fs/Users/example/app/src/main.ts'), 300)
    const [row] = wireTabs([tab])
    expect(row.inFlight).toBe(4)
    expect(row.history[0]).toEqual({ kind: 'slow', id: 1, method: 'GET', path: '/@fs/~/app/src/main.ts', ms: 1234, n: 1, at: 300, state: 'open' })
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    expect(validRow(row)).toBe(true)
    // Over the size cap: the history goes, inFlight stays.
    const big = Array.from({ length: 32 }, (_, i) => {
      let t = reduce(emptyTab(i, `http://localhost:${3000 + i}/`, 'A', i), { kind: 'inflight', n: 7 }, 1)
      for (let j = 0; j < HISTORY_MAX - SLOW_MAX; j++) t = reduce(t, { kind: 'error', text: `${'e'.repeat(290)}${j}` }, 5 + j)
      for (let j = 0; j < SLOW_MAX; j++) t = reduce(t, slow(1500, `/${'p'.repeat(250)}/${j}`), 30 + j)
      return t
    })
    const rows = wireTabs(big)
    expect(rows.reduce((s: number, r: { history: unknown[] }) => s + r.history.length, 0)).toBeLessThan(32 * HISTORY_MAX)
    for (const r of rows) expect(r.inFlight).toBe(7)
  })

  it('restores a tab with a slow entry, its inFlight back to 0 (the timings were in memory)', () => {
    const tab = reduce(reduce(base(), slow(1500), 200), { kind: 'inflight', n: 3 }, 300)
    const restored = restoredTabs({ 1: tab })
    expect(Object.keys(restored)).toEqual(['1'])
    expect(restored['1'].inFlight).toBe(0)
    expect(restored['1'].history[0]).toMatchObject({ kind: 'slow', ms: 1500 })
  })

  it('DevTabSchema refuses ms 999 and inFlight 1000, and reads a row without inFlight as 0', () => {
    const [row] = wireTabs([reduce(base(), slow(1500), 200)])
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    const entry = row.history[0]
    for (const bad of [{ ...entry, ms: 999 }, { ...entry, ms: 3_600_001 }, { ...entry, ms: 1500.5 }, { ...entry, path: '/a?b' }, { ...entry, status: 200 }]) {
      expect(DevTabSchema.safeParse({ ...row, history: [bad] }).success, JSON.stringify(bad)).toBe(false)
      expect(validRow({ ...row, history: [bad] }), JSON.stringify(bad)).toBe(false)
    }
    expect(DevTabSchema.safeParse({ ...row, history: [{ ...entry, ms: 3_600_000 }] }).success).toBe(true)
    expect(DevTabSchema.safeParse({ ...row, inFlight: 1000 }).success).toBe(false)
    expect(validRow({ ...row, inFlight: 1000 })).toBe(false)
    const { inFlight: _, ...without } = row
    expect(DevTabSchema.parse(without).inFlight).toBe(0)
  })

  it('reports a Slow requests section', () => {
    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report',
      reportServer: () => 'dev server',
      reportLines: () => 'Line numbers are those of the code the dev server sent.',
      reportSlow: () => 'Slow requests',
      stateSeen: () => 'seen',
      stateResolved: () => 'resolved',
    }
    const fmt = { stack: false, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: () => '10:00:00', date: (ms: number) => `D${ms}` }
    let tab = reduce(base(), slow(1200), 200)
    tab = reduce(tab, slow(2500, '/@fs/Users/Jane Example/app/x.ts', 'POST'), 300)
    tab = reduce(tab, slow(2600, '/@fs/Users/Jane Example/app/x.ts', 'POST'), 400)
    const text = buildReport(tab, fmt)
    expect(text).toContain('\n\n### Slow requests\n- 10:00:00 ×2 POST /@fs/~/app/x.ts 2600 ms\n- 10:00:00 GET /api/items 1200 ms')
    expect(text).not.toContain('/Users/')
  })
})

describe('performance and regressions', () => {
  const base = () => emptyTab(1, 'http://localhost:5173/', 'App', 100)
  const perf = (values: Record<string, number>, doc = 'D1') => ({ kind: 'perf', values, doc })
  const regression = (metric: string, value: number, ratio: number | null) => ({ kind: 'perf-regression', metric, value, ratio })
  /** The widget's own light (widgets/fremdev/logic.js), on a wire row. */
  const logic = () => {
    const scope: Record<string, any> = {}
    new Function('globalThis', readFileSync(new URL('../../widgets/fremdev/logic.js', import.meta.url), 'utf8'))(scope)
    return scope.FremkitFremdev
  }
  /** chrome.storage.session, just wide enough. */
  const area = () => {
    const data: Record<string, unknown> = {}
    return {
      data,
      get: async (k: string) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
      set: async (patch: Record<string, unknown>) => void Object.assign(data, structuredClone(patch)),
    }
  }

  it('has the rule constants', () => {
    expect([PERF_RATIO, PERF_MIN_MS, LCP_POOR_MS, CLS_POOR, PERF_SAMPLES, PERF_KEYS]).toEqual([1.5, 500, 4000, 0.25, 5, 50])
  })

  it('median takes the middle value, or the mean of the two middle ones', () => {
    expect(median([1200, 1000, 1100])).toBe(1100)
    expect(median([1000, 1200])).toBe(1100)
    expect(median([7])).toBe(7)
  })

  it('perfVerdict: at least 1.5 × the median of the previous loads and 500 ms slower', () => {
    expect(perfVerdict([{ lcp: 1000 }, { lcp: 1100 }, { lcp: 1200 }], { lcp: 1800 })).toEqual({ metric: 'lcp', value: 1800, ratio: 1.6 })
    expect(perfVerdict([{ lcp: 900 }], { lcp: 1400 })).toEqual({ metric: 'lcp', value: 1400, ratio: 1.6 })
    expect(perfVerdict([{ lcp: 900 }], { lcp: 1390 })).toBeNull()
    // 2 × but only 300 ms slower.
    expect(perfVerdict([{ load: 300 }], { load: 600 })).toBeNull()
    expect(perfVerdict([{ load: 1000 }, { load: 1000 }], { load: 2600 })).toEqual({ metric: 'load', value: 2600, ratio: 2.6 })
    // The ratio rules need a previous value for that metric.
    expect(perfVerdict([{ load: 1000 }], { lcp: 3900 })).toBeNull()
  })

  it('perfVerdict: LCP ratio, then load ratio, then LCP poor, then CLS poor; the first load ever is judged on the bands alone', () => {
    const before = [{ load: 1000, lcp: 1000 }]
    expect(perfVerdict(before, { load: 3000, lcp: 2000 })).toEqual({ metric: 'lcp', value: 2000, ratio: 2 })
    expect(perfVerdict(before, { load: 3000, lcp: 1100, cls: 0.5 })).toEqual({ metric: 'load', value: 3000, ratio: 3 })
    expect(perfVerdict([{ lcp: 4000 }], { lcp: 4100, cls: 0.5 })).toEqual({ metric: 'lcp', value: 4100, ratio: null })
    expect(perfVerdict([], { lcp: 4100 })).toEqual({ metric: 'lcp', value: 4100, ratio: null })
    expect(perfVerdict([], { lcp: 4000 })).toBeNull()
    expect(perfVerdict([], { cls: 0.3 })).toEqual({ metric: 'cls', value: 0.3, ratio: null })
    expect(perfVerdict([], { cls: 0.25 })).toBeNull()
    expect(perfVerdict([], { load: 9000, lcp: 2000 })).toBeNull()
    expect(perfVerdict([], {})).toBeNull()
  })

  it('PerfMemory keeps the last 5 samples per key and 50 keys, the least recently used dropped', async () => {
    const storage = area()
    const memory = new PerfMemory(storage)
    expect(await memory.samples('http://localhost:5173/')).toEqual([])
    for (let i = 1; i <= 7; i++) await memory.push('http://localhost:5173/', { load: i * 100, lcp: i * 10 })
    expect(await memory.samples('http://localhost:5173/')).toEqual([3, 4, 5, 6, 7].map((i) => ({ load: i * 100, lcp: i * 10 })))
    // Kept in chrome.storage.session.fremdevPerf.
    expect(storage.data.fremdevPerf).toBeDefined()
    for (let k = 1; k < 50; k++) await memory.push(`http://localhost:5173/p${k}`, { load: k })
    // The first key used again: p1 is now the least recently used.
    await memory.push('http://localhost:5173/', { load: 800 })
    await memory.push('http://localhost:5173/p50', { load: 50 })
    expect(await memory.samples('http://localhost:5173/p1')).toEqual([])
    expect(await memory.samples('http://localhost:5173/p2')).toEqual([{ load: 2 }])
    expect((await memory.samples('http://localhost:5173/')).at(-1)).toEqual({ load: 800 })
    expect(await memory.samples('http://localhost:5173/p50')).toEqual([{ load: 50 }])
    // A document's sample follows its LCP as it grows: replaced where it is, never a second one.
    await memory.push('http://localhost:5173/a', { load: 900, lcp: 500 }, 'DA')
    await memory.push('http://localhost:5173/a', { load: 950, lcp: 520 }, 'DB')
    await memory.update('DA', { load: 900, lcp: 1300 })
    expect(await memory.samples('http://localhost:5173/a')).toEqual([{ load: 900, lcp: 1300 }, { load: 950, lcp: 520 }])
    await memory.update('DZ', { load: 1, lcp: 1 })
    expect(await memory.samples('http://localhost:5173/a')).toEqual([{ load: 900, lcp: 1300 }, { load: 950, lcp: 520 }])
    // A stored value that is not ours reads as nothing.
    storage.data.fremdevPerf = { evil: 1 }
    expect(await memory.samples('http://localhost:5173/')).toEqual([])
  })

  it('emptyTab starts with no values and no perf entry', () => {
    expect(base()).toMatchObject({ perf: {}, perfEntryId: null })
  })

  it('reduce merges the values of one document, and starts again for another', () => {
    let tab = reduce(base(), perf({ lcp: 800 }), 200)
    tab = reduce(tab, perf({ load: 1234, lcp: 900, cls: 0.02, longTasks: 1, heapMb: 45 }), 300)
    expect(tab.perf).toEqual({ load: 1234, lcp: 900, cls: 0.02, longTasks: 1, heapMb: 45 })
    // A perf event stamps no activity: it is a measure, not an event.
    expect(tab.activity).toBe(100)
    expect(reduce(tab, perf({ lcp: 500 }, 'D2'), 400).perf).toEqual({ lcp: 500 })
  })

  it('keeps the values across a same-origin navigation (a pushState route change keeps its document), and forgets them for another origin', () => {
    let tab = reduce(base(), perf({ load: 1234, lcp: 900 }), 200)
    tab = reduce(tab, regression('lcp', 900, 1.6), 250)
    const id = tab.perfEntryId
    expect(id).toBe(1)
    const same = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/route', title: 'App' }, 300)
    expect(same.perf).toEqual({ load: 1234, lcp: 900 })
    expect(same.history[0]).toMatchObject({ kind: 'perf', state: 'resolved' })
    const other = reduce(tab, { kind: 'navigated', url: 'http://localhost:3000/', title: '' }, 300)
    expect(other).toMatchObject({ perf: {}, perfEntryId: null })
  })

  it('two regressions in one load give one perf entry, one tally bump, and requests.last untouched', () => {
    let tab = reduce(base(), { kind: 'request', method: 'GET', path: '/api', status: 500 }, 150)
    const last = tab.requests.last
    tab = reduce(tab, perf({ load: 2600, lcp: 4100, cls: 0.3 }), 200)
    tab = reduce(tab, regression('cls', 0.3, null), 210)
    expect(tab.requests).toEqual({ total: 2, open: 2, seen: 0, last })
    // A stronger verdict (LCP poor over CLS poor) replaces it.
    tab = reduce(tab, regression('lcp', 4100, null), 220)
    expect(tab.history.filter((e: { kind: string }) => e.kind === 'perf')).toEqual([
      { kind: 'perf', id: tab.perfEntryId, metric: 'lcp', value: 4100, ratio: null, n: 1, at: 210, state: 'open' },
    ])
    expect(tab.requests).toEqual({ total: 2, open: 2, seen: 0, last })
    // Marked seen: the values still follow, nothing is counted again.
    tab = reduce(tab, { kind: 'clear' }, 230)
    tab = reduce(tab, regression('lcp', 4200, null), 240)
    expect(tab.history.filter((e: { kind: string }) => e.kind === 'perf')).toEqual([expect.objectContaining({ metric: 'lcp', value: 4200, state: 'seen' })])
    expect(tab.requests).toEqual({ total: 2, open: 2, seen: 2, last })
  })

  it('within one load, a verdict replaces the entry only when its priority is equal or higher: LCP ratio, load ratio, LCP poor, CLS poor', () => {
    const metricOf = (t: { history: Array<{ kind: string; metric: string; value: number; ratio: number | null }> }) =>
      t.history.filter((e) => e.kind === 'perf').map((e) => [e.metric, e.value, e.ratio])
    let tab = reduce(base(), perf({ load: 2600, lcp: 1800 }), 200)
    tab = reduce(tab, regression('lcp', 1800, 1.6), 210)
    // Weaker: a load ratio, a poor LCP, a poor CLS are all ignored.
    for (const weaker of [regression('load', 2600, 2.6), regression('lcp', 4100, null), regression('cls', 0.4, null)]) {
      tab = reduce(tab, weaker, 220)
      expect(metricOf(tab)).toEqual([['lcp', 1800, 1.6]])
    }
    // Equal: the newer LCP ratio replaces it.
    tab = reduce(tab, regression('lcp', 2000, 1.8), 230)
    expect(metricOf(tab)).toEqual([['lcp', 2000, 1.8]])
    // From the bottom up, each stronger one replaces the last.
    let up = reduce(base(), perf({ cls: 0.4 }), 200)
    up = reduce(up, regression('cls', 0.4, null), 210)
    up = reduce(up, regression('lcp', 4100, null), 220)
    expect(metricOf(up)).toEqual([['lcp', 4100, null]])
    up = reduce(up, regression('load', 2600, 2.6), 230)
    expect(metricOf(up)).toEqual([['load', 2600, 2.6]])
    up = reduce(up, regression('cls', 0.5, null), 240)
    expect(metricOf(up)).toEqual([['load', 2600, 2.6]])
    expect(up.requests).toMatchObject({ total: 1, open: 1 })
  })

  it('without a documentId, keeps no once-per-document guard: a resolved load may be flagged again', () => {
    let tab = reduce(base(), perf({ lcp: 4100 }, null as unknown as string), 200)
    tab = reduce(tab, regression('lcp', 4100, null), 210)
    expect(tab.perfFlaggedDoc).toBeNull()
    tab = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 300)
    tab = reduce(reduce(tab, perf({ lcp: 4300 }, null as unknown as string), 400), regression('lcp', 4300, null), 410)
    expect(tab.history.filter((e: { kind: string }) => e.kind === 'perf').map((e: { state: string; value: number }) => [e.state, e.value]))
      .toEqual([['open', 4300], ['resolved', 4100]])
    expect(tab.requests).toMatchObject({ total: 2, open: 1 })
  })

  it('flags a document at most once, even after its resolved entry left the ring', () => {
    let tab = reduce(base(), perf({ lcp: 4100 }), 200)
    tab = reduce(tab, regression('lcp', 4100, null), 210)
    tab = reduce(tab, { kind: 'hot' }, 220)
    for (let i = 0; i < HISTORY_MAX; i++) tab = reduce(tab, { kind: 'error', text: `e${i}` }, 300 + i)
    expect(tab.history.some((e: { kind: string }) => e.kind === 'perf')).toBe(false)
    const before = tab.requests
    tab = reduce(tab, regression('lcp', 4300, null), 400)
    expect(tab.history.some((e: { kind: string }) => e.kind === 'perf')).toBe(false)
    expect(tab.requests).toEqual(before)
    // The next document may be flagged.
    tab = reduce(reduce(tab, perf({ lcp: 4400 }, 'D2'), 500), regression('lcp', 4400, null), 510)
    expect(tab.history[0]).toMatchObject({ kind: 'perf', value: 4400, state: 'open' })
  })

  it('a reload (a new document) after a navigation adds a second entry; the same load is not flagged again once resolved', () => {
    let tab = reduce(base(), perf({ lcp: 4100 }), 200)
    tab = reduce(tab, regression('lcp', 4100, null), 210)
    tab = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 300)
    expect(tab.requests.open).toBe(0)
    // The same document still talking (a route change, a hot update): its load already had its entry.
    const again = reduce(reduce(tab, perf({ cls: 0.4 }), 310), regression('cls', 0.4, null), 320)
    expect(again.history.filter((e: { kind: string }) => e.kind === 'perf')).toHaveLength(1)
    expect(again.requests.open).toBe(0)
    // The reload's document.
    tab = reduce(tab, perf({ lcp: 4300 }, 'D2'), 400)
    expect(tab.perfEntryId).toBeNull()
    tab = reduce(tab, regression('lcp', 4300, null), 410)
    expect(tab.history.filter((e: { kind: string }) => e.kind === 'perf').map((e: { state: string; value: number }) => [e.state, e.value]))
      .toEqual([['open', 4300], ['resolved', 4100]])
    expect(tab.requests).toMatchObject({ total: 2, open: 1 })
  })

  it('un-counts a perf entry the ring pushes out while open or seen, keeping seen <= open', () => {
    let tab = reduce(base(), { kind: 'request', method: 'GET', path: '/api', status: 500 }, 150)
    tab = reduce(tab, perf({ lcp: 4100 }), 160)
    tab = reduce(tab, regression('lcp', 4100, null), 170)
    tab = reduce(tab, { kind: 'clear' }, 180)
    expect(tab.requests).toMatchObject({ total: 2, open: 2, seen: 2 })
    // 18 errors fill the ring; the 19th pushes out the request entry (still counted), the 20th the perf entry.
    for (let i = 0; i < 19; i++) tab = reduce(tab, { kind: 'error', text: `e${i}` }, 200 + i)
    expect(tab.history.some((e: { kind: string }) => e.kind === 'perf')).toBe(true)
    tab = reduce(tab, { kind: 'error', text: 'e19' }, 300)
    expect(tab.history.some((e: { kind: string }) => e.kind === 'perf')).toBe(false)
    expect(tab.requests).toMatchObject({ total: 2, open: 1, seen: 1 })
    const [row] = wireTabs([tab])
    expect(validRow(row)).toBe(true)
    // Pushed out, the document stays flagged: its regression is not told again.
    tab = reduce(tab, regression('lcp', 4200, null), 310)
    expect(tab.history.some((e: { kind: string }) => e.kind === 'perf')).toBe(false)
    expect(tab.requests).toMatchObject({ total: 2, open: 1, seen: 1 })
  })

  it('wireRow carries the perf entry and the values, never trimmed, and the light is orange, never red', () => {
    let tab = reduce(base(), perf({ load: 1234, lcp: 4100, cls: 0.02, longTasks: 3, heapMb: 45 }), 200)
    tab = reduce(tab, regression('lcp', 4100, null), 210)
    const [row] = wireTabs([tab])
    expect(row.perf).toEqual({ load: 1234, lcp: 4100, cls: 0.02, longTasks: 3, heapMb: 45 })
    expect(row.history[0]).toEqual({ kind: 'perf', id: 1, metric: 'lcp', value: 4100, ratio: null, n: 1, at: 210, state: 'open' })
    expect(row.requests).toMatchObject({ total: 1, open: 1, last: null })
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    expect(validRow(row)).toBe(true)
    const { lightOf, stateOfTab } = logic()
    expect(lightOf(row)).toBe('orange')
    expect(stateOfTab(DevTabSchema.parse(row))).toEqual({ light: 'orange', seen: false })
    // The perf document id stays in the extension.
    expect(JSON.stringify(row)).not.toContain('D1')
    // Over the size cap: the history goes, perf stays.
    const big = Array.from({ length: 32 }, (_, i) => {
      let t = reduce(emptyTab(i, `http://localhost:${3000 + i}/`, 'A', i), perf({ load: 1000 + i, heapMb: 9 }), 1)
      for (let j = 0; j < HISTORY_MAX; j++) t = reduce(t, { kind: 'error', text: `${'e'.repeat(290)}${j}` }, 5 + j)
      return t
    })
    const rows = wireTabs(big)
    expect(rows.reduce((s: number, r: { history: unknown[] }) => s + r.history.length, 0)).toBeLessThan(32 * HISTORY_MAX)
    for (const r of rows) expect(r.perf).toMatchObject({ heapMb: 9 })
  })

  it('DevTabSchema refuses perf.cls 101, an extra perf key, a perf entry out of bounds, and takes a row without perf', () => {
    const [row] = wireTabs([reduce(reduce(base(), perf({ lcp: 4100, cls: 0.3 }), 200), regression('lcp', 4100, null), 210)])
    expect(DevTabSchema.safeParse(row).success).toBe(true)
    for (const bad of [{ cls: 101 }, { lcp: 600_001 }, { load: -1 }, { longTasks: 1.5 }, { heapMb: 65_537 }, { fps: 60 }, { lcp: 1.5 }]) {
      expect(DevTabSchema.safeParse({ ...row, perf: bad }).success, JSON.stringify(bad)).toBe(false)
      expect(validRow({ ...row, perf: bad }), JSON.stringify(bad)).toBe(false)
    }
    expect(DevTabSchema.safeParse({ ...row, perf: { cls: 100, lcp: 600_000, load: 0, longTasks: 100_000, heapMb: 65_536 } }).success).toBe(true)
    const entry = row.history[0]
    for (const bad of [{ ...entry, metric: 'fps' }, { ...entry, value: 600_001 }, { ...entry, ratio: 0.5 }, { ...entry, ratio: 1001 }, { ...entry, extra: 1 }]) {
      expect(DevTabSchema.safeParse({ ...row, history: [bad] }).success, JSON.stringify(bad)).toBe(false)
      expect(validRow({ ...row, history: [bad] }), JSON.stringify(bad)).toBe(false)
    }
    expect(DevTabSchema.safeParse({ ...row, history: [{ ...entry, metric: 'load', ratio: 1.6 }] }).success).toBe(true)
    const { perf: _, ...without } = row
    expect(DevTabSchema.parse(without).perf).toEqual({})
  })

  it('restores a tab with its values, its perf entry and the document they belong to', () => {
    let tab = reduce(base(), perf({ load: 1234, lcp: 4100 }), 200)
    tab = reduce(tab, regression('lcp', 4100, null), 210)
    const restored = restoredTabs({ 1: tab })['1']
    expect(restored).toMatchObject({ perf: { load: 1234, lcp: 4100 }, perfEntryId: 1, perfDoc: 'D1', perfFlaggedDoc: 'D1' })
    // A row from before this feature comes back with none.
    const { perf: _p, perfEntryId: _e, perfDoc: _d, perfFlaggedDoc: _f, ...old } = base()
    expect(restoredTabs({ 1: old })['1']).toMatchObject({ perf: {}, perfEntryId: null, perfDoc: null, perfFlaggedDoc: null })
    expect(restoredTabs({ 1: { ...tab, perf: { lcp: -5 } } })).toEqual({})
  })

  it('reports a Performance line under the header, only when there are values', () => {
    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report',
      reportServer: () => 'dev server',
      reportLines: () => 'Line numbers are those of the code the dev server sent.',
      reportPerf: () => 'Performance',
    }
    const fmt = { stack: false, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: () => '10:00:00', date: (ms: number) => `D${ms}` }
    const tab = reduce(base(), perf({ load: 1234, lcp: 800, cls: 0.02, longTasks: 3, heapMb: 45 }), 200)
    const lines = buildReport(tab, fmt).split('\n')
    expect(lines[2]).toBe('Performance: Load 1.2 s · LCP 0.8 s · CLS 0.02 · 3 long tasks · 45 MB')
    expect(buildReport(reduce(base(), perf({ cls: 0.3 }), 200), fmt).split('\n')[2]).toBe('Performance: CLS 0.30')
    expect(buildReport(base(), fmt)).not.toContain('Performance')
  })

  it('lists the perf entries in a Performance section, each with its time, text and state', () => {
    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report',
      reportServer: () => 'dev server',
      reportLines: () => 'Line numbers are those of the code the dev server sent.',
      reportPerf: () => 'Performance',
      reportPerfSlower: (m, v, r) => `${m} ${v}, ×${r} slower`,
      reportPerfPoor: (m, v) => `${m} ${v}, poor`,
      stateSeen: () => 'seen',
      stateResolved: () => 'resolved',
    }
    const fmt = { stack: false, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` }
    let tab = reduce(base(), perf({ cls: 0.31 }), 200)
    tab = reduce(tab, regression('cls', 0.31, null), 210)
    tab = reduce(tab, { kind: 'navigated', url: 'http://localhost:5173/', title: 'App' }, 300)
    tab = reduce(tab, perf({ lcp: 1800, load: 900 }, 'D2'), 400)
    tab = reduce(tab, regression('lcp', 1800, 1.6), 410)
    expect(buildReport(tab, fmt)).toContain('\n\n### Performance\n- T410 LCP 1.8 s, ×1.6 slower\n- T210 CLS 0.31, poor (resolved)')
  })
})

describe('devshot', () => {
  it('turns a png or jpeg data URL into a Blob of that type', async () => {
    const png: Blob = dataUrlBlob('data:image/png;base64,iVBORw0KGgo=')
    expect(png.type).toBe('image/png')
    expect([...new Uint8Array(await png.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(dataUrlBlob('data:image/jpeg;base64,/9j/4AAQ').type).toBe('image/jpeg')
  })

  it('refuses anything else', () => {
    for (const bad of ['data:text/html,<b>', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,abc', 'https://example.com/a.png', 'data:image/png;base64,@@@', '', 42]) {
      expect(() => dataUrlBlob(bad), String(bad)).toThrow()
    }
  })
})

describe('fitShot', () => {
  /** A fake decoded image, and a canvas whose JPEG weighs what `sizes(quality, w, h)` says. */
  function fakes(width: number, height: number, sizes: (quality: number, w: number, h: number) => number) {
    const drawn: Array<{ w: number; h: number; dw: number; dh: number }> = []
    const encoded: Array<{ type: string; quality: number }> = []
    const image = { width, height, close: vi.fn() }
    const decode = vi.fn(async () => image)
    const canvas = vi.fn((w: number, h: number) => ({
      getContext: () => ({ drawImage: (_img: unknown, _x: number, _y: number, dw: number, dh: number) => void drawn.push({ w, h, dw, dh }) }),
      convertToBlob: async ({ type, quality }: { type: string; quality: number }) => {
        encoded.push({ type, quality })
        return new Blob([new Uint8Array(sizes(quality, w, h))], { type })
      },
    }))
    return { decode, canvas, drawn, encoded }
  }
  const MB = 1024 * 1024

  it('hands back a blob that already fits, untouched', async () => {
    const f = fakes(3840, 2160, () => 0)
    const blob = new Blob([new Uint8Array(MB)], { type: 'image/jpeg' })
    expect(await fitShot(blob, { decode: f.decode, canvas: f.canvas })).toBe(blob)
    expect(f.decode).not.toHaveBeenCalled()
  })

  it('draws a 3 MB 3840×2160 shot at 1920×1080, JPEG 0.85', async () => {
    const f = fakes(3840, 2160, () => MB)
    const out = await fitShot(new Blob([new Uint8Array(3 * MB)], { type: 'image/jpeg' }), { decode: f.decode, canvas: f.canvas })
    expect(out?.size).toBe(MB)
    expect(out?.type).toBe('image/jpeg')
    expect(f.drawn).toEqual([{ w: 1920, h: 1080, dw: 1920, dh: 1080 }])
    expect(f.encoded).toEqual([{ type: 'image/jpeg', quality: 0.85 }])
  })

  it('steps the quality down to 0.7 then 0.5, and gives null when none fits', async () => {
    const f = fakes(1000, 4000, (q) => (q === 0.5 ? 2 * MB : 3 * MB))
    const out = await fitShot(new Blob([new Uint8Array(3 * MB)], { type: 'image/jpeg' }), { decode: f.decode, canvas: f.canvas })
    expect(f.drawn).toEqual([{ w: 480, h: 1920, dw: 480, dh: 1920 }])
    expect(f.encoded.map((e) => e.quality)).toEqual([0.85, 0.7, 0.5])
    expect(out?.size).toBe(2 * MB)
    const never = fakes(1920, 1080, () => 3 * MB)
    expect(await fitShot(new Blob([new Uint8Array(3 * MB)], { type: 'image/jpeg' }), { decode: never.decode, canvas: never.canvas })).toBeNull()
    expect(never.encoded.map((e) => e.quality)).toEqual([0.85, 0.7, 0.5])
  })
})

describe('shootTab', () => {
  const URL = 'http://127.0.0.1:4242/companion/dev/shot'
  const TAB = { id: 7, windowId: 3 }
  function deps(over: Record<string, unknown> = {}) {
    const flashes: string[] = []
    const d = {
      activeTab: vi.fn(async () => TAB),
      isDevTab: vi.fn(async (id: number) => id === 7),
      canSend: vi.fn(() => true),
      token: vi.fn((): string | null => 'tok'),
      capture: vi.fn(async () => 'data:image/jpeg;base64,/9j/4AAQ'),
      fetch: vi.fn(async () => ({ status: 200 })),
      url: URL,
      flash: (t: string) => void flashes.push(t),
      ...over,
    }
    return { d, flashes }
  }

  it('posts the capture with the token and flashes ✓ on a 200', async () => {
    const { d, flashes } = deps()
    await shootTab(TAB, d)
    expect(d.capture).toHaveBeenCalledWith(3)
    expect(d.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = d.fetch.mock.calls[0] as unknown as [string, RequestInit & { body: Blob }]
    expect(url).toBe(URL)
    expect(init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'image/jpeg' }, credentials: 'omit', cache: 'no-store' })
    expect(init.body.type).toBe('image/jpeg')
    expect(flashes).toEqual(['✓'])
  })

  it('takes the active tab when the command gave none', async () => {
    const { d, flashes } = deps()
    await shootTab(undefined, d)
    expect(d.activeTab).toHaveBeenCalled()
    expect(flashes).toEqual(['✓'])
  })

  it('sends nothing and flashes ! for a tab that is not a dev tab, a socket not greeted, or no token', async () => {
    for (const over of [
      { activeTab: vi.fn(async () => undefined) },
      { isDevTab: vi.fn(async () => false) },
      { canSend: vi.fn(() => false) },
      { token: vi.fn(() => null) },
    ]) {
      const { d, flashes } = deps(over)
      await shootTab(over.activeTab ? undefined : TAB, d)
      expect(d.capture, JSON.stringify(Object.keys(over))).not.toHaveBeenCalled()
      expect(d.fetch).not.toHaveBeenCalled()
      expect(flashes).toEqual(['!'])
    }
    const { d, flashes } = deps()
    await shootTab({ id: -1, windowId: 3 }, d)
    expect(d.fetch).not.toHaveBeenCalled()
    expect(flashes).toEqual(['!'])
  })

  it('sends nothing when the socket closed during the capture', async () => {
    const canSend = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const { d, flashes } = deps({ canSend })
    await shootTab(TAB, d)
    expect(d.capture).toHaveBeenCalled()
    expect(d.fetch).not.toHaveBeenCalled()
    expect(flashes).toEqual(['!'])
  })

  it('shows the shot after a 200 only, with the shot posted', async () => {
    const after = vi.fn(async () => undefined)
    const { d, flashes } = deps({ after })
    await shootTab(TAB, d)
    expect(after).toHaveBeenCalledTimes(1)
    const [tabId, shot] = after.mock.calls[0] as unknown as [number, Blob]
    expect(tabId).toBe(7)
    expect(shot.type).toBe('image/jpeg')
    expect(flashes).toEqual(['✓'])
    for (const status of [409, 500]) {
      const refused = vi.fn(async () => undefined)
      const r = deps({ after: refused, fetch: vi.fn(async () => ({ status })) })
      await shootTab(TAB, r.d)
      expect(refused).not.toHaveBeenCalled()
    }
  })

  it('takes the last thumbnail out of the tab before it captures', async () => {
    const order: string[] = []
    const { d, flashes } = deps({
      before: vi.fn(async (id: number) => void order.push(`before ${id}`)),
      capture: vi.fn(async () => { order.push('capture'); return 'data:image/jpeg;base64,/9j/4AAQ' }),
    })
    await shootTab(TAB, d)
    expect(order).toEqual(['before 7', 'capture'])
    expect(flashes).toEqual(['✓'])
  })

  it('captures anyway when clearing the tab fails, and clears nothing for a refused shot', async () => {
    const failing = deps({ before: vi.fn(async () => { throw new Error('no tab') }) })
    await shootTab(TAB, failing.d)
    expect(failing.d.capture).toHaveBeenCalled()
    expect(failing.flashes).toEqual(['✓'])
    const before = vi.fn(async () => undefined)
    const refused = deps({ before, isDevTab: vi.fn(async () => false) })
    await shootTab(TAB, refused.d)
    expect(before).not.toHaveBeenCalled()
  })

  it('clearBeforeCapture waits for the tab, at most CLEAR_WAIT_MS, and never throws', async () => {
    expect(CLEAR_WAIT_MS).toBe(300)
    const run = vi.fn(async () => undefined)
    await clearBeforeCapture(run, { wait: () => new Promise(() => undefined) })
    expect(run).toHaveBeenCalled()
    const waited: number[] = []
    await clearBeforeCapture(() => new Promise(() => undefined), { wait: async (ms: number) => void waited.push(ms) })
    expect(waited).toEqual([300])
    await expect(clearBeforeCapture(() => { throw new Error('refused') }, { wait: () => new Promise(() => undefined) })).resolves.toBeUndefined()
  })

  it('keeps ✓ when showing the shot fails', async () => {
    const { d, flashes } = deps({ after: vi.fn(async () => { throw new Error('no tab') }) })
    await shootTab(TAB, d)
    expect(flashes).toEqual(['✓'])
  })

  it('flashes ! on any other answer, a throw, a failed capture, or a shot that cannot fit', async () => {
    for (const over of [
      { fetch: vi.fn(async () => ({ status: 409 })) },
      { fetch: vi.fn(async () => ({ status: 500 })) },
      { fetch: vi.fn(async () => { throw new TypeError('Failed to fetch') }) },
      { capture: vi.fn(async () => { throw new Error('no grant') }) },
      { capture: vi.fn(async () => 'data:text/html,<b>') },
      { fit: vi.fn(async () => null) },
    ]) {
      const { d, flashes } = deps(over)
      await shootTab(TAB, d)
      expect(flashes, JSON.stringify(Object.keys(over))).toEqual(['!'])
    }
  })
})

describe('the shot thumbnail', () => {
  /** A canvas whose JPEG weighs what `sizes(quality, w, h)` says, its bytes starting FF D8 FF. */
  function fakes(width: number, height: number, sizes: (quality: number, w: number, h: number) => number) {
    const drawn: Array<{ w: number; h: number }> = []
    const encoded: Array<{ w: number; quality: number }> = []
    const image = { width, height, close: vi.fn() }
    const decode = vi.fn(async () => image)
    const canvas = vi.fn((w: number, h: number) => ({
      getContext: () => ({ drawImage: () => void drawn.push({ w, h }) }),
      convertToBlob: async ({ type, quality }: { type: string; quality: number }) => {
        encoded.push({ w, quality })
        const bytes = new Uint8Array(sizes(quality, w, h))
        bytes.set([0xff, 0xd8, 0xff].slice(0, bytes.length))
        return new Blob([bytes], { type })
      },
    }))
    return { image, decode, canvas, drawn, encoded }
  }

  it('blobDataUrl: the bytes in base64, of the blob\'s type', async () => {
    expect(await blobDataUrl(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }))).toBe('data:image/jpeg;base64,/9j/4A==')
    // Larger than one String.fromCharCode slice.
    const big = new Uint8Array(100_000).fill(65)
    const url = await blobDataUrl(new Blob([big], { type: 'image/jpeg' }))
    expect(atob(url.slice('data:image/jpeg;base64,'.length))).toBe('A'.repeat(100_000))
  })

  it('isThumb: a JPEG data URL of whole base64 quads, at most THUMB_MAX_CHARS', () => {
    expect(THUMB_MAX_CHARS).toBe(40_000)
    expect(isThumb('data:image/jpeg;base64,/9j/4A==')).toBe(true)
    const prefix = 'data:image/jpeg;base64,/9j/'
    expect(isThumb(prefix + 'A'.repeat(THUMB_MAX_CHARS - prefix.length - ((THUMB_MAX_CHARS - prefix.length) % 4)))).toBe(true)
    for (const bad of [
      'data:image/png;base64,iVBORw0KGgo=',
      'data:image/jpeg;base64,iVBORw0KGgo=',
      'data:image/jpeg;base64,/9j/4A=',
      'data:image/jpeg,/9j/4A==',
      'data:image/svg+xml;base64,PHN2Zz4=',
      'https://example.com/a.jpg',
      prefix + 'A'.repeat(THUMB_MAX_CHARS),
      null,
      42,
    ]) expect(isThumb(bad), String(bad).slice(0, 40)).toBe(false)
  })

  it('draws a 2560×1440 shot at 320×180, JPEG 0.7', async () => {
    const f = fakes(2560, 1440, () => 9_000)
    const thumb = await thumbOf(new Blob([new Uint8Array(10)]), { decode: f.decode, canvas: f.canvas })
    expect(isThumb(thumb)).toBe(true)
    expect(f.drawn).toEqual([{ w: 320, h: 180 }])
    expect(f.encoded).toEqual([{ w: 320, quality: 0.7 }])
    expect(f.image.close).toHaveBeenCalled()
  })

  it('never enlarges a small shot', async () => {
    const f = fakes(200, 100, () => 3_000)
    await thumbOf(new Blob([new Uint8Array(10)]), { decode: f.decode, canvas: f.canvas })
    expect(f.drawn).toEqual([{ w: 200, h: 100 }])
  })

  it('steps the quality down, then the size, and gives null when nothing fits', async () => {
    // 0.75 × 40 000 base64 chars ≈ 30 000 bytes: only 160 px at 0.5 fits.
    const f = fakes(1600, 900, (q, w) => (w === 160 && q === 0.5 ? 20_000 : 31_000))
    const thumb = await thumbOf(new Blob([new Uint8Array(10)]), { decode: f.decode, canvas: f.canvas })
    expect(f.encoded).toEqual([
      { w: 320, quality: 0.7 }, { w: 320, quality: 0.5 },
      { w: 240, quality: 0.7 }, { w: 240, quality: 0.5 },
      { w: 160, quality: 0.7 }, { w: 160, quality: 0.5 },
    ])
    expect(thumb!.length).toBeLessThanOrEqual(THUMB_MAX_CHARS)
    const never = fakes(1600, 900, () => 31_000)
    expect(await thumbOf(new Blob([new Uint8Array(10)]), { decode: never.decode, canvas: never.canvas })).toBeNull()
    expect(never.image.close).toHaveBeenCalled()
  })

  it('gives null for an image that does not decode', async () => {
    expect(await thumbOf(new Blob([]), { decode: async () => { throw new Error('bad') } })).toBeNull()
  })

  it('shotFeedback: the Edge first with the sound option, then the tab; a bad thumb goes as null', async () => {
    const calls: unknown[][] = []
    const deps = {
      inject: vi.fn(async (...a: unknown[]) => void calls.push(['inject', ...a])),
      tellEdge: vi.fn(async (...a: unknown[]) => void calls.push(['edge', ...a])),
      sound: vi.fn(async () => true),
    }
    await shotFeedback(7, 'data:image/jpeg;base64,/9j/4A==', deps)
    await shotFeedback(7, 'data:image/png;base64,iVBORw0KGgo=', { ...deps, sound: vi.fn(async () => false) })
    expect(calls).toEqual([
      ['edge', 7, 'data:image/jpeg;base64,/9j/4A==', true],
      ['inject', 7, 'data:image/jpeg;base64,/9j/4A=='],
      ['edge', 7, null, false],
      ['inject', 7, null],
    ])
  })

  it('shotFeedback: a tab that never answers does not hold the Edge or the sound back', async () => {
    const tellEdge = vi.fn(async () => true)
    void shotFeedback(7, null, { inject: () => new Promise(() => undefined), tellEdge, sound: async () => true })
    await vi.waitFor(() => expect(tellEdge).toHaveBeenCalledWith(7, null, true))
  })

  it('shotFeedback: a tab that refuses the script still tells the Edge; a failing option reads off', async () => {
    const tellEdge = vi.fn(async () => true)
    await shotFeedback(7, null, {
      inject: vi.fn(async () => { throw new Error('Cannot access a chrome:// URL') }),
      tellEdge,
      sound: vi.fn(async () => { throw new Error('storage') }),
    })
    expect(tellEdge).toHaveBeenCalledWith(7, null, false)
    // Only `true` turns the sound on.
    await shotFeedback(7, null, { inject: async () => undefined, tellEdge, sound: async () => 'yes' })
    expect(tellEdge).toHaveBeenLastCalledWith(7, null, false)
    await expect(shotFeedback(7, null, { inject: async () => undefined, tellEdge: async () => { throw new Error('x') }, sound: async () => false })).resolves.toBeUndefined()
  })
})

describe('the in-tab shot overlay', () => {
  const overlay = readFileSync(join(import.meta.dirname, '..', '..', 'companion', 'lib', 'shotview.js'), 'utf8')

  it('is one self-contained function: executeScript serializes it alone', async () => {
    // @ts-expect-error plain JS module
    const { shotOverlay } = await import('../../companion/lib/shotview.js')
    const text: string = shotOverlay.toString()
    expect(overlay).not.toMatch(/^import /m)
    // Nothing from outside the function but browser globals.
    expect(() => new Function(`return (${text})`)()).not.toThrow()
    expect(text).toContain("attachShadow({ mode: 'closed' })")
    expect(text).toContain("'z-index': '2147483647'")
    expect(text).toContain("'pointer-events': 'none'")
    expect(text).toContain('prefers-reduced-motion: reduce')
  })

  it('loads nothing by URL and writes no markup: a strict CSP has nothing to refuse', () => {
    expect(overlay).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createElement\('(img|style|link|script)'\)|\.src\s*=|setAttribute\('style'|adoptedStyleSheets/)
    expect(overlay).toContain('createImageBitmap(new Blob(')
    // An `!important` opacity would beat the animations: the flash would never show.
    expect(overlay).not.toMatch(/set\((flash|canvas), \{[^}]*opacity/)
    expect(overlay).toContain("createElement('canvas')")
  })

  it('the worker injects it in the isolated world, never MAIN', () => {
    const worker = readFileSync(join(import.meta.dirname, '..', '..', 'companion', 'worker.js'), 'utf8')
    const call = worker.match(/executeScript\(\{ target: \{ tabId: id \}, func: shotOverlay, args: \[shown\] \}\)/)
    expect(call).not.toBeNull()
    expect(worker).not.toMatch(/func: shotOverlay[^)]*world/)
  })
})
