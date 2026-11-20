import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanionDev } from '../src/companion/dev.js'
import { FREMDEV_FEATURES, SHOT_MAX_BYTES, type ServerMessage } from '../src/companion/protocol.js'
import { companionShotRoute, osascriptImageClipboard, type ImageClipboard } from '../src/companion/shot.js'
import { generateToken } from '../src/http/access.js'

const ORIGIN = 'chrome-extension://lnckeodobpbbmfbdlpnegjpchgkehdlk'
const OTHER = `chrome-extension://${'d'.repeat(32)}`
const TOKEN = generateToken()
const DEVICE = '11111111-1111-4111-8111-111111111111'
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function fakeStore() {
  return {
    findByToken: vi.fn((token: string, kind: string) =>
      token === TOKEN && kind === 'extension'
        ? { id: DEVICE, kind: 'extension' as const, name: 'Chrome', pairedAt: '2026-10-20T00:00:00.000Z', lastSeen: null, origin: ORIGIN, installId: '22222222-2222-4222-8222-222222222222' }
        : null),
  }
}

describe('POST /companion/dev/shot', () => {
  let app: FastifyInstance
  let written: Buffer[]
  let canShot: ReturnType<typeof vi.fn<(id: string) => boolean>>
  let clipboard: ImageClipboard & { writeJpeg: ReturnType<typeof vi.fn> }
  let logs: string[]

  beforeEach(async () => {
    written = []
    logs = []
    canShot = vi.fn<(id: string) => boolean>(() => true)
    clipboard = { writeJpeg: vi.fn(async (bytes: Buffer) => void written.push(Buffer.from(bytes))) }
    app = Fastify({ logger: { level: 'info', stream: { write: (line: string) => void logs.push(line) } } })
    await app.register(companionShotRoute, { store: fakeStore(), dev: { canShot }, origins: new Set([ORIGIN]), clipboard })
    await app.ready()
  })
  afterEach(async () => { await app.close() })

  const shot = (over: { origin?: string | null; token?: string | null; body?: Buffer; type?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': over.type ?? 'image/jpeg' }
    const origin = over.origin === undefined ? ORIGIN : over.origin
    const token = over.token === undefined ? TOKEN : over.token
    if (origin !== null) headers.origin = origin
    if (token !== null) headers.authorization = `Bearer ${token}`
    return app.inject({ method: 'POST', url: '/companion/dev/shot', headers, payload: over.body ?? JPEG })
  }

  it('copies a JPEG from the paired extension, once, and logs only the device id', async () => {
    const res = await shot()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(written).toEqual([JPEG])
    expect(canShot).toHaveBeenCalledWith(DEVICE)
    const text = logs.join('\n')
    expect(text).toContain(DEVICE)
    expect(text).not.toContain(TOKEN)
  })

  it('is not found from another machine, whatever the request carries, and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/companion/dev/shot',
      remoteAddress: '192.0.2.10',
      headers: { 'content-type': 'image/jpeg', origin: ORIGIN, authorization: `Bearer ${TOKEN}` },
      payload: JPEG,
    })
    expect(res.statusCode).toBe(404)
    expect(written).toEqual([])
    expect(canShot).not.toHaveBeenCalled()
  })

  it('refuses no origin or another extension\'s origin with 403, before anything is written', async () => {
    expect((await shot({ origin: null })).statusCode).toBe(403)
    expect((await shot({ origin: OTHER })).statusCode).toBe(403)
    expect((await shot({ origin: 'http://localhost:5173' })).statusCode).toBe(403)
    expect(written).toEqual([])
  })

  it('refuses a wrong or missing bearer with 401', async () => {
    expect((await shot({ token: generateToken() })).statusCode).toBe(401)
    expect((await shot({ token: null })).statusCode).toBe(401)
    expect((await shot({ token: 'short' })).statusCode).toBe(401)
    expect(written).toEqual([])
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('refuses a bearer whose record belongs to another origin with 401', async () => {
    await app.close()
    app = Fastify()
    await app.register(companionShotRoute, { store: fakeStore(), dev: { canShot }, origins: new Set([ORIGIN, OTHER]), clipboard })
    expect((await shot({ origin: OTHER })).statusCode).toBe(401)
    expect(written).toEqual([])
  })

  it('refuses with 409 when the install cannot shoot (Fremdev off, or the module not listed)', async () => {
    canShot.mockReturnValue(false)
    expect((await shot()).statusCode).toBe(409)
    expect(written).toEqual([])
  })

  it('refuses a body that is not a JPEG with 415', async () => {
    expect((await shot({ body: PNG })).statusCode).toBe(415)
    const png = await shot({ body: PNG, type: 'image/png' })
    expect(png.statusCode).toBe(415)
    expect(png.json()).toEqual({ ok: false })
    expect(png.headers['cache-control']).toBe('no-store')
    expect((await shot({ body: Buffer.from([0xff, 0xd8]) })).statusCode).toBe(415)
    expect(written).toEqual([])
  })

  it('refuses a body over SHOT_MAX_BYTES with 413', async () => {
    expect(SHOT_MAX_BYTES).toBe(2_097_152)
    const big = Buffer.alloc(SHOT_MAX_BYTES + 1, 0)
    JPEG.copy(big)
    const over = await shot({ body: big })
    expect(over.statusCode).toBe(413)
    // The route's own refusal, not Fastify's default error body.
    expect(over.json()).toEqual({ ok: false })
    expect(over.headers['cache-control']).toBe('no-store')
    expect(written).toEqual([])
    const fits = Buffer.alloc(SHOT_MAX_BYTES, 0)
    JPEG.copy(fits)
    expect((await shot({ body: fits })).statusCode).toBe(200)
  })

  it('takes one shot at a time per device: the second is 429', async () => {
    let release!: () => void
    clipboard.writeJpeg.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const first = shot()
    await vi.waitFor(() => expect(clipboard.writeJpeg).toHaveBeenCalledTimes(1))
    const second = await shot()
    expect(second.statusCode).toBe(429)
    release()
    expect((await first).statusCode).toBe(200)
    expect((await shot()).statusCode).toBe(200)
  })

  it('answers 500 { ok: false } when the clipboard write fails, and frees the slot', async () => {
    clipboard.writeJpeg.mockRejectedValueOnce(new Error('osascript failed'))
    const res = await shot()
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ ok: false })
    expect((await shot()).statusCode).toBe(200)
  })
})

