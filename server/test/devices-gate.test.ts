import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance, RouteOptions } from 'fastify'
import { buildApp } from '../src/app.js'
import { RemoteListener } from '../src/devices/listener.js'
import { remoteAccess } from '../src/devices/allowlist.js'
import { readCookie } from '../src/http/cookies.js'
import { generateToken } from '../src/http/access.js'
import { hostAddresses } from '../src/widgets/webrtc.js'
import { hasOpenssl, remote, tlsMaterial, upgrade } from './helpers/remote.js'

let dir: string
let app: FastifyInstance
let listener: RemoteListener
let port: number
let token: string
const routes: { method: string; url: string }[] = []

const cookie = (t: string): Record<string, string> => ({ cookie: `fremkit_device=${t}` })

/** A widget and a built UI, enough for every kind of route to answer. */
async function writeFixture(root: string): Promise<void> {
  await mkdir(join(root, 'widgets', 'clock'), { recursive: true })
  await writeFile(join(root, 'widgets', 'clock', 'manifest.json'), JSON.stringify({ id: 'clock', name: 'Clock', version: '1.0.0', minSize: [8, 4], defaultSize: [16, 4] }))
  await writeFile(join(root, 'widgets', 'clock', 'index.html'), '<!doctype html><html><head><title>c</title></head><body>hi</body></html>')
  // A built-in at WebRTC's `local` level, whose page carries the Mac's addresses when asked locally.
  await mkdir(join(root, 'widgets', 'fremplay'), { recursive: true })
  await writeFile(join(root, 'widgets', 'fremplay', 'manifest.json'), JSON.stringify({ id: 'fremplay', name: 'Fremplay', version: '1.0.0', minSize: [8, 4], defaultSize: [16, 4] }))
  await writeFile(join(root, 'widgets', 'fremplay', 'index.html'), '<!doctype html><html><body>play</body></html>')
  const ui = join(root, 'ui')
  await mkdir(join(ui, 'assets'), { recursive: true })
  await writeFile(join(ui, 'index.html'), '<!doctype html><title>dashboard</title>')
  await writeFile(join(ui, 'admin.html'), '<!doctype html><title>ADMIN</title>')
  await writeFile(join(ui, 'assets', 'app.js'), 'console.log(1)')
  await writeFile(join(ui, 'favicon.svg'), '<svg/>')
}

const concrete = (url: string): string => url.replace(/:[A-Za-z0-9_]+(\([^)]*\))?/g, 'x').replace(/\*/g, 'x')

/**
 * Sends every registered route the allow-list does not name, in every method it was registered
 * for, to the remote listener with a valid device token, and expects 404 from each. Returns what
 * it walked.
 */
async function walkRoutes(list: { method: string; url: string }[], remotePort: number, deviceToken: string) {
  const walked: { method: string; url: string }[] = []
  for (const r of list) {
    const path = concrete(r.url)
    if (remoteAccess(r.method, path) !== null) continue
    const res = await remote(remotePort, { method: r.method, path, headers: cookie(deviceToken) })
    expect(res.status, `${r.method} ${r.url}`).toBe(404)
    walked.push(r)
  }
  return walked
}

