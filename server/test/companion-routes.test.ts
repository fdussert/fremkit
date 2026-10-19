import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { CONFIG_VERSION } from '../src/config/schema.js'
import { noAdvertise } from '../src/devices/bonjour.js'
import { generateToken, isPublicRoute, isCompanionRoute } from '../src/http/access.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { pairClientMac, pairKey, pairServerMac } from '../src/companion/pairProof.js'
import { hasOpenssl, remote } from './helpers/remote.js'

const SECRET = generateToken()
/** Companion's own id, which needs no listing. */
const ORIGIN = 'chrome-extension://lnckeodobpbbmfbdlpnegjpchgkehdlk'
const OTHER = `chrome-extension://${'d'.repeat(32)}`
/** A well-formed extension origin that is not let in. */
const STRANGER = `chrome-extension://${'e'.repeat(32)}`
// A developer's second copy, let in the way docs/companion.md says; read when the app is built.
process.env.FREMKIT_COMPANION_EXTENSION_IDS = ` ${'d'.repeat(32)} , not-an-id`
const INSTALL = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
const HOST = '127.0.0.1:4242'

const exec: Exec = (cmd, args) =>
  cmd === 'scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args)

const CONFIG = {
  version: CONFIG_VERSION,
  locale: 'en',
  labs: { devices: false, companion: true },
  secrets: { backend: 'file' },
  connections: [],
  widgets: {},
  screens: [{ id: 'edge', name: 'edge', kind: 'edge', display: { cols: 30, rows: 20 }, pages: [{ id: 'home', name: 'Home', items: [] }] }],
}

let dir: string
let app: FastifyInstance

const auth = { authorization: `Bearer ${SECRET}` }

