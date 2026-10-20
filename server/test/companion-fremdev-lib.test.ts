import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error plain JS module outside server/, no declarations
import { BUILTIN_PERMISSION_ORIGINS, FREMKIT_EXCLUDES, inOrigins, isDevUrl, parsePattern, releasableOrigins } from '../../companion/lib/devhosts.js'
// @ts-expect-error plain JS module
import { errorText, hotReloadSignal, isNoise, MAX_TEXT, pathOf, RateLimiter } from '../../companion/lib/devlog.js'
// @ts-expect-error plain JS module
import { emptyTab, fremdevSupport, reduce, Throttle, validRow, wireTabs } from '../../companion/lib/devtabs.js'
// @ts-expect-error plain JS module
import { hello, devTabs, modulesMsg, ping } from '../../companion/lib/protocol.js'
import { DevTabSchema } from '../src/companion/protocol.js'

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
    expect(Object.keys(rows[0]).sort()).toEqual(['activity', 'app', 'errors', 'host', 'requests', 'server', 'tabId'])
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
      const shaped = { tabId: t.tabId, app: t.title, host: t.host, errors: t.errors, requests: t.requests, server: t.server, activity: t.activity }
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

describe('protocol builders', () => {
  it('adds modules to hello only when given', () => {
    expect(hello('t', 'i', undefined, ['fremplay', 'fremdev']).modules).toEqual(['fremplay', 'fremdev'])
    expect('modules' in hello('t', 'i')).toBe(false)
    expect(modulesMsg(['fremdev'])).toEqual({ type: 'modules', modules: ['fremdev'] })
    expect(devTabs([])).toEqual({ type: 'dev.tabs', tabs: [] })
    expect(ping()).toEqual({ type: 'ping' })
  })
})