describe('remoteAccess', () => {
  it('lets in the listed paths and nothing else', () => {
    expect(remoteAccess('POST', '/api/pair')).toBe('public')
    expect(remoteAccess('GET', '/')).toBe('public')
    expect(remoteAccess('GET', '/index.html')).toBe('public')
    expect(remoteAccess('GET', '/assets/index-abc123.js')).toBe('public')
    expect(remoteAccess('GET', '/favicon.svg')).toBe('public')
    expect(remoteAccess('GET', '/fremkit.js')).toBe('public')
    expect(remoteAccess('GET', '/widgets/clock/index.html')).toBe('public')
    expect(remoteAccess('GET', '/api/config')).toBe('token')
    expect(remoteAccess('GET', '/ws')).toBe('token')
    expect(remoteAccess('POST', '/api/proxy/clock/conn')).toBe('token')
    expect(remoteAccess('GET', '/api/backgrounds/a%20b.jpg')).toBe('token')
    for (const [m, p] of [
      ['GET', '/admin'], ['GET', '/admin.html'], ['GET', '/admin/'], ['PUT', '/api/config'],
      ['GET', '/api/connections'], ['GET', '/api/backup'], ['GET', '/api/pair'], ['POST', '/api/config'],
      ['GET', '/INDEX.html'], ['GET', '//admin.html'], ['GET', '/api/config/'], ['HEAD', '/api/config'],
      ['GET', '/api/proxy/x/conn'], ['GET', '/api/backgrounds/a/b'],
    ]) expect(remoteAccess(m, p), `${m} ${p}`).toBeNull()
  })
  it('refuses dot segments, encoded or not, and encoded slashes', () => {
    for (const p of [
      '/assets/../admin.html', '/assets/%2e%2e/admin.html', '/assets/%2E%2E/admin.html',
      '/assets/..%2fadmin.html', '/assets/x%5c..%5cadmin.html', '/widgets/clock/../../admin.html',
      '/widgets/%2e%2e/admin.html', '/assets/./x.js', '/assets/%E0%A4%A.js', '/api/backgrounds/..',
      '/assets\\..\\admin.html',
    ]) expect(remoteAccess('GET', p), p).toBeNull()
  })
})

describe('readCookie', () => {
  it('finds one cookie among several and ignores look-alikes', () => {
    expect(readCookie('a=1; fremkit_device=tok; b=2', 'fremkit_device')).toBe('tok')
    expect(readCookie(['a=1', 'fremkit_device= tok '], 'fremkit_device')).toBe('tok')
    expect(readCookie('xfremkit_device=tok', 'fremkit_device')).toBeUndefined()
    expect(readCookie('fremkit_device=', 'fremkit_device')).toBe('')
    expect(readCookie(undefined, 'fremkit_device')).toBeUndefined()
  })
})

