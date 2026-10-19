import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { WIDGET_CSP, widgetCsp } from '../src/widgets/routes.js'
import { BYTE_ROUTES, isByteRoute } from '../src/http/headers.js'
import { degradedMessage } from '../src/config/routes.js'
import { defaultLocale } from '../src/config/schema.js'
import type { FastifyInstance } from 'fastify'

let dir: string
let app: FastifyInstance

/** A v4 config with one screen and one page holding `items`, each a `clock` widget. */
const onePage = (items: { instanceId: string, x: number, y: number, w: number, h: number }[], extra: object = {}) => ({
  version: 4,
  widgets: Object.fromEntries(items.map((p) => [p.instanceId, { widgetId: 'clock' }])),
  screens: [{ id: 'edge', name: 'Xeneon Edge', kind: 'edge', pages: [{ id: 'p', name: 'P', items }] }],
  ...extra,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-app-'))
  await mkdir(join(dir, 'widgets', 'clock'), { recursive: true })
  await writeFile(join(dir, 'widgets', 'clock', 'manifest.json'), JSON.stringify({ id: 'clock', name: 'Clock', version: '1.0.0', minSize: [8, 4], defaultSize: [16, 4] }))
  await writeFile(join(dir, 'widgets', 'clock', 'index.html'), '<!doctype html><html><head><title>c</title></head><body>hi</body></html>')
  await writeFile(join(dir, 'widgets', 'clock', 'style.css'), 'body{color:red}')
  app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
})
afterEach(async () => { await app.close() })

describe('the host pages', () => {
  it('carry a CSP that keeps widget frames on /widgets/ and the page unframeable', async () => {
    const ui = join(dir, 'ui')
    await mkdir(ui, { recursive: true })
    await writeFile(join(ui, 'index.html'), '<!doctype html><title>dashboard</title>')
    await writeFile(join(ui, 'admin.html'), '<!doctype html><title>admin</title>')
    await writeFile(join(ui, 'app.js'), 'x')
    const served = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), uiDist: ui, port: 4301 })
    try {
      for (const url of ['/', '/index.html', '/admin', '/admin/', '/admin.html']) {
        const res = await served.inject({ url, headers: { host: '127.0.0.1:4301' } })
        expect(res.statusCode, url).toBe(200)
        const csp = String(res.headers['content-security-policy'])
        expect(csp, url).toContain('frame-src http://127.0.0.1:4301/widgets/')
        expect(csp, url).toContain("connect-src 'self' ws://127.0.0.1:4301")
        expect(csp, url).toContain("script-src 'self'")
        expect(csp, url).not.toContain("script-src 'self' 'unsafe-inline'")
        for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"]) expect(csp, url).toContain(d)
      }
      // Under localhost the page's origin is localhost, and so are its frames.
      const viaName = await served.inject({ url: '/', headers: { host: 'localhost:4301' } })
      expect(String(viaName.headers['content-security-policy'])).toContain('frame-src http://localhost:4301/widgets/')
      // Not a page: no host CSP, and the widgets keep their own.
      expect((await served.inject({ url: '/app.js', headers: { host: '127.0.0.1:4301' } })).headers['content-security-policy']).toBeUndefined()
      expect((await served.inject({ url: '/widgets/clock/index.html', headers: { host: '127.0.0.1:4301' } })).headers['content-security-policy']).toBe(widgetCsp(4301))
    } finally {
      await served.close()
    }
  })
})