describe('osascriptImageClipboard', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'fremkit-shot-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  type Callback = (error: Error | null, stdout?: string, stderr?: string) => void

  it('runs /usr/bin/osascript with a constant script and the file last, from a 0600 file it removes', async () => {
    const seen: Array<{ cmd: string; args: readonly string[]; timeout: number; mode: number; bytes: number }> = []
    const exec = vi.fn((cmd: string, args: readonly string[], options: { timeout: number }, cb: Callback) => {
      const file = args[args.length - 1]
      void stat(file).then((s) => {
        seen.push({ cmd, args, timeout: options.timeout, mode: s.mode & 0o777, bytes: s.size })
        cb(null, '', '')
      }, (err) => cb(err))
    })
    await osascriptImageClipboard(dir, exec).writeJpeg(JPEG)
    expect(seen).toHaveLength(1)
    const [call] = seen
    expect(call.cmd).toBe('/usr/bin/osascript')
    expect(call.args.slice(0, -1)).toEqual([
      '-e', 'on run argv',
      '-e', 'set the clipboard to (read (POSIX file (item 1 of argv)) as JPEG picture)',
      '-e', 'end run',
    ])
    expect(call.args.at(-1)).toMatch(new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/shot-[0-9a-f-]{36}\\.jpg$`))
    expect(call.timeout).toBe(10_000)
    expect(call.mode).toBe(0o600)
    expect(call.bytes).toBe(JPEG.length)
    expect(await readdir(dir)).toEqual([])
  })

  it('removes the file when osascript fails, and rejects', async () => {
    let file = ''
    const exec = (_cmd: string, args: readonly string[], _o: { timeout: number }, cb: Callback) => {
      file = args[args.length - 1]
      cb(new Error('execution error'))
    }
    await expect(osascriptImageClipboard(dir, exec).writeJpeg(JPEG)).rejects.toThrow()
    expect(file).not.toBe('')
    expect(await readdir(dir)).toEqual([])
  })
})

describe('CompanionDev.canShot', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  function make(enabled = true) {
    let on = enabled
    const dev = new CompanionDev({
      send: (_id: string, _msg: ServerMessage) => undefined,
      changed: () => undefined,
      enabled: () => on,
      pairedCount: () => 1,
    })
    return { dev, setEnabled: (v: boolean) => { on = v } }
  }

  it('lists fremdev.shot among the features', () => {
    expect(FREMDEV_FEATURES).toContain('fremdev.shot')
  })

  it('is true only for a connected, on install that lists fremdev.shot, with Fremdev enabled', () => {
    const t = make()
    expect(t.dev.canShot(A)).toBe(false)
    t.dev.connect(A, 'Chrome', ['fremplay', 'fremdev'])
    expect(t.dev.canShot(A)).toBe(false)
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay', 'fremdev', 'fremdev.shot'] })
    expect(t.dev.canShot(A)).toBe(true)
    t.setEnabled(false)
    expect(t.dev.canShot(A)).toBe(false)
    t.setEnabled(true)
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay'] })
    expect(t.dev.canShot(A)).toBe(false)
    t.dev.onMessage(A, { type: 'modules', modules: ['fremplay', 'fremdev', 'fremdev.shot'] })
    t.dev.disconnect(A)
    expect(t.dev.canShot(A)).toBe(false)
  })
})
