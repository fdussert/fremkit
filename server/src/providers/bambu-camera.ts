import { connect as tlsConnect } from 'node:tls'

/**
 * The chamber camera of a P1 or A1 printer, in LAN mode.
 *
 * It is not an HTTP stream: the printer listens on a TLS socket, expects one fixed 80-byte auth
 * packet, then pushes JPEG frames forever, each behind a 16-byte little-endian header. The
 * protocol is community-documented; nothing here talks to Bambu's cloud.
 *
 * X1 and H2 printers do not speak it — they answer with a couple of dozen bytes and hang up. Those
 * go through `bambu-rtsp.ts` instead.
 */
export const BAMBU_CAMERA_PORT = 6000

/** [payloadSize, itrack, flags, reserved], four little-endian uint32. */
const HEADER_BYTES = 16
/** A chamber frame is a small JPEG. Past this, the header was misread, not huge. */
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
const RECONNECT_START_MS = 2000
const RECONNECT_MAX_MS = 30_000
/** Frames arrive at least once a second; a longer silence means the socket is dead, not idle. */
const IDLE_TIMEOUT_MS = 20_000

export interface BambuCameraSocket {
  /** The TLS handshake is done and the auth packet can go out. */
  onReady(cb: () => void): void
  onData(cb: (chunk: Buffer) => void): void
  /** Called once per socket, on error or on close. */
  onClose(cb: (err?: Error) => void): void
  write(data: Buffer): void
  end(): void
}

export interface BambuTlsOptions { host: string; port: number }
export type BambuTlsConnect = (opts: BambuTlsOptions) => BambuCameraSocket

/**
 * Real socket.
 *
 * `rejectUnauthorized: false` for the same reason as the MQTT client: the printer serves a
 * self-signed certificate for its own IP and there is no CA to pin it to.
 */
export const connectBambuTls: BambuTlsConnect = (opts) => {
  const socket = tlsConnect({ host: opts.host, port: opts.port, rejectUnauthorized: false })
  socket.setTimeout(IDLE_TIMEOUT_MS)
  let closed = false
  return {
    onReady: (cb) => { socket.on('secureConnect', cb) },
    onData: (cb) => { socket.on('data', cb) },
    onClose: (cb) => {
      // `error`, `close` and the idle watchdog all end the same socket: collapse them into one call.
      const once = (err?: Error): void => { if (closed) return; closed = true; cb(err) }
      socket.on('error', once)
      socket.on('close', () => once())
      socket.on('timeout', () => { socket.destroy(); once() })
    },
    write: (data) => { socket.write(data) },
    end: () => { closed = true; socket.destroy() },
  }
}

/**
 * The one packet the printer wants before it says anything: two magic uint32 then a padded
 * username and access code, 80 bytes in all. `Buffer.alloc` gives the NUL padding for free, and
 * `write` with a length caps an over-long code instead of spilling into the next field.
 */
export function authPacket(accessCode: string): Buffer {
  const packet = Buffer.alloc(80)
  packet.writeUInt32LE(0x40, 0)
  packet.writeUInt32LE(0x3000, 4)
  packet.writeUInt32LE(0, 8)
  packet.writeUInt32LE(0, 12)
  packet.write('bblp', 16, 32, 'ascii')
  packet.write(accessCode, 48, 32, 'ascii')
  return packet
}

const startsJpeg = (buffer: Buffer, at: number): boolean =>
  buffer[at] === 0xff && buffer[at + 1] === 0xd8 && buffer[at + 2] === 0xff

const endsJpeg = (frame: Buffer): boolean =>
  frame.length >= 4 && frame[frame.length - 2] === 0xff && frame[frame.length - 1] === 0xd9

/**
 * Cuts whole frames out of whatever has arrived so far, and hands back the tail to keep.
 *
 * A TCP read boundary is not a frame boundary, so the caller accumulates and calls this on every
 * chunk. A header is only trusted when a JPEG actually starts right after it: that one check
 * rejects a bogus size and doubles as the resynchronisation rule, because after garbage — a
 * dropped byte, a frame we refused — the scan walks forward until the next real header lines up.
 */
