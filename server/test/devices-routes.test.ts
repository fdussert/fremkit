import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { pairClientMac, pairKey } from '../src/companion/pairProof.js'
import { CONFIG_VERSION, ConfigSchema } from '../src/config/schema.js'
import { BrightnessService } from '../src/brightness/service.js'
import { noAdvertise, type Advertiser } from '../src/devices/bonjour.js'
import { RemoteListener } from '../src/devices/listener.js'
import { fingerprintWords } from '../src/devices/fingerprint.js'
import { execFileAsync, type Exec } from '../src/secrets/keychain.js'
import { Hub } from '../src/ws/hub.js'
import { DeviceStore } from '../src/devices/store.js'
import { DeviceService } from '../src/devices/service.js'
import { readZip } from '../src/backup/zip.js'
import { readKey, spkiHash, TLS_KEY_SECRET } from '../src/devices/certificate.js'
import { FileSecretStore } from '../src/secrets/file.js'
import { MAX_WRONG_PER_MINUTE, PairingCodes } from '../src/devices/codes.js'
import { codeProof } from '../src/devices/codeProof.js'
import { hasOpenssl, remote } from './helpers/remote.js'

const ADDRESS = '192.0.2.10'

/** `scutil` answers a fixed name; `openssl` is the real one. */
const exec: Exec = (cmd, args) =>
  cmd === '/usr/sbin/scutil' ? Promise.resolve({ stdout: 'example\n' }) : execFileAsync(cmd, args)

const screen = (id: string, kind: 'edge' | 'device', viewport?: { width: number; height: number }) => ({
  id, name: id, kind,
  display: { cols: 30, rows: 20, ...(viewport ? { viewport } : {}) },
  pages: [{ id: 'home', name: 'Home', items: [] }],
})

const CONFIG = {
  version: CONFIG_VERSION,
  locale: 'en',
  labs: { devices: false, companion: true },
  secrets: { backend: 'file' },
  connections: [],
  widgets: {},
  screens: [
    screen('edge', 'edge'),
    screen('ipad', 'device', { width: 1180, height: 820 }),
    screen('tab-a', 'device', { width: 1024, height: 768 }),
    screen('tab-b', 'device', { width: 768, height: 1024 }),
  ],
}

let dir: string
let brightness: BrightnessService
let app: FastifyInstance
let port: number

const host = () => `example.local:${port}`
const cookie = (t: string) => ({ cookie: `fremkit_device=${t}` })
const json = { 'content-type': 'application/json' }

async function issueOffer(): Promise<{ code: string; secret: string; keyHash: string; url: string }> {
  const res = await app.inject({ method: 'POST', url: '/api/devices/code' })
  expect(res.statusCode).toBe(200)
  const offer = res.json()
  const params = new URL(offer.url).searchParams
  return { ...offer, secret: params.get('s') as string, keyHash: params.get('k') as string }
}

async function issueCode(): Promise<string> {
  return (await issueOffer()).code
}

/** What the iPad sends for a typed code: its proof for the key it is talking to. */
function typed(code: string, keyHash: string): { proof: string } {
  return { proof: codeProof(code, keyHash) }
}

function pair(body: unknown) {
  return remote(port, { method: 'POST', path: '/api/pair', host: host(), headers: json, body: JSON.stringify(body) })
}

async function pairWith(viewport: { width: number; height: number }, name = 'iPad'): Promise<{ token: string; deviceId: string }> {
  const { code, keyHash } = await issueOffer()
  const res = await pair({ ...typed(code, keyHash), name, viewport })
  expect(res.status).toBe(200)
  return JSON.parse(res.body)
}

async function me(token: string) {
  return remote(port, { path: '/api/devices/me?id=someone-else', host: host(), headers: cookie(token) })
}

