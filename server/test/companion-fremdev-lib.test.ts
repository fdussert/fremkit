import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { BUILTIN_PERMISSION_ORIGINS, FREMKIT_EXCLUDES, inOrigins, isDevUrl, parsePattern, releasableOrigins } from '../../companion/lib/devhosts.js'
// @ts-expect-error plain JS module
import { boundFrames, errorText, framePlace, homePath, hotReloadSignal, isNoise, MAX_FRAME, MAX_FRAMES, MAX_STACK, MAX_TEXT, METHODS, methodOf, parseStack, pathOf, RateLimiter } from '../../companion/lib/devlog.js'
// @ts-expect-error plain JS module
import { emptyTab, fremdevSupport, HISTORY_MAX, reduce, restoredTabs, Throttle, validRow, wireTabs } from '../../companion/lib/devtabs.js'
// @ts-expect-error plain JS module
import { hello, devTabs, modulesMsg, ping } from '../../companion/lib/protocol.js'
// @ts-expect-error plain JS module
import { buildReport, REPORT_MAX, reportMessage } from '../../companion/lib/devreport.js'
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
    for (const t of ['[vite] hot updated: /src/a.ts', '[HMR] App is up to date', '[HMR] Updated modules']) expect(hotReloadSignal(t)).toBe('hot')
    expect(hotReloadSignal('[vite] connecting...')).toBeNull()
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

  it('keeps at most 10 frames of 300 characters, 2000 in all', () => {
    const frames = Array.from({ length: 15 }, (_, i) => `    at f${i} (http://localhost:5173/a.js:${i + 1}:1)`)
    expect(parseStack(`Error: e\n${frames.join('\n')}`, PAGE)).toHaveLength(MAX_FRAMES)
    const long = parseStack(`Error: e\n    at ${'f'.repeat(400)} (http://localhost:5173/a.js:1:1)`, PAGE)
    expect(long).toHaveLength(1)
    expect(long[0]).toHaveLength(MAX_FRAME)
    const wide = Array.from({ length: 10 }, (_, i) => `    at ${String(i).repeat(290)} (http://localhost:5173/a.js:1:1)`)
    const kept = parseStack(`Error: e\n${wide.join('\n')}`, PAGE)
    // Each frame is 300 long: six of them and five newlines make 1805, a seventh would make 2106.
    expect(kept.every((f: string) => f.length === 300)).toBe(true)
    expect(kept).toHaveLength(6)
    expect(kept.join('\n').length).toBeLessThanOrEqual(MAX_STACK)
    expect([MAX_FRAMES, MAX_FRAME, MAX_STACK]).toEqual([10, 300, 2000])
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
    expect(Object.keys(rows[0]).sort()).toEqual(['activity', 'app', 'devServer', 'errors', 'history', 'host', 'requests', 'server', 'tabId'])
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
    expect(text).toContain('- T1000 TypeError: boom (resolved)\n  at /src/Cart.vue:42:17\n    run /src/main.js:3:1\n')
    expect(text).not.toContain('    setup ')
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
    expect(homePath('/Users/a\n/Users/b/c')).toBe('/Users/a\n~/c')
  })

  it('records a build error once however often the overlay says it again', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    const same = reduce(tab, build('Invalid end tag.'), 300)
    expect(same).toBe(tab)
    tab = same
    expect(builds(tab)).toHaveLength(1)
    expect(tab.history[0]).toEqual({ kind: 'build', id: 1, text: 'Invalid end tag.', path: '/Users/example/app/src/App.vue', line: 12, col: 3, n: 1, at: 200, state: 'open' })
    expect(tab.errors).toMatchObject({ total: 1, open: 1, seen: 0, last: { text: 'Invalid end tag.', at: 200 } })
  })

  it('a different build error resolves the last one and keeps one open', () => {
    let tab = reduce(base(), build('Invalid end tag.'), 200)
    tab = reduce(tab, build('Invalid end tag.', { line: 13 }), 300)
    // Same text and path, another line: the same error, moved.
    expect(builds(tab)).toHaveLength(1)
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

  it('reports a Build section with ~/ paths', () => {
    const WORDS: Record<string, (...s: unknown[]) => string> = {
      reportTitle: () => 'Bug report',
      reportServer: () => 'dev server',
      reportLines: () => 'Line numbers are those of the code the dev server sent.',
      reportErrors: (open, total) => `Errors (${open} open, ${total} total)`,
      reportBuild: () => 'Build',
      stateSeen: () => 'seen',
      stateResolved: () => 'resolved',
    }
    const fmt = { stack: false, now: 9_000, t: (key: string, ...subs: unknown[]) => WORDS[key](...subs), time: (ms: number) => `T${ms}`, date: (ms: number) => `D${ms}` }
    let tab = reduce(base(), { kind: 'error', text: 'TypeError: x', origin: '/src/a.js:1:2' }, 150)
    tab = reduce(tab, build('Invalid end tag in /Users/Jane Example/app/src/App.vue', { file: '/Users/Jane Example/app/src/App.vue' }), 200)
    const text = buildReport(tab, fmt)
    expect(text).toContain('### Build\n- T200 Invalid end tag in ~/app/src/App.vue\n  at ~/app/src/App.vue:12:3\n\n### Errors (2 open, 2 total)\n- T150 TypeError: x\n')
    expect(text).not.toContain('/Users/')
  })
})