export function parseFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = []
  let at = 0
  while (buffer.length - at >= HEADER_BYTES + 3) {
    const size = buffer.readUInt32LE(at)
    if (size < 4 || size > MAX_PAYLOAD_BYTES || !startsJpeg(buffer, at + HEADER_BYTES)) {
      at += 1
      continue
    }
    const end = at + HEADER_BYTES + size
    // A plausible header whose payload is still in flight: stop here and wait for more bytes.
    if (end > buffer.length) break
    const frame = buffer.subarray(at + HEADER_BYTES, end)
    // A frame that does not end on the JPEG marker was cut by a desync upstream: drop it, but
    // trust the header's size to find the next one rather than rescanning its whole payload.
    if (endsJpeg(frame)) frames.push(Buffer.from(frame))
    at = end
  }
  return { frames, rest: buffer.subarray(at) }
}

export interface BambuFrame { jpeg: Buffer; at: number }
export type BambuCameraState = 'idle' | 'connecting' | 'streaming' | 'error'

export interface BambuCamera {
  start(): void
  stop(): void
  latest(): BambuFrame | null
  readonly state: BambuCameraState
  /**
   * A machine-readable reason the preview cannot work, for the few failures a user can act on
   * (a missing ffmpeg, say). Undefined for the ordinary "not connected yet", which the widget
   * already covers with its placeholder.
   */
  readonly errorCode?: string
}

export interface BambuCameraOptions {
  host: string
  accessCode: string
  connectTls?: BambuTlsConnect
  now?: () => number
}

/**
 * One camera per printer: keeps only the last frame, so a viewer that polls slowly costs nothing
 * more than a fast one and nothing is ever buffered up for a client that went away.
 */
export function createBambuCamera(opts: BambuCameraOptions): BambuCamera {
  const connect = opts.connectTls ?? connectBambuTls
  const now = opts.now ?? Date.now

  let socket: BambuCameraSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let backoff = RECONNECT_START_MS
  let running = false
  let state: BambuCameraState = 'idle'
  let frame: BambuFrame | null = null
  // Typed loosely: socket chunks come as Buffer<ArrayBufferLike>, Buffer.alloc as Buffer<ArrayBuffer>.
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  function open(): void {
    if (!running) return
    state = 'connecting'
    pending = Buffer.alloc(0)
    const current = connect({ host: opts.host, port: BAMBU_CAMERA_PORT })
    socket = current
    current.onReady(() => {
      // The access code never reaches a log line, here or on failure.
      current.write(authPacket(opts.accessCode))
    })
    current.onData((chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const parsed = parseFrames(pending)
      pending = parsed.rest
      if (!parsed.frames.length) return
      frame = { jpeg: parsed.frames[parsed.frames.length - 1], at: now() }
      state = 'streaming'
      // A stream that got going resets the backoff: the next drop retries promptly.
      backoff = RECONNECT_START_MS
    })
    current.onClose(() => {
      if (socket === current) socket = null
      current.end()
      state = running ? 'error' : 'idle'
      schedule()
    })
  }

  function schedule(): void {
    if (!running || retry) return
    const delay = backoff
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    retry = setTimeout(() => { retry = null; open() }, delay)
    retry.unref?.()
  }

  return {
    start(): void {
      if (running) return
      running = true
      backoff = RECONNECT_START_MS
      open()
    },
    stop(): void {
      running = false
      if (retry) { clearTimeout(retry); retry = null }
      socket?.end()
      socket = null
      pending = Buffer.alloc(0)
      // The last frame goes too: a picture from before the camera was parked is not a preview.
      frame = null
      state = 'idle'
    },
    latest: () => frame,
    get state() { return state },
  }
}