/** A new install by default: one install may ask three times a minute, and is held back after a refusal. */
const SALT = Buffer.alloc(32, 5).toString('base64url')
function pair(origin: string | undefined, body: unknown = { name: 'Chrome', installId: randomUUID(), salt: SALT }) {
  return app.inject({
    method: 'POST',
    url: '/api/companion/pair',
    headers: { host: HOST, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  })
}

function answer(requestId: string, verb: 'refuse', body?: unknown) {
  return app.inject({
    method: 'POST', url: `/api/companion/requests/${requestId}/${verb}`,
    headers: { host: HOST, ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  })
}

function collect(requestId: string, origin: string | null = ORIGIN) {
  return app.inject({ method: 'POST', url: `/api/companion/pair/${requestId}`, headers: { host: HOST, ...(origin ? { origin } : {}) } })
}

function step(requestId: string, verb: 'confirm', body: unknown, origin: string | null = ORIGIN) {
  return app.inject({
    method: 'POST', url: `/api/companion/pair/${requestId}/${verb}`,
    headers: { host: HOST, 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    payload: JSON.stringify(body),
  })
}

/** The code the Edge and the admin show, as the admin reads it. */
async function codeOf(requestId: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/devices', headers: { host: HOST, ...auth } })
  const request = res.json().companionRequest
  if (request?.requestId !== requestId) throw new Error('not the waiting request')
  return request.code
}

const NONCE_E = Buffer.alloc(32, 9).toString('base64url')

/** The extension's proof of `typed`; the server's response. */
async function typeCode(requestId: string, typed: string) {
  return step(requestId, 'confirm', { nonce: NONCE_E, mac: pairClientMac(await pairKey(typed, requestId, SALT), requestId, NONCE_E) })
}
const SOME_MAC = 'A'.repeat(43)

describe('isCompanionRoute', () => {
  it('lists the routes the extension reaches without the access secret, by method', () => {
    expect(isCompanionRoute('POST', '/api/companion/pair')).toBe(true)
    expect(isCompanionRoute('post', '/api/companion/pair/:requestId')).toBe(true)
    expect(isCompanionRoute('POST', '/api/companion/pair/:requestId/confirm')).toBe(true)
    expect(isCompanionRoute('GET', '/api/companion/pair/:requestId/confirm')).toBe(false)
    expect(isCompanionRoute('GET', '/companion/ws')).toBe(true)
    expect(isCompanionRoute('GET', '/api/companion/pair')).toBe(false)
    // A GET would arrive without the extension's Origin: Chrome leaves it off.
    expect(isCompanionRoute('GET', '/api/companion/pair/:requestId')).toBe(false)
    expect(isCompanionRoute('HEAD', '/api/companion/pair/:requestId')).toBe(false)
    expect(isCompanionRoute('POST', '/api/companion/requests/:requestId/refuse')).toBe(false)
    expect(isCompanionRoute('POST', '/api/companion/pair/abc')).toBe(false)
    expect(isCompanionRoute('GET', undefined)).toBe(false)
    expect(isPublicRoute('POST', '/api/companion/pair')).toBe(false)
  })
})

describe('companion routes', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-routes-'))
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG))
    app = await buildApp({
      accessToken: SECRET,
      port: 4242,
      dataDir: dir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => ['192.0.2.10'] },
    })
  })
  // Each test starts a minute later, on Date alone: the per-minute counts and a refusal's cooldown
  // start afresh, so no test depends on what the ones before it spent.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
  })
  afterAll(async () => {
    vi.useRealTimers()
    await app?.close()
    await app?.pairing.store.settled()
    await rm(dir, { recursive: true, force: true })
  })

  it('pair without an extension origin is 403', async () => {
    expect((await pair(undefined)).statusCode).toBe(403)
    expect((await pair('http://127.0.0.1:4242')).statusCode).toBe(403)
    expect((await pair('https://example.com')).statusCode).toBe(403)
    expect((await pair(`chrome-extension://${'q'.repeat(32)}`)).statusCode).toBe(403)
  })

  it('pair, collect and confirm are 403 to an extension that is not Companion nor listed', async () => {
    expect((await pair(STRANGER)).statusCode).toBe(403)
    const { requestId } = (await pair(ORIGIN)).json()
    expect((await collect(requestId, STRANGER)).statusCode).toBe(403)
    expect((await step(requestId, 'confirm', { nonce: NONCE_E, mac: SOME_MAC }, STRANGER)).statusCode).toBe(403)
    // A listed one is let in like Companion (it is turned away as busy, which only a let-in origin hears).
    expect((await pair(OTHER)).statusCode).toBe(409)
    expect((await answer(requestId, 'refuse', { code: await codeOf(requestId) })).statusCode).toBe(200)
  })

  it('shows the asking extension\'s short id with the request', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const res = await app.inject({ method: 'GET', url: '/api/devices', headers: { host: HOST, ...auth } })
    expect(res.json().companionRequest).toMatchObject({ requestId, extension: 'lnckeo' })
    expect((await answer(requestId, 'refuse', { code: await codeOf(requestId) })).statusCode).toBe(200)
  })

  it('pair still checks the Host', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/companion/pair',
      headers: { host: 'evil.example.com', origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL, salt: SALT }),
    })
    expect(res.statusCode).toBe(421)
  })

  it('pair refuses a bad body', async () => {
    expect((await pair(ORIGIN, { name: '', installId: INSTALL, salt: SALT })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'x'.repeat(61), installId: INSTALL, salt: SALT })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'Chrome', installId: 'not-a-uuid', salt: SALT })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'Chrome', installId: INSTALL, salt: SALT, extra: 1 })).statusCode).toBe(400)
    // The extension's salt for K(code) is required, and is 32 bytes in base64url.
    expect((await pair(ORIGIN, { name: 'Chrome', installId: INSTALL })).statusCode).toBe(400)
    expect((await pair(ORIGIN, { name: 'Chrome', installId: INSTALL, salt: 'short' })).statusCode).toBe(400)
  })

  it('pair takes only a browser name from the closed list', async () => {
    for (const name of ['Approve this, it is safe', 'chrome', 'Firefox', 'Chrome ', 'Safari']) {
      expect((await pair(ORIGIN, { name, installId: INSTALL, salt: SALT })).statusCode).toBe(400)
    }
  })

  it('unlock is behind the access secret, and the status says whether pairing is locked', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/companion/unlock', headers: { host: HOST } })).statusCode).toBe(401)
    // The extension cannot unlock what its guesses locked: its Origin is refused like any other.
    expect([401, 403]).toContain((await app.inject({ method: 'POST', url: '/api/companion/unlock', headers: { host: HOST, origin: ORIGIN } })).statusCode)
    expect((await app.inject({ method: 'POST', url: '/api/companion/unlock', headers: { host: HOST, ...auth } })).json()).toEqual({ ok: true })
    const res = await app.inject({ method: 'GET', url: '/api/devices', headers: { host: HOST, ...auth } })
    expect(res.json().companionLocked).toBe(false)
  })

  it('refuse without the access secret is 401, and there is no approve', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const code = await codeOf(requestId)
    const refuse = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/refuse`, headers: { host: HOST }, payload: { code } })
    expect(refuse.statusCode).toBe(401)
    // Typing the code into the extension is the approval: nothing on this side can give one.
    const approve = await app.inject({ method: 'POST', url: `/api/companion/requests/${requestId}/approve`, headers: { host: HOST, ...auth }, payload: { code } })
    expect(approve.statusCode).toBe(404)
    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
    expect((await answer(requestId, 'refuse', { code })).statusCode).toBe(200)
  })

  it('pair never sends the code to the extension; typing it hands the token out once', async () => {
    const res = await pair(ORIGIN)
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = res.json()
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'requestId'])
    const { requestId } = body
    const code = await codeOf(requestId)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}$/)

    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
    expect((await collect(requestId, OTHER)).statusCode).toBe(403)
    expect((await collect(requestId, null)).statusCode).toBe(403)

    const got = await typeCode(requestId, code)
    expect(got.statusCode).toBe(200)
    expect(got.headers['cache-control']).toBe('no-store')
    const paired = got.json()
    expect(paired).toMatchObject({ state: 'paired' })
    expect(paired.mac).toBe(pairServerMac(await pairKey(code, requestId, SALT), requestId, NONCE_E, paired.nonce))
    expect(app.pairing.store.findByToken(paired.token, 'extension')).toMatchObject({ id: paired.deviceId, origin: ORIGIN })
    expect((await collect(requestId)).json()).toEqual({ state: 'expired' })
    expect((await typeCode(requestId, code)).json()).toEqual({ state: 'expired' })
  })

  it('a wrong code is wrong twice, and refused the third time', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const code = await codeOf(requestId)
    const other = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
    expect((await typeCode(requestId, other)).json()).toEqual({ state: 'wrong' })
    expect((await typeCode(requestId, other)).json()).toEqual({ state: 'wrong' })
    expect((await typeCode(requestId, other)).json()).toEqual({ state: 'exhausted' })
    expect((await collect(requestId)).json()).toEqual({ state: 'refused' })
  })

  it('confirm checks the origin and the body', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    expect((await step(requestId, 'confirm', { nonce: NONCE_E, mac: SOME_MAC }, null)).statusCode).toBe(403)
    expect((await step(requestId, 'confirm', { nonce: NONCE_E, mac: SOME_MAC }, OTHER)).statusCode).toBe(403)
    for (const body of [{}, { nonce: NONCE_E }, { mac: SOME_MAC }, { nonce: 'short', mac: SOME_MAC }, { nonce: NONCE_E, mac: 'short' }, { nonce: NONCE_E, mac: SOME_MAC, extra: 1 }]) {
      expect((await step(requestId, 'confirm', body)).statusCode).toBe(400)
    }
    // None of those counted: three wrong codes are still allowed.
    expect((await step(requestId, 'confirm', { nonce: NONCE_E, mac: SOME_MAC })).json()).toEqual({ state: 'wrong' })
    expect((await step('not-a-uuid', 'confirm', { nonce: NONCE_E, mac: SOME_MAC })).json()).toEqual({ state: 'expired' })
    expect((await answer(requestId, 'refuse', { code: await codeOf(requestId) })).statusCode).toBe(200)
  })

  it('a GET on the extension routes never answers', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    for (const url of [`/api/companion/pair/${requestId}`, `/api/companion/pair/${requestId}/confirm`]) {
      for (const headers of [{ host: HOST, origin: ORIGIN }, { host: HOST, origin: ORIGIN, ...auth }]) {
        const res = await app.inject({ method: 'GET', url, headers })
        expect([401, 404, 405]).toContain(res.statusCode)
        expect(res.body).not.toMatch(/token/i)
      }
    }
    expect((await answer(requestId, 'refuse', { code: await codeOf(requestId) })).statusCode).toBe(200)
  })

  it('refuse answers refused, and an unknown request is 404 to refuse', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const code = await codeOf(requestId)
    const refused = await answer(requestId, 'refuse', { code })
    expect(refused.statusCode).toBe(200)
    expect((await collect(requestId)).json()).toEqual({ state: 'refused' })
    expect((await answer(requestId, 'refuse', { code })).statusCode).toBe(404)
    expect((await collect('not-a-uuid')).json()).toEqual({ state: 'expired' })
  })

  it('refuse with a missing or other code is 409, and changes nothing', async () => {
    const { requestId } = (await pair(ORIGIN)).json()
    const code = await codeOf(requestId)
    const other = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ'
    for (const body of [undefined, {}, { code: other }, { code: 7 }]) {
      const res = await answer(requestId, 'refuse', body)
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'the request changed: check the code' })
    }
    expect((await collect(requestId)).json()).toEqual({ state: 'pending' })
    expect((await answer(requestId, 'refuse', { code })).statusCode).toBe(200)
  })

  it('a refusal for a request its install replaced since is 409', async () => {
    const installId = randomUUID()
    const old = (await pair(ORIGIN, { name: 'Chrome', installId, salt: SALT })).json()
    const oldCode = await codeOf(old.requestId)
    const now = (await pair(ORIGIN, { name: 'Chrome', installId, salt: SALT })).json()
    expect(now.requestId).not.toBe(old.requestId)
    expect((await answer(old.requestId, 'refuse', { code: oldCode })).statusCode).toBe(409)
    expect((await collect(now.requestId)).json()).toEqual({ state: 'pending' })
    expect((await answer(now.requestId, 'refuse', { code: await codeOf(now.requestId) })).statusCode).toBe(200)
  })

  it('another install asking while a request waits is 409 busy', async () => {
    const waiting = (await pair(ORIGIN)).json()
    const res = await pair(OTHER)
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'another connection request is already waiting on the Edge', reason: 'busy' })
    expect((await answer(waiting.requestId, 'refuse', { code: await codeOf(waiting.requestId) })).statusCode).toBe(200)
  })

  it('an install refused a moment ago is 429 cooldown', async () => {
    const installId = randomUUID()
    const r = (await pair(ORIGIN, { name: 'Microsoft Edge', installId, salt: SALT })).json()
    expect((await answer(r.requestId, 'refuse', { code: await codeOf(r.requestId) })).statusCode).toBe(200)
    const res = await pair(ORIGIN, { name: 'Microsoft Edge', installId, salt: SALT })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'request refused: try again in a minute', reason: 'cooldown' })
  })

  it('a sixth request within a minute is 429', async () => {
    // Each one answered, so none is turned away as busy.
    let last = 200
    for (let i = 0; i < 6 && last === 200; i++) {
      const res = await pair(ORIGIN)
      last = res.statusCode
      if (last === 200) await answer(res.json().requestId, 'refuse', { code: await codeOf(res.json().requestId) })
    }
    expect(last).toBe(429)
    expect((await pair(ORIGIN)).json()).toMatchObject({ reason: 'limited' })
  })

  it('is 404 to a peer that is not loopback, even on the local listener', async () => {
    // Fails closed if the server is ever bound beyond 127.0.0.1: locality is isLocalRequest.
    const remoteAddress = '192.0.2.5'
    const asked = await app.inject({
      method: 'POST', url: '/api/companion/pair', remoteAddress,
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL, salt: SALT }),
    })
    expect(asked.statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/companion/pair/x', remoteAddress, headers: { host: HOST, origin: ORIGIN } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/companion/pair/x/confirm', remoteAddress, headers: { host: HOST, origin: ORIGIN } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/companion/requests/x/refuse', remoteAddress, headers: { host: HOST, ...auth }, payload: { code: 'AAAA' } })).statusCode).toBe(404)
  })

  it.skipIf(!hasOpenssl)('pair on the remote listener is 404', async () => {
    const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, ...auth }, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    const port = on.json().port as number
    const host = `example.local:${port}`
    // A Host the listener answers to, so the 404 is the route's and not the Host check's 421.
    app.pairing.setRemoteHosts(() => new Set([host]))
    const body = JSON.stringify({ name: 'Chrome', installId: INSTALL, salt: SALT })
    const res = await remote(port, { method: 'POST', path: '/api/companion/pair', host, headers: { 'content-type': 'application/json', origin: ORIGIN }, body })
    expect(res.status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/pair/x', host, headers: { origin: ORIGIN } })).status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/pair/x/confirm', host, headers: { origin: ORIGIN } })).status).toBe(404)
    expect((await remote(port, { method: 'POST', path: '/api/companion/requests/x/refuse', host })).status).toBe(404)
    const off = await app.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, ...auth }, payload: { enabled: false } })
    expect(off.statusCode).toBe(200)
  })
})