describe('config routes', () => {
  it('GET /api/config returns the default config', async () => {
    const res = await app.inject({ url: '/api/config' })
    expect(res.statusCode).toBe(200)
    expect(res.json().screens[0].pages[0].id).toBe('home')
  })
  it('PUT /api/config validates shape and layout', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/config', payload: { version: 4, screens: [] } })
    expect(bad.statusCode).toBe(400)
    const overlapping = (locale: 'fr' | 'en') => onePage([
      { instanceId: 'a', x: 0, y: 0, w: 16, h: 4 }, { instanceId: 'b', x: 8, y: 2, w: 16, h: 4 } ], { locale })
    const overlap = await app.inject({ method: 'PUT', url: '/api/config', payload: overlapping('fr') })
    expect(overlap.statusCode).toBe(400)
    expect(overlap.json().errors[0]).toBe('écran Xeneon Edge, page p : a chevauche b')
    // The config being saved carries the language, so the refusal comes back in it.
    const overlapEn = await app.inject({ method: 'PUT', url: '/api/config', payload: overlapping('en') })
    expect(overlapEn.statusCode).toBe(400)
    expect(overlapEn.json().errors[0]).toBe('screen Xeneon Edge, page p: a overlaps b')
    const ok = await app.inject({ method: 'PUT', url: '/api/config', payload: onePage([{ instanceId: 'a', x: 0, y: 0, w: 16, h: 4 }]) })
    expect(ok.statusCode).toBe(200)
    expect((await app.inject({ url: '/api/config' })).json().screens[0].pages[0].id).toBe('p')
  })
  it('PUT /api/config with malformed JSON still returns 400', async () => {
    // The claude plugin registers a lenient application/json parser; it must stay
    // encapsulated to that plugin so the rest of the API keeps rejecting bad JSON.
    const res = await app.inject({ method: 'PUT', url: '/api/config', headers: { 'content-type': 'application/json' }, payload: '{ "version": 2, ' })
    expect(res.statusCode).toBe(400)
  })
  it('reports a healthy store and lets a normal PUT through', async () => {
    expect((await app.inject({ url: '/api/config/status' })).json()).toEqual({ degraded: false })
    expect((await app.inject({ url: '/api/config' })).headers['x-fremkit-degraded']).toBeUndefined()
    const ok = await app.inject({ method: 'PUT', url: '/api/config', payload: onePage([]) })
    expect(ok.statusCode).toBe(200)
  })
  it('refuses to save, and never writes, while the config on disk cannot be read', async () => {
    await app.close()
    const mine = JSON.stringify({ version: 99, pages: [{ id: 'mine', name: 'Mienne' }] })
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'fremkit.json'), mine)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
    err.mockRestore()
    expect((await app.inject({ url: '/api/config' })).headers['x-fremkit-degraded']).toBe('1')
    expect((await app.inject({ url: '/api/config/status' })).json()).toEqual({ degraded: true })
    const put = await app.inject({ method: 'PUT', url: '/api/config', payload: onePage([]) })
    expect(put.statusCode).toBe(409)
    // A degraded store has no user config to read a language from, so it answers in the one the
    // machine would have picked.
    expect(put.json().errors[0]).toBe(degradedMessage(defaultLocale()))
    expect(await readFile(join(dir, 'data', 'fremkit.json'), 'utf8')).toBe(mine)
  })
  it('lets an unrelated save through a bar already over the limit, and refuses widening it', async () => {
    await app.close()
    await mkdir(join(dir, 'widgets', 'pill'), { recursive: true })
    await writeFile(join(dir, 'widgets', 'pill', 'manifest.json'), JSON.stringify({ id: 'pill', name: 'Pill', version: '1.0.0', minSize: [4, 2], defaultSize: [4, 2], compact: { width: 4 } }))
    await writeFile(join(dir, 'widgets', 'pill', 'index.html'), '<!doctype html><html><head><title>p</title></head><body>p</body></html>')
    // 34 columns (1360 px) leave each side 480 px after the dots: three 4-cell pills on one side
    // (528 px with gaps and padding) are already over, as a bar can be after a manifest's compact
    // width grew.
    const tablet = (pills: number, pageName: string) => {
      const widgets: Record<string, unknown> = {}
      const nav = Array.from({ length: pills }, (_, i) => { widgets['p' + i] = { widgetId: 'pill' }; return { instanceId: 'p' + i } })
      return { version: 4, locale: 'en', widgets, screens: [{ id: 'tab', name: 'Tablet', kind: 'device', display: { cols: 34, rows: 23 }, nav, pages: [{ id: 'p', name: pageName }] }] }
    }
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'fremkit.json'), JSON.stringify(tablet(3, 'P')))
    app = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets') })
    const renamed = await app.inject({ method: 'PUT', url: '/api/config', payload: tablet(3, 'Renamed') })
    expect(renamed.statusCode).toBe(200)
    const widened = await app.inject({ method: 'PUT', url: '/api/config', payload: tablet(4, 'Renamed') })
    expect(widened.statusCode).toBe(400)
    expect(widened.json().errors).toEqual(['screen Tablet, navigation bar: its wider widget cluster takes 700 px of the 480 px the pages leave on each side'])
  })
})

