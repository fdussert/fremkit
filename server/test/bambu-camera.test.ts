import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  authPacket,
  BAMBU_CAMERA_PORT,
  createBambuCamera,
  parseFrames,
  type BambuCameraSocket,
  type BambuTlsOptions,
} from '../src/providers/bambu-camera.js'
import { BambuCameras, CAMERA_IDLE_MS } from '../src/bambu/cameras.js'
import { bambuRoutes } from '../src/bambu/routes.js'
import Fastify, { type FastifyInstance } from 'fastify'

/** A minimal JPEG: the magic the parser checks at both ends, with `size` bytes in all. */
function jpeg(size: number, fill = 0x2a): Buffer {
  const body = Buffer.alloc(size, fill)
  body[0] = 0xff; body[1] = 0xd8; body[2] = 0xff
  body[size - 2] = 0xff; body[size - 1] = 0xd9
  return body
}

function framed(payload: Buffer, size = payload.length): Buffer {
  const header = Buffer.alloc(16)
  header.writeUInt32LE(size, 0)
  header.writeUInt32LE(0, 4)
  header.writeUInt32LE(0, 8)
  header.writeUInt32LE(0, 12)
  return Buffer.concat([header, payload])
}

describe('authPacket', () => {
  it('is 80 bytes: two magic words, then the padded user and access code', () => {
    const packet = authPacket('12345678')
    expect(packet.length).toBe(80)
    expect(packet.readUInt32LE(0)).toBe(0x40)
    expect(packet.readUInt32LE(4)).toBe(0x3000)
    expect(packet.readUInt32LE(8)).toBe(0)
    expect(packet.readUInt32LE(12)).toBe(0)
    expect(packet.subarray(16, 48).toString('ascii')).toBe('bblp' + '\0'.repeat(28))
    expect(packet.subarray(48, 80).toString('ascii')).toBe('12345678' + '\0'.repeat(24))
  })

  it('truncates an over-long access code instead of spilling past the packet', () => {
    const packet = authPacket('x'.repeat(50))
    expect(packet.length).toBe(80)
    expect(packet.subarray(48, 80).toString('ascii')).toBe('x'.repeat(32))
  })
})

describe('parseFrames', () => {
  it('cuts one frame and keeps nothing', () => {
    const one = jpeg(64)
    const parsed = parseFrames(framed(one))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].equals(one)).toBe(true)
    expect(parsed.rest.length).toBe(0)
  })

  it('cuts two frames out of one chunk', () => {
    const a = jpeg(40, 0x11)
    const b = jpeg(60, 0x22)
    const parsed = parseFrames(Buffer.concat([framed(a), framed(b)]))
    expect(parsed.frames.map((f) => f.length)).toEqual([40, 60])
    expect(parsed.frames[1].equals(b)).toBe(true)
  })

  it('waits for a frame split across chunks, then yields it whole', () => {
    const one = framed(jpeg(120))
    const first = parseFrames(one.subarray(0, 50))
    expect(first.frames).toHaveLength(0)
    expect(first.rest.length).toBe(50)
    const second = parseFrames(Buffer.concat([first.rest, one.subarray(50)]))
    expect(second.frames).toHaveLength(1)
    expect(second.frames[0].length).toBe(120)
    expect(second.rest.length).toBe(0)
  })

  it('skips garbage sitting before a header', () => {
    const one = jpeg(48)
    const parsed = parseFrames(Buffer.concat([Buffer.from('hello printer'), framed(one)]))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].equals(one)).toBe(true)
  })

  it('resynchronises past an oversized bogus header', () => {
    const bogus = Buffer.alloc(16)
    bogus.writeUInt32LE(0xfffffff0, 0)
    const one = jpeg(32)
    const parsed = parseFrames(Buffer.concat([bogus, framed(one)]))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0].equals(one)).toBe(true)
  })

  it('drops a payload that does not end on the JPEG marker', () => {
    const broken = jpeg(32)
    broken[31] = 0x00
    const parsed = parseFrames(Buffer.concat([framed(broken), framed(jpeg(32, 0x33))]))
    expect(parsed.frames).toHaveLength(1)
    expect(parsed.frames[0][3]).toBe(0x33)
  })

  it('keeps an incomplete header for the next chunk', () => {
    const parsed = parseFrames(Buffer.from([1, 2, 3, 4, 5]))
    expect(parsed.frames).toHaveLength(0)
    expect(parsed.rest.length).toBe(5)
  })
})

