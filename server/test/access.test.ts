import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import {
  AccessGate, accessProof, CODE_TTL_MS, MAX_PENDING_CODES, MAX_SESSIONS, SESSION_IDLE_MS, SESSION_MAX_MS, cookieName, generateToken, isPublicRoute, isWellFormedToken,
  readBearer, readCookie, safeEqual, safeNext,
} from '../src/http/access.js'
import { ACCESS_TOKEN_ENV, accessTokenPath, removeAccessToken, resolveAccessToken, supportDirectory, writeAccessToken } from '../src/http/access-file.js'
import { ACCESS_CHALLENGE } from '../src/http/access-routes.js'
import { serializeRequest } from '../src/http/logging.js'

const TOKEN = generateToken()
const PORT = 4301
const HOST = `127.0.0.1:${PORT}`

let dir: string
let app: FastifyInstance
/** A session cookie, opened the way a browser opens one: by following a one-time link. */
let COOKIE: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fremkit-access-'))
  await mkdir(join(dir, 'widgets', 'clock'), { recursive: true })
  await writeFile(join(dir, 'widgets', 'clock', 'manifest.json'), JSON.stringify({ id: 'clock', name: 'Clock', version: '1.0.0', minSize: [8, 4], defaultSize: [16, 4] }))
  await writeFile(join(dir, 'widgets', 'clock', 'index.html'), '<!doctype html><html><head><title>c</title></head><body>hi</body></html>')
  await writeFile(join(dir, 'widgets', 'clock', 'style.css'), 'body{color:red}')
  await mkdir(join(dir, 'ui'), { recursive: true })
  await writeFile(join(dir, 'ui', 'index.html'), '<!doctype html><title>dash</title>')
  await writeFile(join(dir, 'ui', 'admin.html'), '<!doctype html><title>admin</title>')
  app = await buildApp({ accessToken: TOKEN, port: PORT, dataDir: join(dir, 'data'), widgetsDir: join(dir, 'widgets'), uiDist: join(dir, 'ui') })
  COOKIE = await signIn()
})
afterEach(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers: { host: HOST, ...headers } })

/** A one-time code, minted the way the helper and `pnpm open` mint one. */
async function mint(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/code', headers: { host: HOST, authorization: `Bearer ${TOKEN}` } })
  expect(res.statusCode).toBe(200)
  return res.json().code
}

/** Follows a fresh one-time link and returns the `name=value` cookie it set. */
async function signIn(): Promise<string> {
  const res = await get(`/auth?code=${await mint()}`)
  expect(res.statusCode).toBe(303)
  return String(res.headers['set-cookie']).split(';')[0]
}

