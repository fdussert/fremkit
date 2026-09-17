import {
  createBambuCamera,
  type BambuCamera,
  type BambuCameraState,
  type BambuFrame,
  type BambuTlsConnect,
} from '../providers/bambu-camera.js'
import { createBambuRtspCamera, type FfmpegSpawn } from '../providers/bambu-rtsp.js'

/** No request for this long and the socket is dropped; the next request opens it again. */
export const CAMERA_IDLE_MS = 60_000

export interface BambuCameraRegistryDeps {
  connectTls?: BambuTlsConnect
  spawnProcess?: FfmpegSpawn
  resolveFfmpeg?: () => string | null
  now?: () => number
}

/**
 * Which of the two chamber-camera protocols a model speaks.
 *
 * X1 and H2 serve RTSPS on 322 and nothing on 6000; everything else (P1, A1, and an unset or
 * unknown model) gets the port-6000 transport, which is what the printers that predate the split
 * speak and what an unrecognised model is most likely to be.
 */
export function cameraTransport(model?: string): 'rtsp' | 'tls' {
  const normalised = (model ?? '').trim().toUpperCase()
  return normalised.startsWith('X1') || normalised.startsWith('H2') ? 'rtsp' : 'tls'
}

interface Entry {
  host: string
  accessCode: string
  model?: string
  camera: BambuCamera
  idle: ReturnType<typeof setTimeout> | null
}

/**
 * The cameras of the configured Bambu connections, one entry per connection id.
 *
 * Connections are declared here as they are configured — that is what makes an unknown id a 404 —
 * but a socket is only opened when something actually asks for a picture, and closed again a
 * minute after the last request. So a dashboard with the camera switched off never dials the
 * printer, and a tile that is on keeps the stream alive simply by refreshing.
 */
export class BambuCameras {
  private entries = new Map<string, Entry>()

  constructor(private readonly deps: BambuCameraRegistryDeps = {}) {}

  /**
   * Declares (or re-declares) a printer. Called when a connection's provider is built, so a host
   * or access code that changed replaces the running camera rather than streaming from the old one.
   */
  configure(id: string, opts: { host: string; accessCode: string; model?: string }): void {
    const existing = this.entries.get(id)
    if (existing && existing.host === opts.host && existing.accessCode === opts.accessCode
      && cameraTransport(existing.model) === cameraTransport(opts.model)) return
    if (existing) this.drop(id)
    const common = { host: opts.host, accessCode: opts.accessCode, now: this.deps.now }
    this.entries.set(id, {
      ...opts,
      camera: cameraTransport(opts.model) === 'rtsp'
        ? createBambuRtspCamera({ ...common, spawnProcess: this.deps.spawnProcess, resolve: this.deps.resolveFfmpeg })
        : createBambuCamera({ ...common, connectTls: this.deps.connectTls }),
      idle: null,
    })
  }

  /** True for a connection id this registry knows: any other id has no camera to serve. */
  has(id: string): boolean { return this.entries.has(id) }

  state(id: string): BambuCameraState {
    return this.entries.get(id)?.camera.state ?? 'idle'
  }

  /** The actionable failure, if any: see `BambuCamera.errorCode`. */
  errorCode(id: string): string | undefined {
    return this.entries.get(id)?.camera.errorCode
  }

  /**
   * The current picture, starting the stream if it is not running and pushing back the idle stop.
   * Returns null until the first frame lands, a second or two after the first call.
   */
  snapshot(id: string): BambuFrame | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    entry.camera.start()
    if (entry.idle) clearTimeout(entry.idle)
    entry.idle = setTimeout(() => { entry.idle = null; entry.camera.stop() }, CAMERA_IDLE_MS)
    entry.idle.unref?.()
    return entry.camera.latest()
  }

  /**
   * Whether a frame landed in the last `withinMs`. Read by the provider's poll, so it must not
   * start anything: a widget with the camera off asks for this every second.
   */
  fresh(id: string, withinMs: number): boolean {
    const frame = this.entries.get(id)?.camera.latest()
    if (!frame) return false
    return (this.deps.now ?? Date.now)() - frame.at <= withinMs
  }

  /** Stops and forgets one camera. */
  drop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.idle) clearTimeout(entry.idle)
    entry.camera.stop()
    this.entries.delete(id)
  }

  /** Forgets every camera whose connection is gone, after a config change. */
  retain(ids: Set<string>): void {
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.drop(id)
  }

  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.drop(id)
  }
}

/**
 * The instance the Bambu provider declares its printer on.
 *
 * A module-level singleton because a connection type builds its provider from a context that
 * carries no server-wide dependency; tests that need isolation pass their own registry to
 * `createBambuProvider` and to the routes.
 */
export const bambuCameras = new BambuCameras()