describe.skipIf(!hasOpenssl)('device routes', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fremkit-devices-'))
    await writeFile(join(dir, 'fremkit.json'), JSON.stringify(CONFIG))
    brightness = new BrightnessService({ config: () => ConfigSchema.parse(CONFIG) })
    app = await buildApp({
      accessToken: null,
      dataDir: dir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      brightness,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS] },
    })
    const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toMatchObject({ enabled: true, listening: true, error: null })
    port = on.json().port
    expect(port).toBeGreaterThan(0)
  })
  afterAll(async () => {
    await app?.close()
    await app?.pairing.store.settled()
    await rm(dir, { recursive: true, force: true })
  })

  it('offers a code and a QR payload carrying the pin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/devices/code' })
    const offer = res.json()
    expect(offer.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    const status = (await app.inject({ url: '/api/devices' })).json()
    const secret = new URL(offer.url).searchParams.get('s')
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(offer.url).toBe(`fremkit://pair?h=example.local&a=${ADDRESS}&p=${port}&c=${offer.code}&s=${secret}&k=${status.keyHash}`)
    // The secret is in the link and nowhere else: no field of its own, not in the status.
    expect(Object.keys(offer).sort()).toEqual(['code', 'expiresAt', 'url'])
    expect(res.headers['cache-control']).toBe('no-store')
    expect(JSON.stringify(status)).not.toContain(secret)
    const settings = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    expect(settings.body).not.toContain(secret)
    expect(status.keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(status.fingerprint).toEqual(fingerprintWords(status.keyHash))
    expect(status.fingerprint).toHaveLength(4)
  })

  it('pairs a device and tells it its screen', async () => {
    const { token, deviceId } = await pairWith({ width: 1180, height: 820 })
    const res = await me(token)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: deviceId, name: 'iPad', screenId: 'ipad', brightness: { target: null, seq: 0 } })
  })

  it('attaches by viewport in either orientation, and only when one screen fits', async () => {
    const rotated = await pairWith({ width: 820, height: 1180 })
    expect(JSON.parse((await me(rotated.token)).body).screenId).toBe('ipad')
    // 1024 × 768 fits both tab-a and tab-b (rotated): ambiguous, left for the user.
    const two = await pairWith({ width: 1024, height: 768 })
    expect(JSON.parse((await me(two.token)).body).screenId).toBeNull()
    const none = await pairWith({ width: 640, height: 480 })
    expect(JSON.parse((await me(none.token)).body).screenId).toBeNull()
  })

  it('validates the pairing body', async () => {
    await issueCode()
    const proof = 'A'.repeat(43)
    expect((await pair({ proof, name: '', viewport: { width: 1, height: 1 } })).status).toBe(400)
    expect((await pair({ proof, name: 'x'.repeat(61), viewport: { width: 1, height: 1 } })).status).toBe(400)
    expect((await pair({ proof, name: 'x', viewport: { width: 0, height: 1 } })).status).toBe(400)
    const viewport = { width: 640, height: 480 }
    // Neither, both, or a secret or a proof of the wrong shape.
    expect((await pair({ name: 'x', viewport })).status).toBe(400)
    expect((await pair({ proof, secret: 'A'.repeat(43), name: 'x', viewport })).status).toBe(400)
    expect((await pair({ proof: 'A'.repeat(42), name: 'x', viewport })).status).toBe(400)
    expect((await pair({ secret: 'A'.repeat(42), name: 'x', viewport })).status).toBe(400)
    expect((await pair({ secret: 'A'.repeat(44), name: 'x', viewport })).status).toBe(400)
    expect((await pair({ secret: `${'A'.repeat(42)}=`, name: 'x', viewport })).status).toBe(400)
  })

  it('answers /api/pair 404, as a route that does not exist, while no code is live', async () => {
    // The code `pairWith` used is spent: nothing is live now.
    await pairWith({ width: 640, height: 480 })
    const body = { proof: 'A'.repeat(43), name: 'x', viewport: { width: 640, height: 480 } }
    const closed = await pair(body)
    expect(closed.status).toBe(404)
    expect(JSON.parse(closed.body)).toMatchObject({ statusCode: 404, error: 'Not Found' })
    // Nor are guesses counted while it is closed.
    for (let i = 0; i < 6; i++) expect((await pair(body)).status).toBe(404)
    const { code, keyHash } = await issueOffer()
    expect((await pair({ ...body, ...typed(code, keyHash) })).status).toBe(200)
    expect((await pair(body)).status).toBe(404)
  })

  it('refuses to attach a device to a screen that is not a device screen', async () => {
    const { deviceId } = await pairWith({ width: 640, height: 480 })
    const edge = await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { screenId: 'edge' } })
    expect(edge.statusCode).toBe(400)
    expect(edge.json().errors).toEqual(['this screen does not exist or is not a device screen'])
    const ok = await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { screenId: 'tab-a', name: 'Kitchen' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ id: deviceId, screenId: 'tab-a', name: 'Kitchen' })
    expect((await app.inject({ method: 'PATCH', url: '/api/devices/nope', payload: { name: 'x' } })).statusCode).toBe(404)
    expect((await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { name: '' } })).statusCode).toBe(400)
  })

  it('detaches devices whose screen is saved away', async () => {
    const { token } = await pairWith({ width: 1180, height: 820 })
    expect(JSON.parse((await me(token)).body).screenId).toBe('ipad')
    const current = (await app.inject({ url: '/api/config' })).json()
    const saved = await app.inject({
      method: 'PUT', url: '/api/config',
      payload: { ...current, screens: current.screens.filter((s: { id: string }) => s.id !== 'ipad') },
    })
    expect(saved.statusCode).toBe(200)
    await expect.poll(async () => JSON.parse((await me(token)).body).screenId).toBeNull()
  })

  it('lists devices without a token hash or the key', async () => {
    const res = await app.inject({ url: '/api/devices' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.devices.length).toBeGreaterThan(0)
    expect(res.body).not.toContain('tokenHash')
    expect(res.body).not.toContain('PRIVATE KEY')
    expect(body).toMatchObject({ host: 'example.local', addresses: [ADDRESS], port, guessing: false })
  })

  it('revokes a device: its token stops working', async () => {
    const { token, deviceId } = await pairWith({ width: 640, height: 480 })
    const closeDevice = vi.spyOn(Hub.prototype, 'closeDevice')
    try {
      expect((await me(token)).status).toBe(200)
      expect((await app.inject({ method: 'DELETE', url: `/api/devices/${deviceId}` })).statusCode).toBe(204)
      expect((await me(token)).status).toBe(401)
      expect(closeDevice).toHaveBeenCalledWith(deviceId)
      expect((await app.inject({ method: 'DELETE', url: `/api/devices/${deviceId}` })).statusCode).toBe(404)
    } finally {
      closeDevice.mockRestore()
    }
  })

  it('answers each audience only where it belongs', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/pair', payload: { proof: 'A'.repeat(43), name: 'x', viewport: { width: 1, height: 1 } } })).statusCode).toBe(404)
    expect((await app.inject({ url: '/api/devices/me' })).statusCode).toBe(404)
    const { token } = await pairWith({ width: 640, height: 480 })
    for (const [method, path] of [
      ['GET', '/api/devices'], ['POST', '/api/devices/code'], ['PUT', '/api/devices/settings'],
      ['DELETE', '/api/devices'], ['POST', '/api/devices/reset-certificate'],
    ]) {
      const body = method === 'GET' || method === 'DELETE' ? {} : { headers: { ...cookie(token), ...json }, body: '{}' }
      const res = await remote(port, { method, path, host: host(), headers: cookie(token), ...body })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('keeps devices out of the backup', async () => {
    const res = await app.inject({ url: '/api/backup' })
    expect(res.statusCode).toBe(200)
    const entries = readZip(Buffer.from(res.rawPayload))
    expect(entries.map((e) => e.name).some((n) => n.includes('devices'))).toBe(false)
    expect(Buffer.concat(entries.map((e) => e.data)).toString('utf8')).not.toContain('tokenHash')
  })

  it('keeps the TLS key, in either form, out of the backup and the config', async () => {
    const secrets = new FileSecretStore(join(dir, 'secrets.json'))
    const stored = await secrets.get(TLS_KEY_SECRET)
    const pem = await readKey(secrets)
    expect(stored).toMatch(/^[A-Za-z0-9+/=]{40,}$/)
    expect(pem).toContain('PRIVATE KEY')
    // The PEM's body lines, the one-line stored form, and pieces of it long enough to mean it.
    const pemLines = pem!.split('\n').filter((l) => l.length > 0 && !l.startsWith('-----'))
    const needles = [stored!, stored!.slice(0, 32), stored!.slice(-32), ...pemLines, 'PRIVATE KEY', TLS_KEY_SECRET]

    const backup = await app.inject({ url: '/api/backup' })
    expect(backup.statusCode).toBe(200)
    const entries = readZip(Buffer.from(backup.rawPayload))
    const texts = [...entries.map((e) => e.data.toString('utf8')), ...entries.map((e) => e.data.toString('base64'))]
    const config = await app.inject({ url: '/api/config' })
    expect(config.statusCode).toBe(200)
    const { token } = await pairWith({ width: 640, height: 480 })
    const remoteConfig = await remote(port, { path: '/api/config', host: host(), headers: cookie(token) })
    expect(remoteConfig.status).toBe(200)
    for (const text of [...texts, config.body, remoteConfig.body]) {
      for (const needle of needles) expect(text.includes(needle), needle.slice(0, 12)).toBe(false)
    }
  })

  it('answers /me with the asking device only', async () => {
    const a = await pairWith({ width: 640, height: 480 }, 'Kitchen')
    const b = await pairWith({ width: 640, height: 480 }, 'Hall')
    expect((await app.inject({ method: 'PATCH', url: `/api/devices/${b.deviceId}`, payload: { screenId: 'tab-a' } })).statusCode).toBe(200)
    const meA = JSON.parse((await me(a.token)).body)
    const meB = JSON.parse((await me(b.token)).body)
    expect(meA).toEqual({ id: a.deviceId, name: 'Kitchen', screenId: null, brightness: null })
    expect(meB).toEqual({ id: b.deviceId, name: 'Hall', screenId: 'tab-a', brightness: { target: null, seq: 0 } })
    // Whatever the query asks for.
    const asked = await remote(port, { path: `/api/devices/me?id=${b.deviceId}`, host: host(), headers: cookie(a.token) })
    expect(JSON.parse(asked.body).id).toBe(a.deviceId)
  })

  describe('brightness', () => {
    const report = (token: string | null, body: unknown, method = 'POST') =>
      remote(port, { method, path: '/api/devices/me/brightness', host: host(), headers: { ...(token ? cookie(token) : {}), ...json }, body: JSON.stringify(body) })
    const value = (screen: string) => brightness.snapshot().screens[screen]

    const attach = async (deviceId: string, screenId: string) =>
      expect((await app.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, payload: { screenId } })).statusCode).toBe(200)

    it('takes a level from the device for its own screen, and from no other device', async () => {
      const a = await pairWith({ width: 640, height: 480 }, 'A')
      const b = await pairWith({ width: 640, height: 480 }, 'B')
      await attach(a.deviceId, 'tab-a')
      await attach(b.deviceId, 'tab-b')
      const res = await report(a.token, { value: 42 })
      expect(res.status).toBe(204)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(value('tab-a')).toMatchObject({ available: true, value: 42 })
      expect(value('tab-b')).toMatchObject({ available: false, reason: 'no-device' })
      expect((await report(b.token, { value: 10 })).status).toBe(204)
      expect(value('tab-a').value).toBe(42)
      expect(value('tab-b').value).toBe(10)
    })

    it('needs the token, and is not answered on this Mac', async () => {
      expect((await report(null, { value: 5 })).status).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/api/devices/me/brightness', payload: { value: 5 } })).statusCode).toBe(404)
    })

    it('refuses a bad level, and a device with no device screen', async () => {
      const a = await pairWith({ width: 640, height: 480 }, 'A')
      await attach(a.deviceId, 'tab-a')
      expect((await report(a.token, { value: 101 })).status).toBe(400)
      expect((await report(a.token, { value: 'x' })).status).toBe(400)
      const none = await pairWith({ width: 640, height: 480 }, 'None')
      const res = await report(none.token, { value: 50 })
      expect(res.status).toBe(409)
      expect(JSON.parse(res.body).error).toEqual(expect.any(String))
    })

    it('reads the screen at request time: a device moved to another screen reports for that one', async () => {
      const a = await pairWith({ width: 640, height: 480 }, 'Mover')
      expect((await app.inject({ method: 'PATCH', url: `/api/devices/${a.deviceId}`, payload: { screenId: 'tab-b' } })).statusCode).toBe(200)
      expect((await report(a.token, { value: 33 })).status).toBe(204)
      expect(value('tab-b').value).toBe(33)
    })

    it('puts the new target and seq on the device channel when the admin side sets one', async () => {
      const a = await pairWith({ width: 640, height: 480 }, 'Pushed')
      expect((await app.inject({ method: 'PATCH', url: `/api/devices/${a.deviceId}`, payload: { screenId: 'tab-a' } })).statusCode).toBe(200)
      expect((await report(a.token, { value: 20 })).status).toBe(204)
      const refresh = vi.spyOn(Hub.prototype, 'refreshDevice')
      try {
        const before = JSON.parse((await me(a.token)).body).brightness.seq as number
        brightness.set('tab-a', 55)
        expect(refresh).toHaveBeenCalledWith(a.deviceId)
        const after = JSON.parse((await me(a.token)).body).brightness
        expect(after.target).toBe(55)
        expect(after.seq).toBeGreaterThan(before)
      } finally {
        refresh.mockRestore()
      }
    })
  })

  it('resetting the certificate changes the pin and unpairs every device', async () => {
    const { token, deviceId } = await pairWith({ width: 640, height: 480 })
    const before = (await app.inject({ url: '/api/devices' })).json().keyHash as string
    const closeDevice = vi.spyOn(Hub.prototype, 'closeDevice')
    const closeRemote = vi.spyOn(Hub.prototype, 'closeRemote')
    const drop = vi.spyOn(RemoteListener.prototype, 'dropConnections')
    try {
      const res = await app.inject({ method: 'POST', url: '/api/devices/reset-certificate' })
      expect(res.statusCode).toBe(200)
      expect(res.json().keyHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(res.json().keyHash).not.toBe(before)
      expect(res.json().devices).toEqual([])
      expect(res.json().listening).toBe(true)
      expect((await me(token)).status).toBe(401)
      expect(closeDevice).toHaveBeenCalledWith(deviceId)
      expect(closeRemote).toHaveBeenCalled()
      // No keep-alive connection is left talking over the old key.
      expect(drop).toHaveBeenCalledTimes(1)
    } finally {
      closeDevice.mockRestore()
      closeRemote.mockRestore()
      drop.mockRestore()
    }
  })

  it('pairs with the QR secret, once', async () => {
    const { secret } = await issueOffer()
    const viewport = { width: 1180, height: 820 }
    const res = await pair({ secret, name: 'iPad', viewport })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const { token } = JSON.parse(res.body)
    expect((await me(token)).status).toBe(200)
    // Spent with its code: nothing is live, so the route is not there at all.
    expect((await pair({ secret, name: 'iPad', viewport })).status).toBe(404)
  })

  /** Blocks the next read of the TLS key until `release()`: `pairingCode` waits there before issuing. */
  function holdKeyRead(): { reached: Promise<void>; release: () => void; restore: () => void } {
    let reach!: () => void
    let release!: () => void
    const reached = new Promise<void>((r) => { reach = r })
    const gate = new Promise<void>((r) => { release = r })
    const original = FileSecretStore.prototype.get
    let armed = true
    const spy = vi.spyOn(FileSecretStore.prototype, 'get').mockImplementation(async function (this: FileSecretStore, name: string) {
      if (armed && name === TLS_KEY_SECRET) {
        armed = false
        reach()
        await gate
      }
      return original.call(this, name)
    })
    return { reached, release, restore: () => spy.mockRestore() }
  }

  async function settle(): Promise<void> {
    await new Promise((r) => setTimeout(r, 50))
  }

  /** Records `issue` and `clear` on the codes, in order: no `issue` may come after the last `clear`. */
  function recordCodes(): { calls: string[]; restore: () => void } {
    const calls: string[] = []
    const { issue: realIssue, clear: realClear } = PairingCodes.prototype
    const issue = vi.spyOn(PairingCodes.prototype, 'issue').mockImplementation(function (this: PairingCodes) {
      calls.push('issue')
      return realIssue.call(this)
    })
    const clear = vi.spyOn(PairingCodes.prototype, 'clear').mockImplementation(function (this: PairingCodes) {
      calls.push('clear')
      realClear.call(this)
    })
    return { calls, restore: () => { issue.mockRestore(); clear.mockRestore() } }
  }

  it('never leaves a code live from a request that raced the switch going off', async () => {
    const hold = holdKeyRead()
    const codes = recordCodes()
    try {
      const code = app.inject({ method: 'POST', url: '/api/devices/code' })
      await hold.reached
      const off = app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      // Unserialized, the switch would go off here, and the code be issued after it.
      await settle()
      hold.release()
      expect([200, 409]).toContain((await code).statusCode)
      expect((await off).statusCode).toBe(200)
      // Issued before the switch-off dropped it, or not at all: never after.
      expect(codes.calls.lastIndexOf('issue')).toBeLessThan(codes.calls.lastIndexOf('clear'))
    } finally {
      hold.restore()
      codes.restore()
    }
    const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    expect(on.statusCode).toBe(200)
    port = on.json().port
    // No code is live: the route is not there.
    expect((await pair({ proof: 'A'.repeat(43), name: 'x', viewport: { width: 640, height: 480 } })).status).toBe(404)
  })

  it('never issues a code carrying the old pin from a request that raced a certificate reset', async () => {
    const hold = holdKeyRead()
    const codes = recordCodes()
    let offer: { statusCode: number; json: () => { url: string } }
    try {
      const code = app.inject({ method: 'POST', url: '/api/devices/code' })
      await hold.reached
      const reset = app.inject({ method: 'POST', url: '/api/devices/reset-certificate' })
      await settle()
      hold.release()
      offer = await code
      expect((await reset).statusCode).toBe(200)
      expect(codes.calls.lastIndexOf('issue')).toBeLessThan(codes.calls.lastIndexOf('clear'))
    } finally {
      hold.restore()
      codes.restore()
    }
    expect(offer.statusCode).toBe(200)
    // Issued before the reset, so dropped by it: nothing is live, its secret pairs nothing.
    const secret = new URL(offer.json().url).searchParams.get('s')
    expect((await pair({ secret, name: 'x', viewport: { width: 640, height: 480 } })).status).toBe(404)
  })

  it('kills a live code and its secret when pairing is switched off', async () => {
    const { secret } = await issueOffer()
    const clear = vi.spyOn(PairingCodes.prototype, 'clear')
    try {
      const off = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      expect(off.statusCode).toBe(200)
      expect(clear).toHaveBeenCalled()
      clear.mockClear()
      const on = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
      expect(on.statusCode).toBe(200)
      port = on.json().port
    } finally {
      clear.mockRestore()
    }
    // Back on, no code is live (the route is not there), and the old secret pairs nothing.
    expect((await pair({ secret, name: 'x', viewport: { width: 640, height: 480 } })).status).toBe(404)
  })

  it('kills a live code and its secret when the certificate is reset', async () => {
    const { secret } = await issueOffer()
    const clear = vi.spyOn(PairingCodes.prototype, 'clear')
    try {
      expect((await app.inject({ method: 'POST', url: '/api/devices/reset-certificate' })).statusCode).toBe(200)
      expect(clear).toHaveBeenCalled()
    } finally {
      clear.mockRestore()
    }
    expect((await pair({ secret, name: 'x', viewport: { width: 640, height: 480 } })).status).toBe(404)
  })

  it('refuses every code after five wrong ones in a minute, a wrong secret counted as one', async () => {
    const stale = (await issueOffer()).secret
    const { code, keyHash } = await issueOffer()
    const wrong = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
    const viewport = { width: 640, height: 480 }
    for (let i = 0; i < 4; i++) {
      const res = await pair({ ...typed(wrong, keyHash), name: 'x', viewport })
      expect(res.status).toBe(403)
      expect(JSON.parse(res.body).error).toBe('wrong pairing code')
    }
    // The secret of a code replaced since: dead, and failing exactly as a wrong code does.
    const res = await pair({ secret: stale, name: 'x', viewport })
    expect(res.status).toBe(403)
    expect(res.body).toBe(JSON.stringify({ error: 'wrong pairing code' }))
    expect(res.body).not.toContain(stale)
    const limited = await pair({ ...typed(code, keyHash), name: 'x', viewport })
    expect(limited.status).toBe(429)
    expect(JSON.parse(limited.body).error).toBe('too many wrong codes: try again in a minute')
    expect((await app.inject({ url: '/api/devices' })).json().guessing).toBe(true)
  })

  it('pairs with the QR secret while this peer is refused codes', async () => {
    // A fresh minute, whatever the tests above spent: this one spends the allowance itself.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 })
    try {
      const { code, secret, keyHash } = await issueOffer()
      const wrongCode = code === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'
      const viewport = { width: 640, height: 480 }
      for (let i = 0; i < MAX_WRONG_PER_MINUTE; i++) {
        expect((await pair({ ...typed(wrongCode, keyHash), name: 'x', viewport })).status).toBe(403)
      }
      expect((await pair({ ...typed(code, keyHash), name: 'x', viewport })).status).toBe(429)
      const wrong = await pair({ secret: secret.startsWith('A') ? 'B'.repeat(43) : 'A'.repeat(43), name: 'x', viewport })
      expect(wrong.status).toBe(429)
      expect(JSON.parse(wrong.body).error).toBe('too many wrong codes: try again in a minute')
      const res = await pair({ secret, name: 'QR', viewport })
      expect(res.status).toBe(200)
      expect((await me(JSON.parse(res.body).token)).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a typed code only as its proof for this Mac key, so a relayed proof for another key does not pair', async () => {
    // A minute past the QR test's own, so the wrong code spent here is counted on its own.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 3 * 61_000 })
    try {
      const { code, keyHash } = await issueOffer()
      const viewport = { width: 640, height: 480 }
      // The old form, the code itself, is not a pairing body any more.
      expect((await pair({ code, name: 'x', viewport })).status).toBe(400)
      // An impostor showed the iPad its own key: the proof is for that key, and is a wrong code here.
      const impostor = 'n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg'
      const relayed = await pair({ ...typed(code, impostor), name: 'x', viewport })
      expect(relayed.status).toBe(403)
      expect(relayed.body).not.toContain(code)
      // The same code, bound to this Mac's key, pairs.
      expect((await pair({ ...typed(code, keyHash), name: 'x', viewport })).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })

  // Last: it turns remote access off.
  it('turning it off stops the listener and closes every paired socket', async () => {
    const closeRemote = vi.spyOn(Hub.prototype, 'closeRemote')
    try {
      const off = await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      expect(off.statusCode).toBe(200)
      expect(off.json()).toMatchObject({ enabled: false, listening: false })
      expect(closeRemote).toHaveBeenCalled()
      await expect(remote(port, { path: '/', host: host() })).rejects.toThrow()
      expect((await app.inject({ method: 'POST', url: '/api/devices/code' })).statusCode).toBe(409)
      expect((await app.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: 'yes' } })).statusCode).toBe(400)
    } finally {
      closeRemote.mockRestore()
    }
  })
})

describe.skipIf(!hasOpenssl)('a remote port already taken', () => {
  let taken: Server
  let tdir: string
  let tapp: FastifyInstance
  beforeAll(async () => {
    taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, resolve))
    tdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-port-'))
    await writeFile(join(tdir, 'fremkit.json'), JSON.stringify(CONFIG))
    tapp = await buildApp({
      accessToken: null,
      dataDir: tdir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: (taken.address() as AddressInfo).port,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS], bindRetry: { attempts: 2, delayMs: 10 } },
    })
  })
  afterAll(async () => {
    await tapp?.close()
    await new Promise((resolve) => taken.close(resolve))
    await rm(tdir, { recursive: true, force: true })
  })

  it('answers at once, then falls back to off and says why once the retries give up', async () => {
    const res = await tapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    expect(res.statusCode).toBe(200)
    // The switch as it was while the port is tried again.
    expect(res.json()).toMatchObject({ enabled: false, listening: false, error: null })
    const status = async () => (await tapp.inject({ method: 'GET', url: '/api/devices' })).json()
    for (let i = 0; i < 100 && (await status()).error !== 'portInUse'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await status()).toMatchObject({ enabled: false, listening: false, error: 'portInUse' })
    expect(tapp.pairing.store.enabled).toBe(false)
  })
})

