import { spawn } from 'node:child_process'
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BambuCamera, BambuCameraState, BambuFrame } from './bambu-camera.js'

/**
 * The chamber camera of an X1 or H2 printer, in LAN mode.
 *
 * Those printers do not serve the port-6000 JPEG protocol the P1/A1 speak (they answer the auth
 * packet with a couple of dozen bytes and hang up). They publish an RTSPS stream instead, on port
 * 322, guarded by the same access code. Decoding H.264 in-process is not worth a dependency for a
 * tile-sized preview, so ffmpeg does it and hands back one JPEG a second on its stdout.
 *
 * The stream only exists when "LAN Mode Liveview" (camera LAN streaming) is switched on from the
 * printer's own settings; without it the port answers and then refuses the session.
 */
export const BAMBU_RTSP_PORT = 322

/** Frames arrive once a second; a longer silence means ffmpeg is wedged, not idle. */
const IDLE_TIMEOUT_MS = 20_000
const RECONNECT_START_MS = 2000
const RECONNECT_MAX_MS = 30_000
/** Past this, stdout is not a JPEG stream and the accumulator must not grow without end. */
const MAX_PENDING_BYTES = 8 * 1024 * 1024
/**
 * A run that dies sooner than this never produced a working session, so the transport is allowed
 * to try its other way of passing the URL once before settling on one.
 */
const EARLY_EXIT_MS = 5000

/** Where ffmpeg usually lives, once PATH has had its say. Homebrew (arm64, x86_64), MacPorts, distro. */
const FFMPEG_FALLBACK_PATHS = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/opt/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
]

/** The camera error the widget turns into "install ffmpeg"; any other failure is just a retry. */
export const FFMPEG_MISSING = 'ffmpeg-missing'

const executable = (path: string): boolean => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

/**
 * The ffmpeg binary, or null when there is none.
 *
 * PATH first so a user who installed their own build gets it, then the usual package-manager
 * locations, because a server started by launchd inherits a PATH that has none of them.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromPath = (env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, 'ffmpeg'))
  for (const candidate of [...fromPath, ...FFMPEG_FALLBACK_PATHS]) {
    if (executable(candidate)) return candidate
  }
  return null
}

/** The RTSPS URL of a printer's chamber camera. Never logged, never put in a report. */
export function rtspUrl(host: string, accessCode: string): string {
  return `rtsps://bblp:${encodeURIComponent(accessCode)}@${host}:${BAMBU_RTSP_PORT}/streaming/live/1`
}

const startsJpeg = (buffer: Buffer, at: number): boolean =>
  buffer[at] === 0xff && buffer[at + 1] === 0xd8 && buffer[at + 2] === 0xff

/**
 * Cuts whole JPEGs out of ffmpeg's `image2pipe` output and hands back the tail to keep.
 *
 * Unlike the port-6000 protocol there is no length header here: frames are delimited by their own
 * markers, SOI (FFD8FF) to EOI (FFD9). Anything before the first SOI is dropped, which is also the
 * resynchronisation rule if ffmpeg ever writes something else down the pipe.
 */
export function splitJpegFrames(buffer: Buffer): { frames: Buffer[]; rest: Buffer } {
  const frames: Buffer[] = []
  let at = 0
  for (;;) {
    // Find the start of the next picture; everything skipped over is not one.
    while (at + 3 <= buffer.length && !startsJpeg(buffer, at)) at += 1
    if (at + 3 > buffer.length) break
    // FFD9 can appear inside the entropy-coded data of a *thumbnail*, but ffmpeg's mjpeg muxer
    // writes no thumbnail, so the first EOI after the SOI is this frame's end.
    let end = -1
    for (let i = at + 2; i + 1 < buffer.length; i += 1) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) { end = i + 2; break }
    }
    if (end < 0) break
    frames.push(Buffer.from(buffer.subarray(at, end)))
    at = end
  }
  return { frames, rest: buffer.subarray(at) }
}

export interface FfmpegProcessLike {
  onStdout(cb: (chunk: Buffer) => void): void
  /** Called once, whether ffmpeg exited, crashed, or could not be started at all. */
  onExit(cb: () => void): void
  kill(): void
}

export interface FfmpegSpawnOptions {
  /** The resolved binary. */
  command: string
  args: string[]
}
export type FfmpegSpawn = (opts: FfmpegSpawnOptions) => FfmpegProcessLike

/** Real child process. stderr is drained and dropped: it can quote the URL, credentials included. */
export const spawnFfmpeg: FfmpegSpawn = ({ command, args }) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr?.resume()
  let done = false
  return {
    onStdout: (cb) => { child.stdout?.on('data', cb) },
    onExit: (cb) => {
      const once = (): void => { if (done) return; done = true; cb() }
      child.on('error', once)
      child.on('close', once)
    },
    kill: () => { done = true; child.kill('SIGKILL') },
  }
}

