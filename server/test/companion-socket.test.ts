import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import WebSocket from 'ws'
import { DeviceStore } from '../src/devices/store.js'
import { CompanionSession } from '../src/companion/session.js'
import { CompanionSockets, HELLO_TIMEOUT_MS, MAX_PENDING_PER_ORIGIN, MAX_PENDING_SOCKETS, TRY_AGAIN_LATER_CLOSE_CODE, companionSocket } from '../src/companion/socket.js'
import { PROOF_LABEL, PROTOCOL, proofMac } from '../src/companion/protocol.js'
import { MAX_WS_PAYLOAD_BYTES } from '../src/ws/hub.js'
import { buildApp } from '../src/app.js'
import { CONFIG_VERSION } from '../src/config/schema.js'
import { noAdvertise } from '../src/devices/bonjour.js'
import { generateToken } from '../src/http/access.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { hasOpenssl, upgrade } from './helpers/remote.js'

const ORIGIN = `chrome-extension://${'c'.repeat(32)}`
const OTHER = `chrome-extension://${'d'.repeat(32)}`
/** Sixteen ids the tests let in, as `FREMKIT_COMPANION_EXTENSION_IDS` would: a…a to p…p. */
const TEST_IDS = [...'abcdefghijklmnop'].map((c) => c.repeat(32))
const ORIGINS: ReadonlySet<string> = new Set(TEST_IDS.map((id) => `chrome-extension://${id}`))
/** A well-formed extension origin that is not let in. */
const STRANGER = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'
// For the app built below (`companionOrigins` reads it when the app is built).
process.env.FREMKIT_COMPANION_EXTENSION_IDS = TEST_IDS.join(',')
const INSTALL = '0b7d1c2e-4f5a-4b6c-8d7e-9f0a1b2c3d4e'
const INSTALL_2 = '1c8e2d3f-5a6b-4c7d-9e8f-0a1b2c3d4e5f'
const S1 = '11111111-1111-4111-8111-111111111111'
const META = { title: 'A video', host: 'video.example.com', currentTime: 1, duration: 60, paused: false, muted: false, volume: 1 }

let dir: string
let app: FastifyInstance
let store: DeviceStore
let session: CompanionSession
let port: number

interface Client {
  ws: WebSocket
  messages: unknown[]
  next: () => Promise<unknown>
  closed: Promise<{ code: number }>
  send: (msg: unknown) => void
}