describe.skipIf(!hasOpenssl)('a remote port the previous server still holds', () => {
  /** A free port, taken by a plain server for as long as the test wants it. */
  async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
    const held = createServer()
    await new Promise<void>((resolve) => held.listen(0, resolve))
    return { port: (held.address() as AddressInfo).port, release: () => new Promise((resolve) => held.close(() => resolve())) }
  }
  async function build(dataDir: string, devicesPort: number, bindRetry = { attempts: 20, delayMs: 50 }): Promise<FastifyInstance> {
    return buildApp({
      accessToken: null,
      dataDir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS], bindRetry },
    })
  }
  const until = async (ok: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  }

  it('binds once the port is let go, from the switch, answering at once and reporting nothing', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-retry-'))
    await writeFile(join(tdir, 'fremkit.json'), JSON.stringify(CONFIG))
    const held = await holdPort()
    const tapp = await build(tdir, held.port)
    try {
      const started = Date.now()
      const res = await tapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
      // Not held by the retries (20 × 50 ms here).
      expect(Date.now() - started).toBeLessThan(800)
      expect(res.json()).toMatchObject({ enabled: false, listening: false, error: null })
      expect(res.json().message).toBeUndefined()
      const status = async () => (await tapp.inject({ method: 'GET', url: '/api/devices' })).json()
      await held.release()
      // The retry binds, then records the switch: wait for both, not for the first one alone.
      await until(async () => { const now = await status(); return now.listening === true && now.enabled === true })
      expect(await status()).toMatchObject({ enabled: true, listening: true, error: null })
    } finally {
      await tapp.close()
      await rm(tdir, { recursive: true, force: true })
    }
  })

  it('a stop during the retries ends them: the port let go later is not taken', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-retry-'))
    await writeFile(join(tdir, 'fremkit.json'), JSON.stringify(CONFIG))
    const held = await holdPort()
    const tapp = await build(tdir, held.port)
    try {
      await tapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
      const off = await tapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      expect(off.json()).toMatchObject({ enabled: false, listening: false })
      await held.release()
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect((await tapp.inject({ method: 'GET', url: '/api/devices' })).json()).toMatchObject({ enabled: false, listening: false, error: null })
    } finally {
      await tapp.close()
      await rm(tdir, { recursive: true, force: true })
    }
  })

  it('does not hold the boot, keeps the switch on, and clears the status once it binds', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-boot-'))
    await writeFile(join(tdir, 'fremkit.json'), JSON.stringify(CONFIG))
    await writeFile(join(tdir, 'devices.json'), JSON.stringify({ version: 2, enabled: true, devices: [] }))
    const held = await holdPort()
    const tapp = await build(tdir, held.port, { attempts: 100, delayMs: 100 })
    try {
      // Built after the first try: with ten seconds of retries ahead, the listener is not up yet.
      const status = async () => (await tapp.inject({ method: 'GET', url: '/api/devices' })).json()
      expect(await status()).toMatchObject({ enabled: true, listening: false, error: null })
      await held.release()
      await until(async () => (await status()).listening === true)
      expect(await status()).toMatchObject({ enabled: true, listening: true, error: null })
    } finally {
      await tapp.close()
      await rm(tdir, { recursive: true, force: true })
    }
  })

  it('leaves the switch on when the port stays taken at boot, and says so', async () => {
    const tdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-boot-'))
    await writeFile(join(tdir, 'fremkit.json'), JSON.stringify(CONFIG))
    await writeFile(join(tdir, 'devices.json'), JSON.stringify({ version: 2, enabled: true, devices: [] }))
    const held = await holdPort()
    const tapp = await build(tdir, held.port)
    try {
      const status = async () => (await tapp.inject({ method: 'GET', url: '/api/devices' })).json()
      await until(async () => (await status()).error === 'portInUse')
      expect(await status()).toMatchObject({ enabled: true, listening: false, error: 'portInUse' })
      expect(tapp.pairing.store.enabled).toBe(true)
    } finally {
      await tapp.close()
      await held.release()
      await rm(tdir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasOpenssl)('following a change of address', () => {
  let adir: string
  let aapp: FastifyInstance
  let addresses = ['192.0.2.10']
  /** Every advertisement started, as `[address, stopped]`. */
  const ads: { address: string | null | undefined; stopped: boolean }[] = []
  const recordingAdvertise: Advertiser = (_port, _name, address) => {
    const ad = { address, stopped: false }
    ads.push(ad)
    return { stop: () => { ad.stopped = true } }
  }

  beforeAll(async () => {
    adir = await mkdtemp(join(tmpdir(), 'fremkit-devices-addr-'))
    await writeFile(join(adir, 'fremkit.json'), JSON.stringify(CONFIG))
    aapp = await buildApp({
      accessToken: null,
      dataDir: adir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: recordingAdvertise, lanAddresses: () => addresses, preferredAddress: async (a) => a[0] ?? null },
    })
  })
  afterAll(async () => {
    vi.useRealTimers()
    await aapp?.close()
    await rm(adir, { recursive: true, force: true })
  })

  it('re-issues the certificate from the same key every 30 s when the addresses move, and stops checking when off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const setCertificate = vi.spyOn(RemoteListener.prototype, 'setCertificate')
    try {
      const before = vi.getTimerCount()
      const on = await aapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
      expect(on.json()).toMatchObject({ enabled: true, listening: true })
      const aport = on.json().port as number
      const keyHash = on.json().keyHash as string
      expect(vi.getTimerCount()).toBe(before + 1)
      expect((await remote(aport, { path: '/', host: `192.0.2.10:${aport}` })).status).not.toBe(421)
      expect((await remote(aport, { path: '/', host: `198.51.100.7:${aport}` })).status).toBe(421)

      // Nothing moved: the tick changes nothing.
      vi.advanceTimersByTime(30_000)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(setCertificate).not.toHaveBeenCalled()

      addresses = ['198.51.100.7']
      vi.advanceTimersByTime(29_999)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(setCertificate).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      await expect.poll(() => setCertificate.mock.calls.length).toBe(1)

      const cert = new X509Certificate(setCertificate.mock.calls[0][1])
      expect(cert.subjectAltName).toContain('IP Address:198.51.100.7')
      expect(cert.subjectAltName).not.toContain('192.0.2.10')
      // Same key, so the pin every paired device holds still matches.
      expect(spkiHash(cert.toString())).toBe(keyHash)
      // The Bonjour TXT record follows: the old advertisement withdrawn, the new address announced.
      await expect.poll(() => ads.length).toBe(2)
      expect(ads).toEqual([{ address: '192.0.2.10', stopped: true }, { address: '198.51.100.7', stopped: false }])
      expect((await aapp.inject({ url: '/api/devices' })).json().keyHash).toBe(keyHash)
      // The gate follows: the new authority is in, the old one out.
      expect((await remote(aport, { path: '/', host: `198.51.100.7:${aport}` })).status).not.toBe(421)
      expect((await remote(aport, { path: '/', host: `192.0.2.10:${aport}` })).status).toBe(421)

      const off = await aapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: false } })
      expect(off.json()).toMatchObject({ enabled: false, listening: false })
      expect(vi.getTimerCount()).toBe(before)
      expect(ads[1].stopped).toBe(true)
    } finally {
      setCertificate.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('browser extensions in the device list', () => {
  const ORIGIN = 'chrome-extension://lnckeodobpbbmfbdlpnegjpchgkehdlk'
  const INSTALL = '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d'
  const SALT = Buffer.alloc(32, 5).toString('base64url')
  const HOST = '127.0.0.1:4242'
  let edir: string
  let eapp: FastifyInstance

  /** A new install by default: one install may ask only three times a minute. */
  async function pairExtension(installId: string = randomUUID()): Promise<{ requestId: string; deviceId: string }> {
    const asked = await eapp.inject({
      method: 'POST', url: '/api/companion/pair',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId, salt: SALT }),
    })
    const { requestId } = asked.json()
    const status = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(status.companionRequest).toMatchObject({ requestId, name: 'Chrome' })
    // The user types the Edge's code into the extension, which proves it (companion/pairProof.ts).
    const key = await pairKey(status.companionRequest.code, requestId, SALT)
    const nonce = Buffer.alloc(32, 3).toString('base64url')
    const step = (verb: string, body: unknown) => eapp.inject({
      method: 'POST', url: `/api/companion/pair/${requestId}/${verb}`,
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' }, payload: JSON.stringify(body),
    })
    const paired = (await step('confirm', { nonce, mac: pairClientMac(key, requestId, nonce) })).json()
    expect(paired.state).toBe('paired')
    return { requestId, deviceId: paired.deviceId }
  }

  beforeAll(async () => {
    edir = await mkdtemp(join(tmpdir(), 'fremkit-devices-ext-'))
    await writeFile(join(edir, 'fremkit.json'), JSON.stringify(CONFIG))
    eapp = await buildApp({
      accessToken: null,
      port: 4242,
      dataDir: edir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: { exec, advertise: noAdvertise, lanAddresses: () => [ADDRESS] },
    })
  })
  afterAll(async () => {
    await eapp?.close()
    await eapp?.pairing.store.settled()
    await rm(edir, { recursive: true, force: true })
  })

  it('status lists extension devices and the pending request without tokens', async () => {
    expect((await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json().companionRequest).toBeNull()
    const asked = await eapp.inject({
      method: 'POST', url: '/api/companion/pair',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Chrome', installId: INSTALL, salt: SALT }),
    })
    const { requestId } = asked.json()
    const waiting = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(waiting.companionRequest).toEqual({ requestId, code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{4}$/), name: 'Chrome', extension: 'lnckeo', expiresAt: expect.any(Number) })

    // The same install asking again replaces its waiting request; another install would be busy.
    const { deviceId } = await pairExtension(INSTALL)
    const done = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(done.devices).toEqual([expect.objectContaining({ id: deviceId, kind: 'extension', name: 'Chrome', origin: ORIGIN, connected: false })])
    expect(JSON.stringify(done)).not.toMatch(/token/i)
  })

  it('renames an extension, and refuses to put it on a screen', async () => {
    const { deviceId } = await pairExtension()
    const renamed = await eapp.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, headers: { host: HOST }, payload: { name: 'Work Chrome' } })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ id: deviceId, kind: 'extension', name: 'Work Chrome' })
    const screen = await eapp.inject({ method: 'PATCH', url: `/api/devices/${deviceId}`, headers: { host: HOST }, payload: { screenId: 'ipad' } })
    expect(screen.statusCode).toBe(400)
    const status = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(status.devices.find((d: { id: string }) => d.id === deviceId)).not.toHaveProperty('screenId')
    expect((await eapp.inject({ method: 'PATCH', url: '/api/devices/nobody', headers: { host: HOST }, payload: { name: 'x' } })).statusCode).toBe(404)
  })

  it.skipIf(!hasOpenssl)('remove every iPad and a certificate reset leave the extensions paired', async () => {
    const { deviceId } = await pairExtension()
    const kinds = async () => ((await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json().devices as { id: string; kind: string }[])
    for (const [method, url] of [['DELETE', '/api/devices'], ['POST', '/api/devices/reset-certificate']] as const) {
      const { device: ipad } = await eapp.pairing.store.create('iPad', { width: 1180, height: 820 }, null)
      expect((await kinds()).map((d) => d.id)).toEqual(expect.arrayContaining([ipad.id, deviceId]))
      expect((await eapp.inject({ method, url, headers: { host: HOST } })).statusCode, url).toBeLessThan(300)
      const left = await kinds()
      expect(left.some((d) => d.kind === 'ipad'), url).toBe(false)
      expect(left.map((d) => d.id), url).toContain(deviceId)
    }
  })

  it('removes an extension like any device', async () => {
    const { deviceId } = await pairExtension()
    expect((await eapp.inject({ method: 'DELETE', url: `/api/devices/${deviceId}`, headers: { host: HOST } })).statusCode).toBe(204)
    const status = (await eapp.inject({ url: '/api/devices', headers: { host: HOST } })).json()
    expect(status.devices.find((d: { id: string }) => d.id === deviceId)).toBeUndefined()
  })
})