/**
 * How the URL reaches ffmpeg.
 *
 * `list` writes it into a 0600 file in a private temp directory and feeds that to the concat
 * demuxer, so `ps` shows a path and not an access code. `argv` is the plain `-i <url>` form, which
 * every build understands but leaks the code to anyone who can list processes. The transport
 * starts on `list` and only drops to `argv` if that build cannot open a concat input, so the
 * trade-off is taken only where it buys a working preview.
 */
export type BambuRtspInputMode = 'list' | 'argv'

const FILTER = 'fps=1,scale=960:-2'

export function ffmpegArgs(mode: BambuRtspInputMode, input: string): string[] {
  const output = ['-an', '-vf', FILTER, '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-']
  if (mode === 'argv') return ['-loglevel', 'error', '-nostdin', '-rtsp_transport', 'tcp', '-i', input, ...output]
  return [
    '-loglevel', 'error', '-nostdin',
    '-protocol_whitelist', 'file,rtsp,rtsps,tcp,tls,udp,crypto,data',
    '-f', 'concat', '-safe', '0', '-i', input,
    ...output,
  ]
}

/** The one line the concat demuxer needs. Single quotes are the only character it escapes. */
export function concatListLine(url: string): string {
  return `file '${url.replace(/'/g, "'\\''")}'\n`
}

export interface BambuRtspCameraOptions {
  host: string
  accessCode: string
  spawnProcess?: FfmpegSpawn
  resolve?: () => string | null
  now?: () => number
  /** Overridden in tests so nothing is written to a real temp directory. */
  writeList?: (line: string) => { path: string; cleanup: () => void }
}

const defaultWriteList = (line: string): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), 'fremkit-cam-'))
  const path = join(dir, 'stream.txt')
  writeFileSync(path, line, { mode: 0o600 })
  return { path, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* gone already */ } } }
}

/**
 * Same public surface as the port-6000 camera: start, stop, the last frame and a state. The route
 * and the snapshot's `camera` flag therefore need no idea which printer they are looking at.
 */
export function createBambuRtspCamera(opts: BambuRtspCameraOptions): BambuCamera {
  const spawnProcess = opts.spawnProcess ?? spawnFfmpeg
  const resolve = opts.resolve ?? (() => resolveFfmpeg())
  const now = opts.now ?? Date.now
  const writeList = opts.writeList ?? defaultWriteList

  let child: FfmpegProcessLike | null = null
  let cleanup: (() => void) | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let backoff = RECONNECT_START_MS
  let running = false
  let state: BambuCameraState = 'idle'
  let errorCode: string | undefined
  let frame: BambuFrame | null = null
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let mode: BambuRtspInputMode = 'list'
  let modeSettled = false

  function armWatchdog(): void {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(() => { watchdog = null; stopChild() }, IDLE_TIMEOUT_MS)
    watchdog.unref?.()
  }

  function stopChild(): void {
    const current = child
    child = null
    if (watchdog) { clearTimeout(watchdog); watchdog = null }
    current?.kill()
    cleanup?.()
    cleanup = null
    if (running) { state = 'error'; schedule() } else { state = 'idle' }
  }

  function open(): void {
    if (!running) return
    const command = resolve()
    if (!command) {
      // Nothing to retry against: a missing binary will not appear on its own, and the widget has
      // a message of its own for it rather than a generic "unavailable".
      state = 'error'
      errorCode = FFMPEG_MISSING
      return
    }
    errorCode = undefined
    state = 'connecting'
    pending = Buffer.alloc(0)
    const url = rtspUrl(opts.host, opts.accessCode)
    let input = url
    if (mode === 'list') {
      try {
        const list = writeList(concatListLine(url))
        input = list.path
        cleanup = list.cleanup
      } catch {
        // No writable temp directory: the credential has to go through argv or there is no preview.
        mode = 'argv'
        modeSettled = true
      }
    }
    const startedAt = now()
    const current = spawnProcess({ command, args: ffmpegArgs(mode, input) })
    child = current
    armWatchdog()
    current.onStdout((chunk) => {
      if (child !== current) return
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      const parsed = splitJpegFrames(pending)
      pending = parsed.rest
      // A tail this long is not a partial frame; drop it rather than accumulate forever.
      if (pending.length > MAX_PENDING_BYTES) pending = Buffer.alloc(0)
      if (!parsed.frames.length) return
      frame = { jpeg: parsed.frames[parsed.frames.length - 1], at: now() }
      state = 'streaming'
      modeSettled = true
      backoff = RECONNECT_START_MS
      armWatchdog()
    })
    current.onExit(() => {
      if (child !== current) return
      // A build without the concat demuxer dies immediately and always: try the plain form once.
      if (!modeSettled && mode === 'list' && now() - startedAt < EARLY_EXIT_MS) {
        mode = 'argv'
        modeSettled = true
      }
      stopChild()
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
      stopChild()
      pending = Buffer.alloc(0)
      // The last frame goes too: a picture from before the camera was parked is not a preview.
      frame = null
      state = 'idle'
      errorCode = undefined
    },
    latest: () => frame,
    get state() { return state },
    get errorCode() { return errorCode },
  }
}