describe('the access gate', () => {
  it('refuses a request without the secret with 401 and a challenge the helper recognises', async () => {
    for (const url of ['/api/config', '/api/widgets', '/', '/admin', '/ws', '/api/nothing-here']) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(401)
      expect(res.headers['www-authenticate'], url).toBe(ACCESS_CHALLENGE)
    }
    const write = await app.inject({ method: 'POST', url: '/api/widgets/rescan', headers: { host: HOST } })
    expect(write.statusCode).toBe(401)
  })
  it('answers a browser with a page, and an API caller with JSON', async () => {
    const page = await get('/admin', { accept: 'text/html,*/*' })
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.body).toMatch(/Fremkit/)
    expect(page.body).not.toMatch(/<script/i)
    const api = await get('/api/config', { accept: 'text/html,*/*' })
    expect(api.json().error).toBeTruthy()
  })
  it('refuses a wrong secret, in either carrier', async () => {
    const wrong = generateToken()
    expect((await get('/api/config', { authorization: `Bearer ${wrong}` })).statusCode).toBe(401)
    expect((await get('/api/config', { cookie: `${cookieName(PORT)}=${wrong}` })).statusCode).toBe(401)
    // The right secret under another port's cookie name belongs to another server.
    expect((await get('/api/config', { cookie: `${cookieName(4242)}=${TOKEN}` })).statusCode).toBe(401)
    expect((await get('/api/config', { authorization: `Basic ${TOKEN}` })).statusCode).toBe(401)
  })
  it('accepts the bearer header', async () => {
    expect((await get('/api/config', { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(200)
    const write = await app.inject({ method: 'POST', url: '/api/widgets/rescan', headers: { host: HOST, authorization: `Bearer ${TOKEN}` } })
    expect(write.statusCode).toBe(200)
  })
  it('accepts the cookie, among others', async () => {
    expect((await get('/api/config', { cookie: `other=1; ${COOKIE}; more=2` })).statusCode).toBe(200)
    expect((await get('/', { cookie: COOKIE })).statusCode).toBe(200)
    expect((await get('/admin', { cookie: COOKIE })).statusCode).toBe(200)
  })
  it('serves the widgets\' own files without it, and nothing else on the way', async () => {
    expect((await get('/fremkit.js')).statusCode).toBe(200)
    const doc = await get('/widgets/clock/index.html')
    expect(doc.statusCode).toBe(200)
    expect(doc.headers['content-security-policy']).toMatch(/sandbox allow-scripts/)
    expect((await get('/widgets/clock/style.css')).statusCode).toBe(200)
    // Path text that starts like a widget file but is routed elsewhere is not exempt.
    expect((await get('/widgets/../api/config')).statusCode).not.toBe(200)
    expect((await get('/widgets/%2e%2e/api/config')).json()).not.toHaveProperty('screens')
    // The catalogue lives under /api, and is not a widget file.
    expect((await get('/api/widgets')).statusCode).toBe(401)
    // Only reads are exempt.
    expect((await app.inject({ method: 'POST', url: '/fremkit.js', headers: { host: HOST } })).statusCode).not.toBe(200)
  })
  it('keeps the Host check first: a rebinding attempt is told 421 whatever it carries', async () => {
    const res = await app.inject({ url: '/api/config', headers: { host: 'evil.example', authorization: `Bearer ${TOKEN}` } })
    expect(res.statusCode).toBe(421)
  })
  it('keeps the Origin check: a cross-site write with the cookie is still refused', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/widgets/rescan', headers: { host: HOST, cookie: COOKIE, origin: 'https://evil.example' } })
    expect(res.statusCode).toBe(403)
  })
  it('does not mint a code for a caller without the secret', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/auth/code', headers: { host: HOST } })).statusCode).toBe(401)
  })
})