describe('the device status reads the companion through its closures', () => {
  it('marks an extension connected when its socket is open, and carries the request', async () => {
    const sdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-status-'))
    try {
      const store = new DeviceStore(join(sdir, 'devices.json'))
      await store.load()
      const { device } = await store.createExtension({ name: 'Chrome', origin: `chrome-extension://${'f'.repeat(32)}`, installId: '3a9c1d2e-5b6f-4a7b-8c9d-0e1f2a3b4c5d' })
      let open = new Set<string>()
      const service = new DeviceService({
        app: { log: { warn() {} } } as never,
        store, codes: new PairingCodes(), secrets: {} as never, config: {} as never, hub: {} as never, catalog: {} as never,
        lanAddresses: () => [],
        companionRequest: () => ({ requestId: 'r1', code: 'AB2C', name: 'Chrome', expiresAt: 5, token: 'secret' } as never),
        companionConnected: () => open,
      })
      expect(service.status().devices[0]).toMatchObject({ id: device.id, connected: false })
      open = new Set([device.id])
      expect(service.status().devices[0]).toMatchObject({ id: device.id, connected: true })
      expect(service.status().companionRequest).toEqual({ requestId: 'r1', code: 'AB2C', name: 'Chrome', expiresAt: 5 })
    } finally {
      await rm(sdir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasOpenssl)('telling a paired device where else to find the Mac', () => {
  let mdir: string
  let mapp: FastifyInstance
  let mport: number
  let devicePayload: (deviceId: string) => unknown = () => null
  // What the interfaces report, the listener's Host set included: ten RFC 1918 addresses,
  // documentation ranges standing for public addresses, CGNAT, link-local and IPv6. Only RFC 1918
  // ones may reach the device app, the default route's first, eight at most.
  const PRIVATE = ['10.20.30.40', '10.20.30.41', '10.20.30.42', '10.20.30.43', '172.16.4.2', '172.16.4.3', '172.16.4.4',
    '192.168.1.20', '192.168.1.21', '192.168.1.22']
  const DEFAULT_ROUTE = '192.168.1.20'
  const OTHERS = ['192.0.2.10', '198.51.100.7', '100.100.1.1', '169.254.1.1', 'fd00::1', '2001:db8::1']
  const VPN = '10.20.30.40'
  const OUTSIDER = '10.99.0.1'
  const picked: string[][] = []

  beforeAll(async () => {
    mdir = await mkdtemp(join(tmpdir(), 'fremkit-devices-me-'))
    await writeFile(join(mdir, 'fremkit.json'), JSON.stringify(CONFIG))
    // Keeps what the service gives the hub for the `device` channel; the call goes through.
    const capture = vi.spyOn(Hub.prototype, 'setDevicePayload')
    mapp = await buildApp({
      accessToken: null,
      dataDir: mdir,
      widgetsDir: join(process.cwd(), '..', 'widgets'),
      providers: [],
      devicesPort: 0,
      devices: {
        exec, advertise: noAdvertise, lanAddresses: () => [...OTHERS, ...PRIVATE].sort(),
        preferredAddress: async (a) => a[0] ?? null,
        // A VPN's address is left out, and an address the listener does not answer on is dropped
        // by the service even if the lookup names it.
        appAddresses: async (a) => { picked.push(a); return [OUTSIDER, DEFAULT_ROUTE, ...a.filter((x) => x !== DEFAULT_ROUTE && x !== VPN)] },
      },
    })
    devicePayload = capture.mock.calls[0][0]
    capture.mockRestore()
    const on = await mapp.inject({ method: 'PUT', url: '/api/devices/settings', payload: { enabled: true } })
    mport = on.json().port
  })
  afterAll(async () => {
    await mapp?.close()
    await rm(mdir, { recursive: true, force: true })
  })

  it('lists the Wi-Fi and Ethernet RFC 1918 addresses the listener answers on, default route first, eight at most, to the app that asks', async () => {
    const offer = (await mapp.inject({ method: 'POST', url: '/api/devices/code' })).json()
    const paired = await remote(mport, {
      method: 'POST', path: '/api/pair', host: `example.local:${mport}`, headers: json,
      body: JSON.stringify({ ...typed(offer.code, new URL(offer.url).searchParams.get('k') as string), name: 'iPad', viewport: { width: 640, height: 480 } }),
    })
    expect(paired.status).toBe(200)
    const { token, deviceId } = JSON.parse(paired.body)

    const res = await remote(mport, { path: '/api/devices/me?addresses=1', host: `example.local:${mport}`, headers: cookie(token) })
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body)
    const sorted = [...PRIVATE].sort()
    expect(body.addresses).toEqual([DEFAULT_ROUTE, ...sorted.filter((a) => a !== DEFAULT_ROUTE && a !== VPN)].slice(0, 8))
    expect(body.addresses).toHaveLength(8)
    expect(body.addresses).not.toContain(VPN)
    expect(body.addresses).not.toContain(OUTSIDER)
    // The list is looked up among the private addresses only, and once for two
    // quick asks with the same addresses (each iPad asks about every 30 s).
    expect(picked.at(-1)).toEqual(sorted)
    const lookups = picked.length
    const again = await remote(mport, { path: '/api/devices/me?addresses=1', host: `example.local:${mport}`, headers: cookie(token) })
    expect(JSON.parse(again.body).addresses).toEqual(body.addresses)
    expect(picked).toHaveLength(lookups)
    for (const other of OTHERS) expect(res.body).not.toContain(other)
    // Each address listed is one the listener answers on, so the app is never sent to a 421.
    for (const address of body.addresses) {
      expect((await remote(mport, { path: '/api/devices/me', host: `${address}:${mport}`, headers: cookie(token) })).status).toBe(200)
    }

    // The dashboard page's own request does not ask, and is not told.
    for (const path of ['/api/devices/me', '/api/devices/me?addresses=0', '/api/devices/me?addresses=true']) {
      const plain = await remote(mport, { path, host: `example.local:${mport}`, headers: cookie(token) })
      expect(plain.status, path).toBe(200)
      expect(JSON.parse(plain.body), path).not.toHaveProperty('addresses')
      for (const address of PRIVATE) expect(plain.body, path).not.toContain(address)
    }
    // Nor is the `device` channel, which the page reads.
    const payload = devicePayload(deviceId)
    expect(payload).toMatchObject({ id: deviceId })
    expect(payload).not.toHaveProperty('addresses')
    for (const address of PRIVATE) expect(JSON.stringify(payload)).not.toContain(address)
    // Without a token the gate refuses it; locally the route does not exist.
    expect((await remote(mport, { path: '/api/devices/me?addresses=1', host: `example.local:${mport}` })).status).toBe(401)
    expect((await mapp.inject({ url: '/api/devices/me?addresses=1' })).statusCode).toBe(404)
  })
})
