import type { ConnectionProviderContext } from '../connections/types.js'
import type { Provider } from './types.js'
import { tr, type MessageKey } from '../i18n.js'
import { BAMBU_PORT, bambuClientId, connectMqtt, type MqttClientLike, type MqttConnect } from './mqtt.js'
import { bambuCameras, type BambuCameras } from '../bambu/cameras.js'

export interface BambuTray {
  slot: number
  /** The AMS this slot belongs to, as the printer numbers its units (0-based). */
  unit?: number
  color?: string
  type?: string
  remain?: number
  /** The slot the printer is currently drawing from, or about to. */
  active?: boolean
}
export interface BambuAmsUnit {
  /** The printer's own unit id, 0-based. `external` units keep the id the report gave them. */
  id: number
  humidity?: number
  temp?: number
  /** The spool holder on the back, not an AMS: one slot, no humidity, no drying. */
  external?: boolean
  trays: BambuTray[]
}
export interface BambuSnapshot {
  connected: boolean; model?: string
  state: 'idle' | 'running' | 'paused' | 'finished' | 'failed' | 'unknown'
  file?: string; percent?: number; remainingMin?: number; layer?: number; totalLayers?: number
  nozzleTemp?: number; nozzleTarget?: number; bedTemp?: number; bedTarget?: number
  speedLevel?: number; stage?: string; error?: string
  /** A chamber frame arrived in the last few seconds: the widget can show the preview. */
  camera?: boolean
  /** A reason the preview cannot work that the user can act on, e.g. `ffmpeg-missing`. */
  cameraError?: string
  /** Every AMS the printer reports, plus `trays` flattened across them in printer order. */
  ams?: { units: BambuAmsUnit[]; trays: BambuTray[] }
}

/** How recent a frame has to be for the widget to trust the preview rather than its placeholder. */
const CAMERA_FRESH_MS = 10_000

/**
 * Publish at most once a second, as the spec asks; the registry then deduplicates.
 *
 * Which is why the snapshot carries no timestamp: the printer is polled every second whether it
 * said anything or not, and a fresh `updatedAt` in each payload would make every one of them look
 * like a change and wake every subscriber for nothing.
 */
const PUBLISH_EVERY_MS = 1000
const BACKOFF_START_MS = 1000
const BACKOFF_MAX_MS = 60_000

/**
 * `stg_cur`, the printer's current stage. Only the values a user actually sees are named, and the
 * name is resolved at publish time so a language change reaches the widget on the next poll.
 */
const NAMED_STAGES = new Set([-1, 0, 1, 2, 4, 7, 8, 9, 12, 14])

export function stageName(stage: number): string | undefined {
  return NAMED_STAGES.has(stage) ? tr(undefined, `bambu.stage.${stage}` as MessageKey) : undefined
}