/** A fake printer socket: records what was written and lets a test push bytes back. */
function fakeStream() {
  const opened: BambuTlsOptions[] = []
  const written: Buffer[] = []
  let handlers = { ready: [] as (() => void)[], data: [] as ((c: Buffer) => void)[], close: [] as ((e?: Error) => void)[] }
  let ended = 0
  const connectTls = (opts: BambuTlsOptions): BambuCameraSocket => {
    opened.push(opts)
    handlers = { ready: [], data: [], close: [] }
    return {
      onReady: (cb) => handlers.ready.push(cb),
      onData: (cb) => handlers.data.push(cb),
      onClose: (cb) => handlers.close.push(cb),
      write: (data) => { written.push(data) },
      end: () => { ended++ },
    }
  }
  return {
    connectTls, opened, written,
    get ended() { return ended },
    fireReady: () => handlers.ready.forEach((cb) => cb()),
    push: (chunk: Buffer) => handlers.data.forEach((cb) => cb(chunk)),
    fireClose: () => handlers.close.forEach((cb) => cb()),
  }
}

describe('createBambuCamera', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('dials port 6000, authenticates, then keeps the latest frame', () => {
    const printer = fakeStream()
    const camera = createBambuCamera({ host: '192.0.2.5', accessCode: 'abcd1234', connectTls: printer.connectTls, now: () => 1000 })
    expect(camera.state).toBe('idle')

    camera.start()
    expect(printer.opened).toEqual([{ host: '192.0.2.5', port: BAMBU_CAMERA_PORT }])
    expect(camera.state).toBe('connecting')

    printer.fireReady()
    expect(printer.written).toHaveLength(1)
    expect(printer.written[0].equals(authPacket('abcd1234'))).toBe(true)
    expect(camera.latest()).toBeNull()

    printer.push(framed(jpeg(40, 0x11)))
    expect(camera.state).toBe('streaming')
    expect(camera.latest()?.at).toBe(1000)

    // Only the newest picture is kept: a slow viewer never gets a backlog.
    printer.push(framed(jpeg(40, 0x22)))
    expect(camera.latest()?.jpeg[3]).toBe(0x22)
  })

  it('reassembles a frame arriving in pieces', () => {
    const printer = fakeStream()
    const camera = createBambuCamera({ host: 'h', accessCode: 'c', connectTls: printer.connectTls })
    camera.start()
    printer.fireReady()
    const chunk = framed(jpeg(100))
    printer.push(chunk.subarray(0, 30))
    expect(camera.latest()).toBeNull()
    printer.push(chunk.subarray(30))
    expect(camera.latest()?.jpeg.length).toBe(100)
  })

  it('reconnects with a growing backoff while started', () => {
    const printer = fakeStream()
    const camera = createBambuCamera({ host: 'h', accessCode: 'c', connectTls: printer.connectTls })
    camera.start()
    printer.fireClose()
    expect(camera.state).toBe('error')
    expect(printer.opened).toHaveLength(1)

    vi.advanceTimersByTime(1999)
    expect(printer.opened).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(printer.opened).toHaveLength(2)

    printer.fireClose()
    vi.advanceTimersByTime(3999)
    expect(printer.opened).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(printer.opened).toHaveLength(3)
  })

  it('caps the backoff at 30 s', () => {
    const printer = fakeStream()
    const camera = createBambuCamera({ host: 'h', accessCode: 'c', connectTls: printer.connectTls })
    camera.start()
    for (let i = 0; i < 8; i++) { printer.fireClose(); vi.advanceTimersByTime(30_000) }
    const before = printer.opened.length
    printer.fireClose()
    vi.advanceTimersByTime(30_000)
    expect(printer.opened.length).toBe(before + 1)
  })

  it('stops for good: no reconnect, no stale frame', () => {
    const printer = fakeStream()
    const camera = createBambuCamera({ host: 'h', accessCode: 'c', connectTls: printer.connectTls })
    camera.start()
    printer.fireReady()
    printer.push(framed(jpeg(40)))
    camera.stop()
    expect(camera.state).toBe('idle')
    expect(camera.latest()).toBeNull()
    expect(printer.ended).toBe(1)
    vi.advanceTimersByTime(120_000)
    expect(printer.opened).toHaveLength(1)
  })
})