describe('the request gate', () => {
  const page = onePage([])

  it('refuses every request whose Host is not one of ours', async () => {
    for (const host of ['evil.example', 'evil.example:4242', 'fremkit.local']) {
      const res = await app.inject({ url: '/api/config', headers: { host } })
      expect(res.statusCode, host).toBe(421)
      expect(res.json().error).toMatch(/hôte non autorisé|host not allowed/)
    }
  })
  it('refuses a Host on a port that is not the one we listen on', async () => {
    const other = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), port: 4242 })
    expect((await other.inject({ url: '/api/config', headers: { host: '127.0.0.1:4242' } })).statusCode).toBe(200)
    expect((await other.inject({ url: '/api/config', headers: { host: '127.0.0.1:8080' } })).statusCode).toBe(421)
    await other.close()
  })
  it('accepts the loopback names', async () => {
    for (const host of ['127.0.0.1:4242', 'localhost:4242', '[::1]:4242']) {
      expect((await app.inject({ url: '/api/config', headers: { host } })).statusCode, host).toBe(200)
    }
  })
  it('refuses a write from a page on another origin', async () => {
    for (const url of ['/api/config', '/api/widgets/rescan']) {
      const method = url === '/api/config' ? 'PUT' : 'POST'
      const res = await app.inject({ method, url, payload: page, headers: { origin: 'https://evil.example' } })
      expect(res.statusCode, url).toBe(403)
      expect(res.json().error).toMatch(/origine non autorisée|origin not allowed/)
    }
    // The refusal happens before the route, so nothing was saved.
    expect((await app.inject({ url: '/api/config' })).json().screens[0].pages[0].id).toBe('home')
  })
  it('lets a write from our own origin, and one with no Origin at all, through', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/config', payload: page,
      headers: { origin: 'http://127.0.0.1:4242' } })).statusCode).toBe(200)
    // curl, the Claude Code hook scripts and the native helper send no Origin.
    expect((await app.inject({ method: 'POST', url: '/api/widgets/rescan' })).statusCode).toBe(200)
  })
  it('still allows cross-origin reads, which carry no secret', async () => {
    const res = await app.inject({ url: '/api/config', headers: { origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(200)
  })
})

describe('protective headers', () => {
  it('sets nosniff on every answer, JSON included', async () => {
    for (const url of ['/api/config', '/api/widgets']) {
      expect((await app.inject({ url })).headers['x-content-type-options'], url).toBe('nosniff')
    }
  })
  it('makes the routes that answer with foreign bytes inert', async () => {
    // No icon for example.com from a test machine, but the headers ride on the 404 too: they
    // are set for the route, not for a successful answer.
    const res = await app.inject({ url: `/api/favicon?url=${encodeURIComponent('https://example.com/')}` })
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    const icon = await app.inject({ url: '/api/apps/icon/com.example.none' })
    expect(icon.headers['content-security-policy']).toBe("default-src 'none'; sandbox")
  })
  it('leaves a route that sets its own CSP alone', async () => {
    const res = await app.inject({ url: '/widgets/clock/index.html' })
    expect(res.headers['content-security-policy']).not.toContain("default-src 'none'; sandbox")
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('widget routes', () => {
  it('GET /api/widgets lists manifests and errors', async () => {
    const res = await app.inject({ url: '/api/widgets' })
    expect(res.json().widgets.clock.name).toBe('Clock')
    expect(res.json().errors).toEqual([])
  })
  it('POST /api/widgets/rescan picks up new widgets', async () => {
    await mkdir(join(dir, 'widgets', 'cpu'))
    await writeFile(join(dir, 'widgets', 'cpu', 'manifest.json'), JSON.stringify({ id: 'cpu', name: 'CPU', version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4] }))
    await writeFile(join(dir, 'widgets', 'cpu', 'index.html'), '<html></html>')
    const res = await app.inject({ method: 'POST', url: '/api/widgets/rescan' })
    expect(Object.keys(res.json().widgets).sort()).toEqual(['clock', 'cpu'])
  })
  it('serves index.html with the bridge injected and a CSP header', async () => {
    const res = await app.inject({ url: '/widgets/clock/index.html' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['content-security-policy']).toBe(WIDGET_CSP)
    expect(res.body).toBe('<!doctype html><script src="/fremkit.js"></script><html><head><title>c</title></head><body>hi</body></html>')
  })
  it('lets only our own pages frame a widget document', async () => {
    const res = await app.inject({ url: '/widgets/clock/index.html' })
    const ancestors = String(res.headers['content-security-policy']).split('; ').find((d) => d.startsWith('frame-ancestors'))
    expect(ancestors).toBe('frame-ancestors http://127.0.0.1:4242 http://localhost:4242')
    // A second checkout's pages, on its own port, and Vite's in development.
    expect(widgetCsp(4301)).toContain('frame-ancestors http://127.0.0.1:4301 http://localhost:4301')
    expect(widgetCsp(4301, true)).toContain('frame-ancestors http://127.0.0.1:4301 http://localhost:4301 http://127.0.0.1:5173 http://localhost:5173')
    // The other files of a widget carry it too.
    const css = await app.inject({ url: '/widgets/clock/style.css' })
    expect(String(css.headers['content-security-policy'])).toContain('frame-ancestors http://127.0.0.1:4242 http://localhost:4242')
  })
  it('allows the bridge and a widget-owned relative script in an opaque frame', async () => {
    await writeFile(join(dir, 'widgets', 'clock', 'index.html'),
      '<html><head><script src="./app.js"></script></head><body>hi</body></html>')
    await writeFile(join(dir, 'widgets', 'clock', 'app.js'), 'window.widgetLoaded = true')
    const res = await app.inject({ url: '/widgets/clock/index.html' })
    expect(res.body).toContain('<script src="/fremkit.js"></script>')
    expect(res.body).toContain('<script src="./app.js"></script>')
    expect(res.headers['content-security-policy']).toContain("script-src 'self' http://127.0.0.1:4242")
    expect((await app.inject({ url: '/fremkit.js' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/widgets/clock/app.js' })).body).toBe('window.widgetLoaded = true')
  })
  it('scopes explicit subresource origins to the server port and development proxy', () => {
    const csp = widgetCsp(4301, true)
    for (const directive of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
      const line = csp.split('; ').find((part) => part.startsWith(directive))
      expect(line).toContain('http://127.0.0.1:4301')
      expect(line).toContain('http://localhost:5173')
      expect(line).not.toContain('[::1]')
      expect(line).not.toContain('http://127.0.0.1:4242')
    }
    expect(widgetCsp(4301)).not.toContain(':5173')
  })
  it('serves a second checkout with its own widget origin', async () => {
    const other = await buildApp({ accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), port: 4301 })
    try {
      const res = await other.inject({ url: '/widgets/clock/index.html', headers: { host: '127.0.0.1:4301' } })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-security-policy']).toBe(widgetCsp(4301))
      expect(res.headers['content-security-policy']).not.toContain(':4242')
    } finally {
      await other.close()
    }
  })
  it('sandboxes a widget however it is reached', async () => {
    // Opening a widget top-level, or as a second HTML file, or as Index.html on a
    // case-insensitive filesystem: all the same untrusted code, all the same header.
    await writeFile(join(dir, 'widgets', 'clock', 'popup.html'), '<html><body>second</body></html>')
    for (const url of ['/widgets/clock/', '/widgets/clock/index.html', '/widgets/clock/Index.html',
      '/widgets/clock/style.css', '/widgets/ghost/index.html']) {
      const res = await app.inject({ url })
      expect(res.headers['content-security-policy'], url).toBe(WIDGET_CSP)
    }
  })
  it('runs no script in a document that is not the widget\'s page', async () => {
    // Only index.html gets the bridge, and the bridge is what takes WebRTC away: a second page,
    // an SVG or an XML file the frame navigated to would otherwise run with it intact.
    for (const name of ['popup.html', 'page.HTM', 'image.svg', 'feed.xml', 'doc.xhtml', 'sub/index.html']) {
      await mkdir(join(dir, 'widgets', 'clock', 'sub'), { recursive: true })
      await writeFile(join(dir, 'widgets', 'clock', name), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
      const res = await app.inject({ url: `/widgets/clock/${name}` })
      expect(res.statusCode, name).toBe(200)
      const csp = String(res.headers['content-security-policy'])
      expect(csp, name).toContain("script-src 'none'")
      expect(csp, name).toContain('sandbox allow-scripts')
      expect(csp, name).toContain("connect-src 'none'")
    }
    expect((await app.inject({ url: '/widgets/clock/style.css' })).headers['content-security-policy']).toBe(WIDGET_CSP)
  })
  it('puts the bridge ahead of anything the widget wrote, wherever its <head> is', async () => {
    // Each of these once let a script of the widget's run before the bridge, which is the one
    // thing the WebRTC guard cannot survive: `<header>` and a commented `<head>` both matched the
    // old "after <head>" rule, and a page with no doctype has nothing ahead of it at all.
    const pages = [
      '<!doctype html><script>evil()</script><header>x</header>',
      '<!doctype html><!-- <head> --><script>evil()</script><head></head>',
      '<script>evil()</script><html><head></head></html>',
      '<!--><script>evil()</script><!-- --><!doctype html><head></head>',
      '\uFEFF  <!DOCTYPE html>\n<script>evil()</script>',
    ]
    for (const page of pages) {
      await writeFile(join(dir, 'widgets', 'clock', 'index.html'), page)
      const body = (await app.inject({ url: '/widgets/clock/index.html' })).body
      expect(body.indexOf('<script src="/fremkit.js"></script>'), page).toBeGreaterThanOrEqual(0)
      expect(body.indexOf('<script src="/fremkit.js"></script>'), page).toBeLessThan(body.indexOf('evil'))
      // Nothing but a doctype ahead of it.
      expect(body.slice(0, body.indexOf('<script src="/fremkit.js">')).replace(/^\uFEFF?\s*(<!doctype[^>]*>)?/i, ''), page).toBe('')
    }
  })
  it('gives WebRTC\'s local level to a listed built-in only, never to an installed widget', async () => {
    const listed = await buildApp({
      accessToken: null, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'),
      webrtcLocalBuiltins: new Set(['clock', 'synology']),
    })
    try {
      const folder = join(dir, 'data', 'widgets', 'synology')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'manifest.json'), JSON.stringify({ id: 'synology', name: 'NAS', version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4] }))
      await writeFile(join(folder, 'index.html'), '<!doctype html><body>nas</body>')
      await listed.inject({ method: 'POST', url: '/api/widgets/rescan' })
      const builtin = (await listed.inject({ url: '/widgets/clock/index.html' })).body
      expect(builtin).toMatch(/^<!doctype html><script src="\/fremkit\.js" data-webrtc="local" data-webrtc-hosts="[0-9a-f.: ]*"><\/script>/)
      expect(builtin).toContain('127.0.0.1')
      // On the list by id, but installed: the source decides, not the name.
      const installed = (await listed.inject({ url: '/widgets/synology/index.html' })).body
      expect(installed).toBe('<!doctype html><script src="/fremkit.js"></script><body>nas</body>')
      // And with the shipped list, which names only fremplay, the clock does not have it.
      expect((await app.inject({ url: '/widgets/clock/index.html' })).body).not.toContain('data-webrtc')
    } finally {
      await listed.close()
    }
  })
  it('spells out what a widget may load', async () => {
    const csp = WIDGET_CSP
    // No same-origin: whatever a widget does, it does not do it as http://127.0.0.1:4242.
    expect(csp).toContain('sandbox allow-scripts')
    expect(csp).not.toContain('allow-same-origin')
    // Every network call goes through the bridge and the proxy, never straight out.
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })
  it('refuses a dotfile a widget folder happens to hold', async () => {
    await writeFile(join(dir, 'widgets', 'clock', '.env'), 'TOKEN=secret')
    const res = await app.inject({ url: '/widgets/clock/.env' })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('TOKEN')
  })
  it('serves other widget files and refuses traversal', async () => {
    expect((await app.inject({ url: '/widgets/clock/style.css' })).body).toBe('body{color:red}')
    expect((await app.inject({ url: '/widgets/clock/../../data/fremkit.json' })).statusCode).toBeGreaterThanOrEqual(400)
    expect((await app.inject({ url: '/widgets/Bad%20Id/index.html' })).statusCode).toBe(404)
    expect((await app.inject({ url: '/widgets/ghost/index.html' })).statusCode).toBe(404)
  })
  it('returns 404 when a widget\'s index.html vanished after scan', async () => {
    await rm(join(dir, 'widgets', 'clock', 'index.html'))
    const res = await app.inject({ url: '/widgets/clock/index.html' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/introuvable|not found/)
  })
  it('serves an installed widget the same way, with the same guards', async () => {
    // `data/widgets` is the marketplace's folder. Everything the built-in folder gets — the CSP,
    // the bridge injection, the dotfile denial, the traversal refusal — must hold here too, or
    // the guards would be a property of one path rather than of widgets.
    const folder = join(dir, 'data', 'widgets', 'synology')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ id: 'synology', name: 'NAS', version: '1.0.0', minSize: [8, 4], defaultSize: [8, 4] }))
    await writeFile(join(folder, 'index.html'), '<!doctype html><html><head></head><body>nas</body></html>')
    await writeFile(join(folder, 'app.js'), 'console.log(1)')
    await writeFile(join(folder, '.env'), 'TOKEN=secret')
    const scan = await app.inject({ method: 'POST', url: '/api/widgets/rescan' })
    expect(Object.keys(scan.json().widgets).sort()).toEqual(['clock', 'synology'])
    expect(scan.json().sources).toEqual({ clock: 'builtin', synology: 'installed' })

    const html = await app.inject({ url: '/widgets/synology/index.html' })
    expect(html.statusCode).toBe(200)
    expect(html.headers['content-security-policy']).toBe(WIDGET_CSP)
    expect(html.body).toBe('<!doctype html><script src="/fremkit.js"></script><html><head></head><body>nas</body></html>')
    expect((await app.inject({ url: '/widgets/synology/app.js' })).body).toBe('console.log(1)')

    const dotfile = await app.inject({ url: '/widgets/synology/.env' })
    expect(dotfile.statusCode).toBe(403)
    expect(dotfile.body).not.toContain('TOKEN')
    // An escape the client does not normalise away: the built-in folder is not reachable
    // through the installed one, and neither is anything else beside it.
    expect((await app.inject({ url: '/widgets/synology/..%2fclock%2fstyle.css' })).statusCode).toBeGreaterThanOrEqual(400)
    expect((await app.inject({ url: '/widgets/synology/..%2f..%2ffremkit.json' })).statusCode).toBeGreaterThanOrEqual(400)
  })

  it('says where each widget came from', async () => {
    expect((await app.inject({ url: '/api/widgets' })).json().sources).toEqual({ clock: 'builtin' })
  })

  it('serves the bridge script', async () => {
    const res = await app.inject({ url: '/fremkit.js' })
    expect(res.headers['content-type']).toContain('javascript')
    expect(res.body).toContain('window.Fremkit')
    // The project's former name is gone from the bridge: no published user ever saw it.
    expect(res.body).not.toContain('Vardek')
    expect(res.body).not.toContain('vardek')
  })
})

describe('the byte-route list', () => {
  it('names only prefixes that a registered route answers', async () => {
    // A prefix matching nothing is dead weight that reads as protection: /api/dock/ was one.
    const routes = app.printRoutes({ commonPrefix: false })
    for (const prefix of BYTE_ROUTES) {
      // The route table spells parameters as :name, so compare on the fixed leading segments.
      const head = prefix.replace(/\/$/, '').split('/').filter(Boolean).slice(0, 2).join('/')
      expect(routes, prefix).toContain(head)
    }
  })
  it('covers every route that hands back bytes from elsewhere', () => {
    for (const url of ['/api/favicon?url=x', '/api/apps/icon/com.example.app', '/api/backgrounds/a.png',
      '/api/proxy/weather?url=x', '/api/bambu/b1/snapshot.jpg', '/api/backup']) {
      expect(isByteRoute(url), url).toBe(true)
    }
    for (const url of ['/api/config', '/api/widgets', '/', '/admin', '/api/connections']) {
      expect(isByteRoute(url), url).toBe(false)
    }
  })
})