describe.skipIf(!hasOpenssl)('the remote gate, through a real TLS listener', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-gate-'))
    await writeFixture(dir)
    app = await buildApp({
      accessToken: null,
      dataDir: join(dir, 'data'),
      widgetsDir: join(dir, 'widgets'),
      uiDist: join(dir, 'ui'),
      onRoute: (r: RouteOptions) => {
        for (const method of [r.method].flat()) routes.push({ method, url: r.url })
      },
    })
    listener = new RemoteListener(app, 0)
    const { key, cert } = await tlsMaterial()
    await listener.start(key, cert)
    port = listener.port
    app.pairing.setRemoteHosts(() => new Set([`127.0.0.1:${port}`, `example.local:${port}`]))
    ;({ token } = await app.pairing.store.create('iPad', { width: 1180, height: 820 }, null))
  })
  afterAll(async () => {
    await listener?.stop()
    // Mutations are queued: one more waits out the un-awaited `touch` a request left behind,
    // so its write does not land in a directory being removed.
    await app?.pairing.store.touch('none')
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts with no remote hosts, so every remote request is 421', async () => {
    app.pairing.setRemoteHosts(() => new Set())
    try {
      expect((await remote(port, { path: '/' })).status).toBe(421)
    } finally {
      app.pairing.setRemoteHosts(() => new Set([`127.0.0.1:${port}`, `example.local:${port}`]))
    }
  })

  it('answers 404 for every registered route the allow-list does not name, even with a valid token', async () => {
    const walked = await walkRoutes(routes, port, token)
    expect(walked.length).toBeGreaterThan(40)
    // The companion's routes are among them: if they ever moved behind an option these tests
    // leave off, the walk would silently stop covering them.
    expect(walked.map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining([
      'POST /api/companion/pair', 'POST /api/companion/pair/:requestId',
      'POST /api/companion/pair/:requestId/confirm',
      'POST /api/companion/requests/:requestId/refuse', 'POST /api/companion/unlock',
      'GET /companion/ws',
      // The admin's "Reload the dashboard": a device reloads its own page, it never asks the Mac to.
      'POST /api/screens/:id/reload',
    ]))
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(walked.some((r) => r.method === method), method).toBe(true)
    }
  })

  it('lets exactly the expected registered routes through', () => {
    const allowed = new Set(
      routes
        .filter((r) => remoteAccess(r.method, r.url.replace(/:[A-Za-z0-9_]+(\([^)]*\))?/g, 'x').replace(/\*/g, 'x')) !== null)
        .map((r) => `${r.method} ${r.url}`),
    )
    expect([...allowed].sort()).toEqual([
      'GET /api/apps/icon/:bundleId',
      'GET /api/apps/installed',
      'GET /api/backgrounds/:name',
      'GET /api/config',
      'GET /api/config/status',
      'GET /api/devices/me',
      'GET /api/favicon',
      'GET /api/proxy/:widgetId',
      'GET /api/themes',
      'GET /api/widgets',
      'GET /fremkit.js',
      'GET /widgets/:id/*',
      'GET /ws',
      'POST /api/devices/me/brightness',
      'POST /api/pair',
      'POST /api/proxy/:widgetId/conn',
    ])
  })

  it('hides the admin, connections, backup and config writes even from a paired device', async () => {
    for (const [method, path] of [
      ['GET', '/admin'], ['GET', '/admin/'], ['GET', '/admin.html'], ['GET', '/api/connections'],
      ['GET', '/api/backup'], ['PUT', '/api/config'],
      ['GET', '/assets/..%2fadmin.html'], ['GET', '/assets/%2e%2e/admin.html'], ['GET', '/%61dmin.html'],
    ]) {
      const res = await remote(port, { method, path, headers: { ...cookie(token), 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: '{}' } : {}) })
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(res.body).not.toContain('ADMIN')
      // The same answer as a route that does not exist at all.
      expect(JSON.parse(res.body)).toMatchObject({ statusCode: 404, error: 'Not Found' })
    }
  })

  it('keeps the helper\'s brightness hook off the remote listener, even from this Mac', async () => {
    // The request comes from 127.0.0.1, as the helper's would, but over the remote listener.
    const res = await remote(port, {
      method: 'POST', path: '/api/hooks/brightness',
      headers: { ...cookie(token), 'content-type': 'application/json' },
      body: JSON.stringify({ available: true, value: 10 }),
    })
    expect(res.status).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/hooks/brightness', payload: { available: true, value: 10 } })).statusCode).toBe(204)
  })

  it('serves the public shell without a token', async () => {
    const index = await remote(port, { path: '/' })
    expect(index.status).toBe(200)
    expect(index.body).toContain('dashboard')
    expect((await remote(port, { path: '/index.html' })).status).toBe(200)
    expect((await remote(port, { path: '/assets/app.js?v=1' })).status).toBe(200)
    expect((await remote(port, { path: '/favicon.svg' })).status).toBe(200)
    expect((await remote(port, { path: '/fremkit.js' })).status).toBe(200)
  })

  it('asks a token of the token routes', async () => {
    const none = await remote(port, { path: '/api/config' })
    expect(none.status).toBe(401)
    expect(typeof JSON.parse(none.body).error).toBe('string')
    expect((await remote(port, { path: '/api/config', headers: cookie('not-a-token') })).status).toBe(401)
    expect((await remote(port, { path: '/api/config', headers: { cookie: 'fremkit_device=' } })).status).toBe(401)
    const ok = await remote(port, { path: '/api/config', headers: cookie(token) })
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).screens).toBeDefined()
  })

  it('refuses a token whose device was removed', async () => {
    const { device, token: t } = await app.pairing.store.create('Old iPad', { width: 1024, height: 768 }, null)
    expect((await remote(port, { path: '/api/config', headers: cookie(t) })).status).toBe(200)
    await app.pairing.store.remove(device.id)
    expect((await remote(port, { path: '/api/config', headers: cookie(t) })).status).toBe(401)
  })

  it('records the device as seen', async () => {
    const { device, token: t } = await app.pairing.store.create('Seen', { width: 1024, height: 768 }, null)
    expect((await remote(port, { path: '/api/widgets', headers: cookie(t) })).status).toBe(200)
    await expect.poll(() => app.pairing.store.list().find((d) => d.id === device.id)?.lastSeen).not.toBeNull()
  })

  it('refuses a Host it does not answer to, and believes no forwarded address', async () => {
    expect((await remote(port, { path: '/api/config', host: '127.0.0.1:4242', headers: cookie(token) })).status).toBe(421)
    expect((await remote(port, { path: '/', host: 'evil.example' })).status).toBe(421)
    expect((await remote(port, { path: '/api/config', headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(401)
  })

  it('holds writes and the WebSocket to its own https origin', async () => {
    const write = (origin?: string) => remote(port, {
      method: 'POST', path: '/api/proxy/clock/conn',
      headers: { ...cookie(token), 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: '{}',
    })
    expect((await write('http://127.0.0.1:4242')).status).toBe(403)
    expect((await write('https://evil.example')).status).toBe(403)
    expect((await write(`https://127.0.0.1:${port}`)).status).not.toBe(403)
    expect((await write()).status).not.toBe(403)
    // A read from elsewhere is not a write.
    expect((await remote(port, { path: '/api/config', headers: { ...cookie(token), origin: 'https://evil.example' } })).status).toBe(200)

    const refused = await upgrade(port, { ...cookie(token), origin: 'https://evil.example' })
    expect(refused.status).toBe(403)
    const anonymous = await upgrade(port, { origin: `https://127.0.0.1:${port}` })
    expect(anonymous.status).toBe(401)
    const opened = await upgrade(port, { ...cookie(token), origin: `https://127.0.0.1:${port}` })
    expect(opened.status).toBe(101)
    if ('socket' in opened) opened.socket.destroy()
  })

  it('refuses a browser extension\'s token as a device cookie: 401 over HTTP and on the socket', async () => {
    const { token: extensionToken } = await app.pairing.store.createExtension({
      name: 'Chrome', origin: `chrome-extension://${'g'.repeat(32)}`, installId: '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d',
    })
    for (const path of ['/api/config', '/api/widgets', '/api/devices/me']) {
      expect((await remote(port, { path, headers: cookie(extensionToken) })).status, path).toBe(401)
    }
    expect((await remote(port, { method: 'POST', path: '/api/proxy/clock/conn', headers: { ...cookie(extensionToken), 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    const ws = await upgrade(port, { ...cookie(extensionToken), origin: `https://127.0.0.1:${port}` })
    expect(ws.status).toBe(401)
    // The iPad's token, sent the same way, still opens them: the refusal is the kind, not the cookie.
    expect((await remote(port, { path: '/api/config', headers: cookie(token) })).status).toBe(200)
  })

  it('serves a `local` built-in at the `none` level through the listener, with none of the Mac\'s addresses', async () => {
    const local = (await app.inject({ url: '/widgets/fremplay/index.html' })).body
    expect(local).toContain('data-webrtc="local"')
    expect(local).toContain('data-webrtc-hosts=')
    for (const headers of [{}, cookie(token)]) {
      const res = await remote(port, { path: '/widgets/fremplay/index.html', host: `example.local:${port}`, headers })
      expect(res.status).toBe(200)
      expect(res.body).toContain('<script src="/fremkit.js"></script>')
      expect(res.body).not.toContain('data-webrtc')
      for (const address of hostAddresses()) expect(res.body, address).not.toContain(address)
    }
  })

  it('builds the widget CSP from the remote origin', async () => {
    const res = await remote(port, { path: '/widgets/clock/index.html', host: `example.local:${port}` })
    expect(res.status).toBe(200)
    const csp = String(res.headers['content-security-policy'])
    expect(csp).toContain(`https://example.local:${port}`)
    expect(csp).not.toContain('127.0.0.1')
    expect(csp).toContain('sandbox allow-scripts')
    // Framed by the iPad's page from this same origin, and by no other page.
    expect(csp).toContain(`frame-ancestors https://example.local:${port}`)
    expect(csp.split('; ').find((d) => d.startsWith('frame-ancestors'))).toBe(`frame-ancestors https://example.local:${port}`)
  })

  it('gives the dashboard a host CSP written for the remote origin', async () => {
    const res = await remote(port, { path: '/', host: `example.local:${port}` })
    expect(res.status).toBe(200)
    const csp = String(res.headers['content-security-policy'])
    // The WebSocket and the widget frames of https://<mac>:4243, and nothing on loopback, which
    // from an iPad would be the iPad itself.
    expect(csp).toContain(`connect-src 'self' wss://example.local:${port}`)
    expect(csp).toContain(`frame-src https://example.local:${port}/widgets/`)
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain('127.0.0.1')
  })

  it('leaves local requests exactly as they were', async () => {
    expect((await app.inject({ url: '/admin' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/connections' })).statusCode).toBe(200)
    expect((await app.inject({ url: '/api/config' })).statusCode).toBe(200)
    // The loopback guard still judges local requests, and the remote names mean nothing there.
    expect((await app.inject({ url: '/api/config', headers: { host: `example.local:${port}` } })).statusCode).toBe(421)
    expect((await app.inject({ method: 'PUT', url: '/api/config', headers: { origin: `https://127.0.0.1:${port}` }, payload: {} })).statusCode).toBe(403)
    const local = await app.inject({ url: '/widgets/clock/index.html' })
    expect(String(local.headers['content-security-policy'])).toContain('http://127.0.0.1:4242')
  })
})

describe.skipIf(!hasOpenssl)('the remote gate beside the local access secret', () => {
  const ACCESS_PORT = 4301
  const accessToken = generateToken()
  let adir: string
  let aapp: FastifyInstance
  let alistener: RemoteListener
  let aport: number
  let atoken: string
  const aroutes: { method: string; url: string }[] = []

  beforeAll(async () => {
    adir = await mkdtemp(join(tmpdir(), 'fremkit-gate-access-'))
    await writeFixture(adir)
    aapp = await buildApp({
      accessToken,
      port: ACCESS_PORT,
      dataDir: join(adir, 'data'),
      widgetsDir: join(adir, 'widgets'),
      uiDist: join(adir, 'ui'),
      onRoute: (r: RouteOptions) => {
        for (const method of [r.method].flat()) aroutes.push({ method, url: r.url })
      },
    })
    alistener = new RemoteListener(aapp, 0)
    const { key, cert } = await tlsMaterial()
    await alistener.start(key, cert)
    aport = alistener.port
    aapp.pairing.setRemoteHosts(() => new Set([`127.0.0.1:${aport}`]))
    ;({ token: atoken } = await aapp.pairing.store.create('iPad', { width: 1180, height: 820 }, null))
  })
  afterAll(async () => {
    await alistener?.stop()
    await aapp?.pairing.store.touch('none')
    await aapp?.close()
    await rm(adir, { recursive: true, force: true })
  })

  it('is a real 32-byte secret', () => {
    expect(Buffer.from(accessToken, 'base64url').length).toBe(32)
  })

  it('lets a paired request through without the access secret', async () => {
    const res = await remote(aport, { path: '/api/config', headers: cookie(atoken) })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).screens).toBeDefined()
    expect((await remote(aport, { path: '/' })).status).toBe(200)
  })

  it('still asks the access secret of a local request', async () => {
    const host = `127.0.0.1:${ACCESS_PORT}`
    expect((await aapp.inject({ url: '/api/config', headers: { host } })).statusCode).toBe(401)
    // A device cookie means nothing on the loopback listener.
    expect((await aapp.inject({ url: '/api/config', headers: { host, ...cookie(atoken) } })).statusCode).toBe(401)
    expect((await aapp.inject({ url: '/api/config', headers: { host, authorization: `Bearer ${accessToken}` } })).statusCode).toBe(200)
  })

  it('hides the access routes from the network', async () => {
    for (const headers of [{}, cookie(atoken), { authorization: `Bearer ${accessToken}` }]) {
      expect((await remote(aport, { path: '/auth?code=x', headers })).status).toBe(404)
      expect((await remote(aport, { method: 'POST', path: '/api/auth/code', headers })).status).toBe(404)
    }
  })

  it('answers 404 for every route the allow-list does not name, the access routes included', async () => {
    const walked = await walkRoutes(aroutes, aport, atoken)
    expect(walked.length).toBeGreaterThan(40)
    expect(walked.map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining(['GET /auth', 'POST /api/auth/code']))
  })
})