describe('BambuCameras', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('serves only configured ids and starts the stream on the first request', () => {
    const printer = fakeStream()
    const cameras = new BambuCameras({ connectTls: printer.connectTls })
    expect(cameras.has('bambu-x')).toBe(false)

    cameras.configure('bambu-x', { host: '192.0.2.5', accessCode: 'code' })
    expect(cameras.has('bambu-x')).toBe(true)
    // Declaring a printer must not dial it.
    expect(printer.opened).toHaveLength(0)

    expect(cameras.snapshot('bambu-x')).toBeNull()
    expect(printer.opened).toHaveLength(1)
    printer.fireReady()
    printer.push(framed(jpeg(40)))
    expect(cameras.snapshot('bambu-x')?.jpeg.length).toBe(40)
  })

  it('stops a camera nobody asked about for a minute, and reopens on the next request', () => {
    const printer = fakeStream()
    const cameras = new BambuCameras({ connectTls: printer.connectTls })
    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    cameras.snapshot('bambu-x')
    printer.fireReady()
    printer.push(framed(jpeg(40)))

    // Each request pushes the deadline back.
    vi.advanceTimersByTime(CAMERA_IDLE_MS - 1)
    cameras.snapshot('bambu-x')
    vi.advanceTimersByTime(CAMERA_IDLE_MS - 1)
    expect(cameras.state('bambu-x')).toBe('streaming')

    vi.advanceTimersByTime(1)
    expect(cameras.state('bambu-x')).toBe('idle')
    cameras.snapshot('bambu-x')
    expect(printer.opened).toHaveLength(2)
  })

  it('reports freshness without starting anything', () => {
    let now = 5000
    const printer = fakeStream()
    const cameras = new BambuCameras({ connectTls: printer.connectTls, now: () => now })
    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    expect(cameras.fresh('bambu-x', 10_000)).toBe(false)
    expect(cameras.fresh('nope', 10_000)).toBe(false)
    expect(printer.opened).toHaveLength(0)

    cameras.snapshot('bambu-x')
    printer.fireReady()
    printer.push(framed(jpeg(40)))
    expect(cameras.fresh('bambu-x', 10_000)).toBe(true)
    now += 10_001
    expect(cameras.fresh('bambu-x', 10_000)).toBe(false)
  })

  it('replaces a camera whose host or access code changed, and keeps one that did not', () => {
    const printer = fakeStream()
    const cameras = new BambuCameras({ connectTls: printer.connectTls })
    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    cameras.snapshot('bambu-x')
    expect(printer.opened).toHaveLength(1)

    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    expect(cameras.state('bambu-x')).toBe('connecting')

    cameras.configure('bambu-x', { host: 'other', accessCode: 'c' })
    expect(printer.ended).toBe(1)
    expect(cameras.state('bambu-x')).toBe('idle')
    cameras.snapshot('bambu-x')
    expect(printer.opened[1].host).toBe('other')
  })

  it('forgets a camera whose connection is gone', () => {
    const printer = fakeStream()
    const cameras = new BambuCameras({ connectTls: printer.connectTls })
    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    cameras.configure('bambu-y', { host: 'h2', accessCode: 'c' })
    cameras.snapshot('bambu-x')
    cameras.retain(new Set(['bambu-y']))
    expect(cameras.has('bambu-x')).toBe(false)
    expect(cameras.has('bambu-y')).toBe(true)
    expect(printer.ended).toBe(1)
  })
})

describe('GET /api/bambu/:id/snapshot.jpg', () => {
  let app: FastifyInstance
  let cameras: BambuCameras
  let printer: ReturnType<typeof fakeStream>

  beforeEach(async () => {
    printer = fakeStream()
    cameras = new BambuCameras({ connectTls: printer.connectTls })
    app = Fastify()
    await app.register(bambuRoutes, { cameras })
    await app.ready()
  })
  afterEach(async () => { cameras.stopAll(); await app.close() })

  it('404s an unknown or non-Bambu connection id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bambu/nope/snapshot.jpg' })
    expect(res.statusCode).toBe(404)
  })

  it('404s an id the config schema would refuse', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/bambu/..%2Fetc/snapshot.jpg' })
    expect(res.statusCode).toBe(404)
  })

  it('503s with the camera state while no frame has arrived', async () => {
    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    const res = await app.inject({ method: 'GET', url: '/api/bambu/bambu-x/snapshot.jpg' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ state: 'connecting' })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('serves the JPEG, uncached', async () => {
    cameras.configure('bambu-x', { host: 'h', accessCode: 'c' })
    await app.inject({ method: 'GET', url: '/api/bambu/bambu-x/snapshot.jpg' })
    printer.fireReady()
    printer.push(framed(jpeg(64, 0x55)))

    const res = await app.inject({ method: 'GET', url: '/api/bambu/bambu-x/snapshot.jpg' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/jpeg')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.rawPayload.length).toBe(64)
    expect([...res.rawPayload.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })
})