describe('the one-time link', () => {
  it('sets a session cookie and sends the browser on', async () => {
    const code = await mint()
    const res = await get(`/auth?code=${code}&next=${encodeURIComponent('/admin?tab=screen')}`)
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/admin?tab=screen')
    const cookie = String(res.headers['set-cookie'])
    expect(cookie.startsWith(`${cookieName(PORT)}=`)).toBe(true)
    // A session id, never the secret itself.
    expect(cookie).not.toContain(TOKEN)
    expect(cookie.split(';')[0].slice(cookieName(PORT).length + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Strict/)
    expect(cookie).toMatch(/Path=\//)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })
  it('works once', async () => {
    const code = await mint()
    expect((await get(`/auth?code=${code}`)).statusCode).toBe(303)
    const again = await get(`/auth?code=${code}`, { accept: 'text/html' })
    expect(again.statusCode).toBe(401)
    expect(again.headers['set-cookie']).toBeUndefined()
  })
  it('refuses a code nobody minted, or none at all', async () => {
    for (const url of ['/auth', `/auth?code=${generateToken()}`, '/auth?code=short', '/auth?code=']) {
      const res = await get(url)
      expect(res.statusCode, url).toBe(401)
      expect(res.headers['set-cookie'], url).toBeUndefined()
    }
  })
  it('sends the browser nowhere but this server', async () => {
    for (const next of ['//evil.example/', '/\\evil.example', 'https://evil.example/', 'evil', '/a\nb']) {
      const res = await get(`/auth?code=${await mint()}&next=${encodeURIComponent(next)}`)
      expect(res.headers.location, next).toBe('/')
    }
  })
})

describe('the session cookie', () => {
  it('is not the secret: the secret in the cookie is refused', async () => {
    expect((await get('/api/config', { cookie: `${cookieName(PORT)}=${TOKEN}` })).statusCode).toBe(401)
  })
  it('is a different session for every sign-in', async () => {
    const other = await signIn()
    expect(other).not.toBe(COOKIE)
    expect((await get('/api/config', { cookie: other })).statusCode).toBe(200)
    expect((await get('/api/config', { cookie: COOKIE })).statusCode).toBe(200)
  })
  it('cannot mint a one-time code: only the secret can', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/code', headers: { host: HOST, cookie: COOKIE } })
    expect(res.statusCode).toBe(401)
  })
  it('cannot be presented as a bearer', async () => {
    const id = COOKIE.split('=')[1]
    expect((await get('/api/config', { authorization: `Bearer ${id}` })).statusCode).toBe(401)
  })
  it('signs out: the session ends and the cookie is cleared', async () => {
    const other = await signIn()
    const res = await app.inject({ method: 'DELETE', url: '/api/auth/session', headers: { host: HOST, cookie: COOKIE } })
    expect(res.statusCode).toBe(204)
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/)
    expect((await get('/api/config', { cookie: COOKIE })).statusCode).toBe(401)
    // Only that one.
    expect((await get('/api/config', { cookie: other })).statusCode).toBe(200)
  })
  it('dies with the server: a new process knows none of the old sessions', async () => {
    const again = await buildApp({ accessToken: TOKEN, port: PORT, dataDir: join(dir, 'data2'), widgetsDir: join(dir, 'widgets'), uiDist: join(dir, 'ui') })
    try {
      const res = await again.inject({ url: '/api/config', headers: { host: HOST, cookie: COOKIE } })
      expect(res.statusCode).toBe(401)
    } finally {
      await again.close()
    }
  })
})

describe('the proof', () => {
  const nonce = 'n0nce-for-the-test_0123456789'
  it('answers without a credential, with a MAC only the secret could make', async () => {
    const res = await get(`/auth/proof?nonce=${nonce}`)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.json().proof).toBe(accessProof(TOKEN, nonce))
    expect(res.json().proof).not.toBe(accessProof(generateToken(), nonce))
    expect(res.body).not.toContain(TOKEN)
  })
  it('matches a fixed vector, which the helper checks too (AccessProofTests.swift)', () => {
    expect(accessProof('A'.repeat(43), 'abcdefghijklmnop')).toBe('XAkZGHu68HFGxebuJzgT09AtTRQ3rswof7b2of6to_o')
  })
  it('refuses a nonce that is not one', async () => {
    for (const bad of ['', 'short', 'x'.repeat(129), 'has space here!!!!']) {
      expect((await get(`/auth/proof?nonce=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400)
    }
  })
  it('is a read only', async () => {
    expect((await app.inject({ method: 'POST', url: `/auth/proof?nonce=${nonce}`, headers: { host: HOST } })).statusCode).not.toBe(200)
  })
})

describe('AccessGate sessions', () => {
  const cookieFor = (gate: AccessGate, id: string) => ({ cookie: `${gate.cookie}=${id}` })
  it('expire after a day unused', () => {
    let now = 1_000_000
    const gate = new AccessGate(TOKEN, { now: () => now })
    const id = gate.openSession()
    now += SESSION_IDLE_MS - 1
    expect(gate.isAuthorized(cookieFor(gate, id))).toBe(true)
    now += SESSION_IDLE_MS - 1
    expect(gate.isAuthorized(cookieFor(gate, id))).toBe(true)
    now += SESSION_IDLE_MS
    expect(gate.isAuthorized(cookieFor(gate, id))).toBe(false)
  })
  it('expire after a week however much they are used', () => {
    let now = 1_000_000
    const gate = new AccessGate(TOKEN, { now: () => now })
    const id = gate.openSession()
    for (let t = 0; t < SESSION_MAX_MS - 3_600_000; t += 3_600_000) {
      now = 1_000_000 + t
      expect(gate.isAuthorized(cookieFor(gate, id))).toBe(true)
    }
    now = 1_000_000 + SESSION_MAX_MS
    expect(gate.isAuthorized(cookieFor(gate, id))).toBe(false)
  })
  it('are revoked one by one or all at once', () => {
    const gate = new AccessGate(TOKEN)
    const a = gate.openSession()
    const b = gate.openSession()
    gate.revokeSession(a)
    expect(gate.isAuthorized(cookieFor(gate, a))).toBe(false)
    expect(gate.isAuthorized(cookieFor(gate, b))).toBe(true)
    gate.revokeAllSessions()
    expect(gate.isAuthorized(cookieFor(gate, b))).toBe(false)
  })
  it('are bounded, dropping the least recently used', () => {
    let now = 1_000_000
    const gate = new AccessGate(TOKEN, { now: () => now })
    const first = gate.openSession()
    const second = gate.openSession()
    now += 120_000
    // Using the first one makes the second the least recently used.
    expect(gate.isAuthorized(cookieFor(gate, first))).toBe(true)
    for (let i = 0; i < MAX_SESSIONS - 1; i++) gate.openSession()
    expect(gate.sessionCount).toBe(MAX_SESSIONS)
    expect(gate.isAuthorized(cookieFor(gate, first))).toBe(true)
    expect(gate.isAuthorized(cookieFor(gate, second))).toBe(false)
  })
})

describe('AccessGate', () => {
  it('expires a code after its time', () => {
    let now = 1_000_000
    const gate = new AccessGate(TOKEN, { now: () => now })
    const late = gate.mintCode()
    const onTime = gate.mintCode()
    now += CODE_TTL_MS - 1
    expect(gate.redeem(onTime)).toBe(true)
    now += 1
    expect(gate.redeem(late)).toBe(false)
  })
  it('keeps a bounded number of pending codes, dropping the oldest', () => {
    const gate = new AccessGate(TOKEN)
    const first = gate.mintCode()
    const rest = Array.from({ length: MAX_PENDING_CODES }, () => gate.mintCode())
    expect(gate.redeem(first)).toBe(false)
    expect(gate.redeem(rest[rest.length - 1])).toBe(true)
  })
  it('refuses a secret too short to be one', () => {
    expect(() => new AccessGate('short')).toThrow()
    expect(() => new AccessGate('a'.repeat(42))).toThrow()
    expect(() => new AccessGate('a'.repeat(43))).not.toThrow()
  })
  it('names the cookie after the port, since browsers share cookies across ports', () => {
    expect(new AccessGate(TOKEN, { port: 4242 }).cookie).toBe('fremkit_access_4242')
    expect(cookieName(4301)).not.toBe(cookieName(4242))
  })
})

describe('helpers', () => {
  it('generates 32-byte base64url secrets', () => {
    const t = generateToken()
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(t, 'base64url')).toHaveLength(32)
    expect(generateToken()).not.toBe(t)
    expect(isWellFormedToken(t)).toBe(true)
    expect(isWellFormedToken(t + '=')).toBe(false)
  })
  it('compares in full', () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true)
    expect(safeEqual(TOKEN, TOKEN.slice(0, -1))).toBe(false)
    expect(safeEqual('', TOKEN)).toBe(false)
  })
  it('reads the carriers strictly', () => {
    expect(readBearer(`Bearer ${TOKEN}`)).toBe(TOKEN)
    expect(readBearer(`bearer ${TOKEN}`)).toBe(TOKEN)
    expect(readBearer(`Bearer ${TOKEN} extra`)).toBeUndefined()
    expect(readBearer(undefined)).toBeUndefined()
    expect(readCookie('a=1; fremkit_access_1=x', 'fremkit_access_1')).toBe('x')
    expect(readCookie('xfremkit_access_1=x', 'fremkit_access_1')).toBeUndefined()
  })
  it('exempts routes, not path text', () => {
    expect(isPublicRoute('GET', '/widgets/:id/*')).toBe(true)
    expect(isPublicRoute('HEAD', '/fremkit.js')).toBe(true)
    expect(isPublicRoute('POST', '/auth')).toBe(false)
    expect(isPublicRoute('GET', '/api/widgets')).toBe(false)
    expect(isPublicRoute('GET', undefined)).toBe(false)
  })
  it('keeps next on this server', () => {
    expect(safeNext('/admin')).toBe('/admin')
    expect(safeNext(undefined)).toBe('/')
    expect(safeNext('//x')).toBe('/')
  })
})

describe('the token file', () => {
  it('is written mode 0600 and replaced whole', async () => {
    const path = join(dir, 'support', `access-${PORT}.token`)
    await writeAccessToken(path, TOKEN)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await readFile(path, 'utf8')).trim()).toBe(TOKEN)
    const next = generateToken()
    await writeAccessToken(path, next)
    expect((await readFile(path, 'utf8')).trim()).toBe(next)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    // No temporary file left behind.
    expect(await readdir(join(dir, 'support'))).toEqual([`access-${PORT}.token`])
  })
  it('is removed on exit only while it still holds this server\'s secret', async () => {
    const path = join(dir, 'support', `access-${PORT}.token`)
    await writeAccessToken(path, TOKEN)
    removeAccessToken(path, generateToken())
    expect((await readFile(path, 'utf8')).trim()).toBe(TOKEN)
    removeAccessToken(path, TOKEN)
    await expect(stat(path)).rejects.toThrow()
    // Already gone: quiet.
    expect(() => removeAccessToken(path, TOKEN)).not.toThrow()
  })
  it('lives in the helper\'s support folder, keyed by port', () => {
    expect(accessTokenPath(4242, {}, '/Users/u')).toBe('/Users/u/Library/Application Support/Fremkit/access-4242.token')
    expect(supportDirectory({ FREMKIT_SUPPORT_DIR: '/tmp/s' }, '/Users/u')).toBe('/tmp/s')
    expect(supportDirectory({ FREMKIT_SUPPORT_DIR: 'relative' }, '/Users/u')).toBe('/Users/u/Library/Application Support/Fremkit')
  })
  it('takes the launcher\'s secret and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { [ACCESS_TOKEN_ENV]: TOKEN }
    expect(resolveAccessToken(env)).toEqual({ token: TOKEN, source: 'env', rejected: false })
    expect(env[ACCESS_TOKEN_ENV]).toBeUndefined()
    const bad: NodeJS.ProcessEnv = { [ACCESS_TOKEN_ENV]: 'weak' }
    const r = resolveAccessToken(bad)
    expect(r.source).toBe('generated')
    expect(r.rejected).toBe(true)
    expect(r.token).not.toBe('weak')
    expect(bad[ACCESS_TOKEN_ENV]).toBeUndefined()
    expect(resolveAccessToken({}).rejected).toBe(false)
  })
})

describe('the secret stays out of what the server says', () => {
  it('is in no response, the cookie /auth sets included', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` }
    const answers = await Promise.all([
      get('/api/config'), get('/api/config', auth), get('/api/widgets', auth), get('/', { cookie: COOKIE }),
      get('/auth?code=nope'), get('/fremkit.js'), get('/widgets/clock/index.html'),
      app.inject({ method: 'POST', url: '/api/auth/code', headers: { host: HOST, ...auth } }),
      get(`/auth?code=${await mint()}`),
      app.inject({ method: 'PUT', url: '/api/config', headers: { host: HOST, ...auth }, payload: { nope: true } }),
    ])
    for (const res of answers) {
      expect(res.body).not.toContain(TOKEN)
      expect(JSON.stringify(res.headers)).not.toContain(TOKEN)
    }
  })
  it('is not in the request log line, nor is a code', () => {
    const line = serializeRequest({
      method: 'GET', url: '/auth?code=abc&next=/', ip: '127.0.0.1',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}`, cookie: COOKIE },
    })
    expect(JSON.stringify(line)).not.toContain(TOKEN)
    expect(line.url).toBe('/auth')
  })
})