export function mapState(gcodeState: unknown): BambuSnapshot['state'] {
  switch (gcodeState) {
    case 'IDLE': return 'idle'
    case 'RUNNING': case 'PREPARE': case 'SLICING': return 'running'
    case 'PAUSE': return 'paused'
    case 'FINISH': return 'finished'
    case 'FAILED': return 'failed'
    default: return 'unknown'
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Folds one `print` report into the state kept for the printer.
 *
 * The printer sends deltas: after the initial `pushall` every message carries only what changed,
 * so a plain replace would blank the job every second. Objects merge key by key; arrays are
 * replaced wholesale, because the AMS sends its tray list complete each time it changes.
 */
export function mergePrint(state: Record<string, unknown>, delta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...state }
  for (const [key, value] of Object.entries(delta)) {
    const previous = out[key]
    out[key] = isPlainObject(value) && isPlainObject(previous) ? mergePrint(previous, value) : value
  }
  return out
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/**
 * The printer counts slots across the whole set, four per unit whatever the unit actually holds:
 * unit 1 slot 0 is 4, and a single-slot AMS HT still takes a block of four. `tray_now` and
 * `tray_tar` are those global numbers, which is how an active slot is recognised.
 */
const SLOTS_PER_UNIT = 4
/** `tray_now` while nothing is loaded, and the id the external spool reports. */
const EXTERNAL_TRAY_ID = 254

function toTray(raw: unknown, index: number, unit: number): BambuTray {
  const tray = (isPlainObject(raw) ? raw : {}) as Record<string, unknown>
  const slot = num(tray.id) ?? index
  const color = str(tray.tray_color)
  const remain = num(tray.remain)
  const result: BambuTray = { slot, unit }
  // An empty slot reports an empty colour, an empty type and remain -1: leave it blank. The
  // printer's value is six or eight hex digits (the last two are alpha, which we drop); anything
  // else is not a colour, and it would end up in a widget's style attribute.
  const rgb = /^([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color ?? '')
  if (rgb) result.color = `#${rgb[1]}`
  if (str(tray.tray_type)) result.type = str(tray.tray_type)
  if (remain !== undefined && remain >= 0) result.remain = remain
  return result
}

/**
 * Every AMS the printer reports, in its own order, plus the external spool as a unit of its own
 * when it holds something.
 *
 * `trays` stays the flat list it always was so anything reading it keeps working; what is new is
 * that it now spans every unit instead of stopping at the first.
 */
function amsUnits(print: Record<string, unknown>): { units: BambuAmsUnit[]; trays: BambuTray[] } | undefined {
  const ams = isPlainObject(print.ams) ? print.ams : undefined
  const raw = ams?.ams
  const active = num(ams?.tray_now)
  const units: BambuAmsUnit[] = []

  if (Array.isArray(raw)) {
    raw.forEach((entry, index) => {
      const unit = (isPlainObject(entry) ? entry : {}) as Record<string, unknown>
      const list = unit.tray
      if (!Array.isArray(list)) return
      const id = num(unit.id) ?? index
      const out: BambuAmsUnit = { id, trays: list.map((t, i) => toTray(t, i, id)) }
      const humidity = num(unit.humidity)
      const temp = num(unit.temp)
      if (humidity !== undefined) out.humidity = humidity
      if (temp !== undefined) out.temp = temp
      units.push(out)
    })
  }

  const vt = isPlainObject(ams?.vt_tray) ? ams.vt_tray : undefined
  if (vt) {
    const id = num(vt.id) ?? EXTERNAL_TRAY_ID
    const tray = toTray(vt, 0, id)
    // The holder is always reported, empty or not; only show it when a spool is actually on it.
    if (tray.color || tray.type) units.push({ id, external: true, trays: [{ ...tray, slot: 0 }] })
  }

  if (!units.length) return undefined
  for (const unit of units) {
    for (const tray of unit.trays) {
      const global = unit.external ? unit.id : unit.id * SLOTS_PER_UNIT + tray.slot
      if (active !== undefined && active === global) tray.active = true
    }
  }
  return { units, trays: units.flatMap((unit) => unit.trays) }
}

/** Turns the kept `print` state into the snapshot widgets consume. Unknown fields stay absent. */
export function toSnapshot(print: Record<string, unknown>, opts: { connected: boolean; model?: string; camera?: boolean; cameraError?: string }): BambuSnapshot {
  const snapshot: BambuSnapshot = { connected: opts.connected, state: mapState(print.gcode_state) }
  if (opts.model) snapshot.model = opts.model
  if (opts.camera !== undefined) snapshot.camera = opts.camera
  if (opts.cameraError) snapshot.cameraError = opts.cameraError
  const assign = <K extends keyof BambuSnapshot>(key: K, value: BambuSnapshot[K] | undefined): void => {
    if (value !== undefined) snapshot[key] = value
  }
  assign('file', str(print.subtask_name))
  assign('percent', num(print.mc_percent))
  assign('remainingMin', num(print.mc_remaining_time))
  assign('layer', num(print.layer_num))
  assign('totalLayers', num(print.total_layer_num))
  assign('nozzleTemp', num(print.nozzle_temper))
  assign('nozzleTarget', num(print.nozzle_target_temper))
  assign('bedTemp', num(print.bed_temper))
  assign('bedTarget', num(print.bed_target_temper))
  assign('speedLevel', num(print.spd_lvl))
  const stage = num(print.stg_cur)
  const named = stage === undefined ? undefined : stageName(stage)
  if (named) snapshot.stage = named
  const error = num(print.print_error)
  if (error) snapshot.error = String(error)
  const ams = amsUnits(print)
  if (ams) snapshot.ams = ams
  return snapshot
}

export interface BambuProviderDeps { connect?: MqttConnect; cameras?: BambuCameras }

/**
 * One provider per configured printer, on the channel `bambu:<id>`.
 *
 * MQTT is push, the registry is pull: the provider keeps the merged state and `poll` just reads
 * it, so the registry's deduplication turns "the printer said something" into "publish only when
 * the snapshot actually changed". The socket is only open while a widget is subscribed.
 */
export function createBambuProvider(ctx: ConnectionProviderContext, deps: BambuProviderDeps = {}): Provider {
  const connect = deps.connect ?? connectMqtt
  const cameras = deps.cameras ?? bambuCameras

  // Declaring the camera here, not in `start`, is what lets the snapshot route answer 404 for an
  // id that is not a configured printer while a widget is still only being placed on a page.
  cameras.configure(ctx.id, {
    host: ctx.fields.host ?? '',
    accessCode: ctx.secrets.accessCode ?? '',
    // The model is what picks the camera protocol: X1/H2 stream RTSPS, the rest JPEG on port 6000.
    model: ctx.fields.model,
  })

  const serial = ctx.fields.serial ?? ''
  const reportTopic = `device/${serial}/report`
  const requestTopic = `device/${serial}/request`

  let client: MqttClientLike | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let backoff = BACKOFF_START_MS
  let running = false
  let connected = false
  let print: Record<string, unknown> = {}

  function open(): void {
    if (!running) return
    connected = false
    const current = connect({
      host: ctx.fields.host ?? '',
      port: BAMBU_PORT,
      username: 'bblp',
      password: ctx.secrets.accessCode ?? '',
      clientId: bambuClientId(),
    })
    client = current
    current.onConnect(() => {
      connected = true
      backoff = BACKOFF_START_MS
      current.subscribe(reportTopic)
      // Deltas only make sense on top of a full state, so ask for one straight away.
      current.publish(requestTopic, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }))
    })
    current.onMessage((message) => {
      if (message.topic !== reportTopic) return
      let body: unknown
      try { body = JSON.parse(message.payload) } catch { return }
      const report = (body as { print?: unknown })?.print
      if (!isPlainObject(report)) return
      print = mergePrint(print, report)
    })
    current.onClose(() => {
      connected = false
      if (client === current) client = null
      current.end()
      schedule()
    })
  }

  function schedule(): void {
    if (!running || retry) return
    const delay = backoff
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    retry = setTimeout(() => { retry = null; open() }, delay)
  }

  return {
    channel: ctx.channel,
    intervalMs: PUBLISH_EVERY_MS,

    start(): void {
      if (running) return
      running = true
      backoff = BACKOFF_START_MS
      open()
    },

    stop(): void {
      running = false
      if (retry) { clearTimeout(retry); retry = null }
      client?.end()
      client = null
      connected = false
    },

    async poll(): Promise<BambuSnapshot> {
      // A read of the last frame's timestamp, nothing more: polling must not dial the camera.
      return toSnapshot(print, {
        connected,
        model: ctx.fields.model,
        camera: cameras.fresh(ctx.id, CAMERA_FRESH_MS),
        cameraError: cameras.errorCode(ctx.id),
      })
    },
  }
}