function connect(origin: string | null = ORIGIN): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/companion/ws`, origin === null ? {} : { origin })
    const messages: unknown[] = []
    const waiting: Array<(m: unknown) => void> = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const waiter = waiting.shift()
      if (waiter) waiter(msg)
      else messages.push(msg)
    })
    const closed = new Promise<{ code: number }>((res) => ws.on('close', (code) => res({ code })))
    ws.on('error', () => undefined)
    ws.once('open', () => resolve({
      ws,
      messages,
      closed,
      next: () => messages.length > 0 ? Promise.resolve(messages.shift()) : new Promise((res) => waiting.push(res)),
      send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    }))
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)))
  })
}

async function paired(origin = ORIGIN, installId = INSTALL) {
  return store.createExtension({ name: 'Chrome', origin, installId })
}

const nonce = () => randomBytes(32).toString('base64url')

/** Bytes 0..31 as the token, 32..63 as the nonce. The same vector is in companion-extension-lib.test.ts. */
const PROOF_VECTOR = {
  token: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  nonce: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  mac: 'GBxF4yvVJMBOdFy_XX8CFPUkR962kYga-wTrWEAEOus',
}

/** What the extension expects back: the same computation as companion/lib/proof.js. */
function expectedMac(token: string, n: string): string {
  const key = createHash('sha256').update(token, 'utf8').digest()
  return createHmac('sha256', key).update(PROOF_LABEL + n, 'utf8').digest('base64url')
}

/** A connected extension that sent its challenge and checked the proof. */
async function proven(token: string, origin = ORIGIN): Promise<Client> {
  const deviceId = store.findByToken(token, 'extension')?.id
  if (!deviceId) throw new Error('no extension record for this token')
  const client = await connect(origin)
  const n = nonce()
  client.send({ type: 'challenge', deviceId, nonce: n })
  expect(await client.next()).toEqual({ type: 'proof', mac: expectedMac(token, n) })
  return client
}

/** A connected extension through the handshake: challenge, proof, hello, `ready`. */
async function hello(token: string, installId = INSTALL, origin = ORIGIN): Promise<Client> {
  const client = await proven(token, origin)
  client.send({ type: 'hello', token, installId, protocol: PROTOCOL })
  expect(await client.next()).toEqual({ type: 'ready', protocol: PROTOCOL, modules: { fremplay: true } })
  return client
}

describe('companion socket', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-companion-socket-'))
    store = new DeviceStore(join(dir, 'devices.json'))
    await store.load()
    const sockets = new CompanionSockets()
    session = new CompanionSession({
      send: (id, msg) => sockets.send(id, msg),
      changed: () => undefined,
      canShare: () => true,
      pairedCount: () => store.list().filter((d) => d.kind === 'extension').length,
    })
    app = Fastify()
    await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } })
    await app.register(companionSocket, { store, session, sockets, origins: ORIGINS, helloTimeoutMs: 200 })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as { port: number }).port
  })
  afterEach(async () => {
    await app.close()
    await store.settled()
    await rm(dir, { recursive: true, force: true })
  })

  it('waits 5 s for the handshake by default', () => {
    expect(HELLO_TIMEOUT_MS).toBe(5_000)
  })

  /** Replaces the test server by one whose handshake timeout is `helloTimeoutMs`. */
  async function restart(helloTimeoutMs: number): Promise<void> {
    await app.close()
    const sockets = new CompanionSockets()
    const quiet = new CompanionSession({ send: (id, msg) => sockets.send(id, msg), changed: () => undefined, canShare: () => true })
    app = Fastify()
    await app.register(fastifyWebsocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } })
    await app.register(companionSocket, { store, session: quiet, sockets, origins: ORIGINS, helloTimeoutMs })
    await app.listen({ port: 0, host: '127.0.0.1' })
    port = (app.server.address() as { port: number }).port
  }

  /** 'open' when a new socket from `origin` stays up for 50 ms, else the code it was closed with. */
  async function probe(origin = ORIGIN): Promise<number | 'open'> {
    const c = await connect(origin)
    const code = await Promise.race([c.closed.then((e) => e.code), new Promise<'open'>((r) => setTimeout(() => r('open'), 50))])
    c.ws.close()
    await c.closed
    return code
  }

  const extensionOrigin = (n: number) => `chrome-extension://${'abcdefghijklmnop'[n].repeat(32)}`

  it('caps sockets short of hello at 4 per extension origin, with 1013, and frees a slot on close', async () => {
    expect(MAX_PENDING_PER_ORIGIN).toBe(4)
    expect(TRY_AGAIN_LATER_CLOSE_CODE).toBe(1013)
    await restart(60_000)
    const { token } = await paired()
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    const fifth = await connect()
    expect(await fifth.closed).toEqual({ code: 1013 })
    expect(fifth.messages).toEqual([])
    // Another extension origin has slots of its own.
    expect(await probe(OTHER)).toBe('open')
    // One of them leaves: its slot is free again.
    waiting[0].ws.close()
    await waiting[0].closed
    await expect.poll(() => probe()).toBe('open')
    // A socket that finished hello no longer counts: the cap is on sockets that proved nothing.
    for (const c of waiting.slice(1)) c.ws.close()
    await Promise.all(waiting.slice(1).map((c) => c.closed))
    const done = await hello(token)
    const more = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    const over = await connect()
    expect(await over.closed).toEqual({ code: 1013 })
    for (const c of [done, ...more]) c.ws.close()
  })

  it('caps sockets short of hello at 32 in all', async () => {
    expect(MAX_PENDING_SOCKETS).toBe(32)
    await restart(60_000)
    const origins = MAX_PENDING_SOCKETS / MAX_PENDING_PER_ORIGIN
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_SOCKETS }, (_, i) => connect(extensionOrigin(i % origins))))
    // A ninth origin, with no socket of its own yet, still meets the global cap.
    const over = await connect(extensionOrigin(origins))
    expect(await over.closed).toEqual({ code: 1013 })
    for (const c of waiting) c.ws.close()
  })

  it('frees the slot of a socket refused for a bad message', async () => {
    await restart(60_000)
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    expect(await probe()).toBe(1013)
    waiting[0].send('not json')
    expect(await waiting[0].closed).toEqual({ code: 1008 })
    expect(await probe()).toBe('open')
    for (const c of waiting.slice(1)) c.ws.close()
  })

  it('frees the slot of a socket refused before or at its challenge', async () => {
    await restart(60_000)
    const { token } = await paired()
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    expect(await probe()).toBe(1013)
    // A version 1 extension says hello before any challenge: 1008, and its slot is free.
    waiting[0].send({ type: 'hello', token, installId: INSTALL, protocol: 1 })
    expect(await waiting[0].closed).toEqual({ code: 1008 })
    expect(await probe()).toBe('open')
    // A challenge for a record this server does not hold: 4401, and its slot is free too.
    const again = await connect()
    expect(await probe()).toBe(1013)
    again.send({ type: 'challenge', deviceId: '44444444-4444-4444-8444-444444444444', nonce: nonce() })
    expect(await again.closed).toEqual({ code: 4401 })
    expect(await probe()).toBe('open')
    for (const c of waiting.slice(1)) c.ws.close()
  })

  it('frees the slots of sockets closed by the hello timeout (200 ms here)', async () => {
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    for (const c of waiting) expect(await c.closed).toEqual({ code: 1008 })
    const again = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    // All four were let in: the fourth would have been 1013 had a timed-out slot stayed taken.
    for (const c of again) expect(await c.closed).toEqual({ code: 1008 })
  })

  it('answers 403 before the upgrade to anything that is not an extension', async () => {
    for (const origin of [null, 'http://127.0.0.1:4242', 'https://example.com', `chrome-extension://${'q'.repeat(32)}`, STRANGER]) {
      await expect(connect(origin), String(origin)).rejects.toThrow('status 403')
    }
    // Those never held a slot: a full set from the extension still fits.
    const waiting = await Promise.all(Array.from({ length: MAX_PENDING_PER_ORIGIN }, () => connect()))
    for (const c of waiting) c.ws.close()
  })

  it('no challenge within the timeout (200 ms here) closes 1008', async () => {
    const client = await connect()
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('a proof but no hello within the same timeout closes 1008', async () => {
    const { token } = await paired()
    const client = await proven(token)
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('proves the record with an HMAC of the nonce keyed by its token hash', async () => {
    const { token, device } = await paired()
    const client = await connect()
    const n = nonce()
    client.send({ type: 'challenge', deviceId: device.id, nonce: n })
    const proof = (await client.next()) as { type: string; mac: string }
    expect(proof).toEqual({ type: 'proof', mac: expectedMac(token, n) })
    // Another nonce, another mac: a recorded proof is worth nothing on the next socket.
    const again = await connect()
    again.send({ type: 'challenge', deviceId: device.id, nonce: nonce() })
    expect(((await again.next()) as { mac: string }).mac).not.toBe(proof.mac)
  })

  it('pins the proof to a fixed vector shared with the extension', () => {
    const key = createHash('sha256').update(PROOF_VECTOR.token, 'utf8').digest()
    expect(proofMac(key, PROOF_VECTOR.nonce)).toBe(PROOF_VECTOR.mac)
  })

  it('a challenge naming no extension record closes 4401, before any proof', async () => {
    const { device: ipad } = await store.create('iPad', { width: 1180, height: 820 }, null)
    const removed = await paired(ORIGIN, INSTALL_2)
    await store.remove(removed.device.id)
    for (const deviceId of ['22222222-2222-4222-8222-222222222222', ipad.id, removed.device.id]) {
      const client = await connect()
      client.send({ type: 'challenge', deviceId, nonce: nonce() })
      expect(await client.closed).toEqual({ code: 4401 })
      expect(client.messages).toEqual([])
    }
  })

  it('a challenge for a record of another origin closes 4401', async () => {
    const { device } = await paired()
    const client = await connect(OTHER)
    client.send({ type: 'challenge', deviceId: device.id, nonce: nonce() })
    expect(await client.closed).toEqual({ code: 4401 })
  })

  it('a malformed challenge closes 1008', async () => {
    const { device } = await paired()
    for (const bad of [
      { type: 'challenge', deviceId: device.id, nonce: 'short' },
      { type: 'challenge', deviceId: device.id, nonce: nonce() + 'A' },
      { type: 'challenge', deviceId: 'x', nonce: nonce() },
      { type: 'challenge', deviceId: device.id, nonce: nonce(), extra: 1 },
    ]) {
      const client = await connect()
      client.send(bad)
      expect(await client.closed).toEqual({ code: 1008 })
    }
  })

  it('hello before the challenge (a version 1 extension) closes 1008', async () => {
    const { token } = await paired()
    const client = await connect()
    client.send({ type: 'hello', token, installId: INSTALL, protocol: 1 })
    expect(await client.closed).toEqual({ code: 1008 })
    expect(client.messages).toEqual([])
  })

  it('a second challenge closes 1008, before hello or after', async () => {
    const { token, device } = await paired()
    const before = await proven(token)
    before.send({ type: 'challenge', deviceId: device.id, nonce: nonce() })
    expect(await before.closed).toEqual({ code: 1008 })
    const after = await hello(token)
    after.send({ type: 'challenge', deviceId: device.id, nonce: nonce() })
    expect(await after.closed).toEqual({ code: 1008 })
  })

  it('after the proof, a token that names no record closes 4401, a malformed one 1008', async () => {
    const { token } = await paired()
    const unknown = await proven(token)
    unknown.send({ type: 'hello', token: randomBytes(32).toString('base64url'), installId: INSTALL, protocol: PROTOCOL })
    expect(await unknown.closed).toEqual({ code: 4401 })
    const malformed = await proven(token)
    malformed.send({ type: 'hello', token: 'short', installId: INSTALL, protocol: PROTOCOL })
    expect(await malformed.closed).toEqual({ code: 1008 })
  })

  it('a hello with the token of another device than the challenge named closes 4401', async () => {
    const a = await paired(ORIGIN, INSTALL)
    const b = await paired(ORIGIN, INSTALL_2)
    const client = await proven(a.token)
    client.send({ type: 'hello', token: b.token, installId: INSTALL_2, protocol: PROTOCOL })
    expect(await client.closed).toEqual({ code: 4401 })
    const ipad = await store.create('iPad', { width: 1180, height: 820 }, null)
    const withIpad = await proven(a.token)
    withIpad.send({ type: 'hello', token: ipad.token, installId: INSTALL, protocol: PROTOCOL })
    expect(await withIpad.closed).toEqual({ code: 4401 })
  })

  it('a token from another installId closes 4401', async () => {
    const { token } = await paired()
    const otherInstall = await proven(token)
    otherInstall.send({ type: 'hello', token, installId: INSTALL_2, protocol: PROTOCOL })
    expect(await otherInstall.closed).toEqual({ code: 4401 })
  })

  it('a hello it cannot parse closes 1008, not 4401: the extension keeps its token', async () => {
    const { token } = await paired()
    const client = await proven(token)
    client.send({ type: 'hello', token, installId: INSTALL, protocol: '2' })
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('a hello with keys it does not know is still answered ready', async () => {
    const { token } = await paired()
    const client = await proven(token)
    client.send({ type: 'hello', token, installId: INSTALL, protocol: PROTOCOL, modules: ['fremplay'] })
    expect(await client.next()).toEqual({ type: 'ready', protocol: PROTOCOL, modules: { fremplay: true } })
  })

  it('a first message other than challenge closes 1008', async () => {
    const client = await connect()
    client.send({ type: 'tab.stopped', sessionId: S1 })
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('anything but hello after the proof closes 1008', async () => {
    const { token } = await paired()
    const client = await proven(token)
    client.send({ type: 'tab.stopped', sessionId: S1 })
    expect(await client.closed).toEqual({ code: 1008 })
  })

  it('hello is answered ready and marks the device seen', async () => {
    const { token, device } = await paired()
    await hello(token)
    await expect.poll(() => store.list().find((d) => d.id === device.id)?.lastSeen).not.toBeNull()
    expect(session.snapshot().extensions).toEqual({ connected: 1, paired: 1 })
  })

  it('anything after hello that is not a message, or a second hello, closes 1008', async () => {
    const { token } = await paired()
    const garbled = await hello(token)
    garbled.send('not json')
    expect(await garbled.closed).toEqual({ code: 1008 })
    const unknown = await hello(token)
    unknown.send({ type: 'tab.nonsense' })
    expect(await unknown.closed).toEqual({ code: 1008 })
    const twice = await hello(token)
    twice.send({ type: 'hello', token, installId: INSTALL, protocol: PROTOCOL })
    expect(await twice.closed).toEqual({ code: 1008 })
    await expect.poll(() => session.snapshot().extensions.connected).toBe(0)
  })

  it('an oversize message closes the socket before anything reads it', async () => {
    const { token } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.meta', sessionId: S1, meta: { ...META, title: 'x'.repeat(MAX_WS_PAYLOAD_BYTES) } })
    // `ws` enforces the cap itself, with the standard "message too big" code, before the route
    // could answer 1008: nothing of the message is buffered past 64 KiB.
    expect(await client.closed).toEqual({ code: 1009 })
  })

  it('carries a share: started is accepted, and the session hears its meta', async () => {
    const { token } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await client.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    expect(session.snapshot().tab).toMatchObject({ state: 'sharing', sessionId: S1, device: 'Chrome' })
    expect(session.control({ action: 'toggle' })).toBe(true)
    expect(await client.next()).toEqual({ type: 'tab.control', action: 'toggle' })
  })

  it('a refused offer costs only its receiver, with tab.refused, and keeps the socket open', async () => {
    const { token } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await client.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    const receiverId = '22222222-2222-4222-8222-222222222222'
    expect(session.view(receiverId, 'w1')).toBe(true)
    expect(await client.next()).toEqual({ type: 'tab.view', receiverId })
    client.send({ type: 'tab.offer', sessionId: S1, receiverId, sdp: 'v=0\r\na=candidate:1 1 udp 1 198.51.100.7 5000 typ host\r\n' })
    expect(await client.next()).toEqual({ type: 'tab.refused', sessionId: S1, reason: 'offer', receiverId })
    expect(session.snapshot().tab).toMatchObject({ state: 'sharing', sessionId: S1, offers: {} })
    // Still connected: a new share goes through on the same socket.
    client.send({ type: 'tab.started', sessionId: '33333333-3333-4333-8333-333333333333', meta: META })
    expect(await client.next()).toEqual({ type: 'tab.accepted', sessionId: '33333333-3333-4333-8333-333333333333' })
  })

  it('a second socket for the same record replaces the first', async () => {
    const { token } = await paired()
    const first = await hello(token)
    const second = await hello(token)
    expect((await first.closed).code).toBe(1000)
    expect(session.snapshot().extensions.connected).toBe(1)
    second.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await second.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
  })

  it('revoking the device sends revoked and closes 4401', async () => {
    const { token, device } = await paired()
    const client = await hello(token)
    await store.remove(device.id)
    expect(await client.next()).toEqual({ type: 'revoked' })
    expect(await client.closed).toEqual({ code: 4401 })
    expect(session.snapshot().extensions.connected).toBe(0)
  })

  it('revoking one extension leaves another\'s share running', async () => {
    const a = await paired(ORIGIN, INSTALL)
    const b = await paired(ORIGIN, INSTALL_2)
    const sharing = await hello(a.token, INSTALL)
    const other = await hello(b.token, INSTALL_2)
    sharing.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await sharing.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    await store.remove(b.device.id)
    expect(await other.closed).toEqual({ code: 4401 })
    expect(session.snapshot()).toMatchObject({ extensions: { connected: 1, paired: 1 }, tab: { state: 'sharing', sessionId: S1 } })
    expect(sharing.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('revoking the sharing extension ends its share', async () => {
    const { token, device } = await paired()
    const client = await hello(token)
    client.send({ type: 'tab.started', sessionId: S1, meta: META })
    expect(await client.next()).toEqual({ type: 'tab.accepted', sessionId: S1 })
    await store.remove(device.id)
    expect(await client.closed).toEqual({ code: 4401 })
    expect(session.snapshot().tab.state).toBe('idle')
  })
})

describe('companion socket in the app', () => {
  const SECRET = generateToken()
  const HOST = '127.0.0.1:4242'
  const exec: Exec = (cmd, args) =>
    cmd === 'scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args)
  let appDir: string
  let full: FastifyInstance

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), 'fremkit-companion-socket-app-'))
    await writeFile(join(appDir, 'fremkit.json'), JSON.stringify({
      version: CONFIG_VERSION,
      locale: 'en',
      secrets: { backend: 'file' },
      connections: [],
      widgets: {},
      screens: [{ id: 'edge', name: 'edge', kind: 'edge', display: { cols: 30, rows: 20 }, pages: [{ id: 'home', name: 'Home', items: [] }] }],
    }))
    full = await buildApp({
      accessToken: SECRET,
      port: 4242,
      dataDir: appDir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => ['192.0.2.10'] },
    })
  })
  afterEach(async () => {
    await full?.close()
    await full?.pairing.store.settled()
    await rm(appDir, { recursive: true, force: true })
  })

  it('opens without the access secret, then waits for hello and closes 1008 without one', async () => {
    await full.listen({ port: 0, host: '127.0.0.1' })
    const listening = (full.server.address() as { port: number }).port
    // The app checks the Host against the port it was built for, whatever it listens on here.
    const ws = new WebSocket(`ws://127.0.0.1:${listening}/companion/ws`, { origin: ORIGIN, headers: { host: HOST } })
    const refused = new Promise<number>((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    const opened = new Promise<'open'>((resolve) => ws.once('open', () => resolve('open')))
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    ws.on('error', () => undefined)
    expect(await Promise.race([opened, refused])).toBe('open')
    expect(await closed).toBe(1008)
  }, 10_000)

  it('goes through the handshake without the access secret: challenge, proof, hello, ready', async () => {
    await full.listen({ port: 0, host: '127.0.0.1' })
    const listening = (full.server.address() as { port: number }).port
    const { token, device } = await full.pairing.store.createExtension({ name: 'Chrome', origin: ORIGIN, installId: INSTALL })
    const ws = new WebSocket(`ws://127.0.0.1:${listening}/companion/ws`, { origin: ORIGIN, headers: { host: HOST } })
    const received: unknown[] = []
    const waiting: Array<(m: unknown) => void> = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      const waiter = waiting.shift()
      if (waiter) waiter(msg)
      else received.push(msg)
    })
    const next = () => received.length > 0 ? Promise.resolve(received.shift()) : new Promise((res) => waiting.push(res))
    ws.on('error', () => undefined)
    await new Promise((resolve) => ws.once('open', resolve))
    const n = nonce()
    ws.send(JSON.stringify({ type: 'challenge', deviceId: device.id, nonce: n }))
    expect(await next()).toEqual({ type: 'proof', mac: expectedMac(token, n) })
    ws.send(JSON.stringify({ type: 'hello', token, installId: INSTALL, protocol: PROTOCOL }))
    expect(await next()).toEqual({ type: 'ready', protocol: PROTOCOL, modules: { fremplay: false } })
    ws.close()
  }, 10_000)

  it('still checks the Host', async () => {
    const wsHeaders = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: ORIGIN }
    const wrongHost = await full.inject({ method: 'GET', url: '/companion/ws', headers: { ...wsHeaders, host: 'evil.example.com' } })
    expect(wrongHost.statusCode).toBe(421)
  })

  it('answers 403 to the upgrade of an extension that is not Companion nor listed', async () => {
    const wsHeaders = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    const res = await full.inject({ method: 'GET', url: '/companion/ws', headers: { ...wsHeaders, host: HOST, origin: STRANGER } })
    expect(res.statusCode).toBe(403)
  })

  it('is 404 to a peer that is not loopback, even on the local listener', async () => {
    const wsHeaders = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', origin: ORIGIN }
    const res = await full.inject({ method: 'GET', url: '/companion/ws', remoteAddress: '192.0.2.5', headers: { ...wsHeaders, host: HOST } })
    expect(res.statusCode).toBe(404)
  })

  it.skipIf(!hasOpenssl)('the companion socket is 404 on the remote listener', async () => {
    const on = await full.inject({ method: 'PUT', url: '/api/devices/settings', headers: { host: HOST, authorization: `Bearer ${SECRET}` }, payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    const remotePort = on.json().port as number
    // A Host the listener answers to, so the 404 is the route's and not the Host check's 421.
    full.pairing.setRemoteHosts(() => new Set([`example.local:${remotePort}`]))
    const res = await upgrade(remotePort, { origin: ORIGIN }, `example.local:${remotePort}`, '/companion/ws')
    expect(res.status).toBe(404)
  })
})
